/**
 * The shadowed `user` / `steering` transcript renderer.
 *
 * The host's `conversation.chat.node` cell is keyed, so a second registration
 * takes the cell. This renderer therefore owns the whole bubble — which is the
 * point: the shipped user view exposes no seat for a per-message action, so the
 * only way to put an edit affordance on a user message is to draw the row.
 *
 * Fidelity rules kept from the shipped view: right-aligned stack capped at
 * `min(525px, 82%)`, a 22px-radius bubble on the specific-bubble token, plain
 * text with `white-space: pre-wrap`, `/command` and `@reference` tokens
 * decorated as chips, images tiled above the bubble, and the 28px IconActions
 * row with the clock on the leading side.
 *
 * @module dsh-message-editor/client/user-node
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import { IconCheck, IconCopy, IconEdit, IconRevert } from './icons.tsx'
import { InlineEditor } from './editor.tsx'
import {
  MessageImage, attachmentChips, contentParts, formatClock, jsonPreview, writeClipboard,
} from './media.tsx'
import type { EditorView } from './controller.ts'

/** The plugin's injected face at a `conversation.chat.node` seat. */
export interface NodeInjected {
  useEditor?: <S>(selector: (view: EditorView) => S) => S
  controller?: {
    ensure: () => void
    begin: (input: {
      originSeq: number
      kind: 'user' | 'assistant'
      text: string
      attachments: readonly { id: string; name: string }[]
    }) => void
    cancel: () => void
    setText: (text: string) => void
    toggleAttachment: (id: string) => void
    save: () => void
    saveAndRegenerate: () => void
    revert: (originSeq: number) => void
  }
  /** The host's own `conversation` translate, used when delegating a renderer. */
  conversationT?: (key: string, params?: Record<string, unknown>) => string
  /** Local dictionary fallback for compositions without the locale face. */
  fallbackT: (key: string) => string
}

/** Anything a slot component may receive; only the fields used here are named. */
export interface NodeProps extends NodeInjected {
  node?: { key?: string; anchorSeq?: number; data?: Record<string, unknown> }
  loadImage?: (attachment: { attachmentId: string }) => Promise<string>
  t?: (key: string, params?: Record<string, unknown>) => string
  sessionId?: string
}

/** Selector hook default so the component's hook order never depends on wiring. */
const NO_EDITOR = <S,>(_selector: (view: EditorView) => S): S | undefined => undefined

/** Resolve the translate seat, preferring the framework's over the local table. */
function translateOf(props: NodeProps): (key: string, params?: Record<string, unknown>) => string {
  return typeof props.t === 'function' ? props.t : (key: string) => props.fallbackT(key)
}

/** The append-origin seq a user node is keyed by. */
function userOriginSeq(node: NodeProps['node']): number | undefined {
  const seq = node?.data?.['seq']
  if (typeof seq === 'number') return seq
  return typeof node?.anchorSeq === 'number' ? node.anchorSeq : undefined
}

/** Decorate plain `/command` and `@reference` tokens the way the shipped bubble does. */
function projectUserText(text: string): React.ReactNode[] {
  const pattern = /(^|\s)([/@][\w-]+)(?=\s|$)/g
  const parts: React.ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const tokenStart = match.index + (match[1]?.length ?? 0)
    const label = match[2] ?? ''
    if (tokenStart > cursor) parts.push(h('span', { key: `t${cursor}` }, text.slice(cursor, tokenStart)))
    parts.push(h('span', { key: `c${tokenStart}`, className: 'dme-ref' }, label))
    cursor = tokenStart + label.length
  }
  if (cursor < text.length) parts.push(h('span', { key: `t${cursor}` }, text.slice(cursor)))
  return parts
}

/**
 * Render one user or steering message, with its edit affordance.
 * @param props - the node, the session's image loader, and the injected face.
 * @returns the bubble row plus the IconActions strip.
 */
export function EditedUserMessageView(props: NodeProps) {
  const t = translateOf(props)
  const controller = props.controller
  const useEditor = props.useEditor ?? NO_EDITOR
  const node = props.node
  const data = node?.data ?? {}
  const content = data['content']
  const originSeq = userOriginSeq(node)

  const edit = useEditor((view: EditorView) => (
    originSeq === undefined ? undefined : view.edits.get(originSeq)
  ))
  const editing = useEditor((view: EditorView) => (
    view.editing !== null && view.editing.originSeq === originSeq ? view.editing : null
  )) ?? null
  const pending = useEditor((view: EditorView) => view.pending) === true
  const error = useEditor((view: EditorView) => view.error) ?? null
  // A regenerate replaces the edited question together with the answers that
  // followed it, so those answers leave the transcript too.
  const hidden = useEditor((view: EditorView) => (
    originSeq === undefined ? false : view.hidden.has(originSeq)
  )) === true

  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])

  // The edited content is a pure function of the node's own blocks plus the
  // committed record; when no record exists the node renders verbatim.
  const effective = edit === undefined
    ? content
    : (() => {
      const drop = new Set(edit.removed)
      const kept = (Array.isArray(content) ? content : []).filter((block) => {
        const typed = block as { type?: string; attachment?: { attachmentId?: string } }
        if (typed?.type !== 'image' && typed?.type !== 'file') return true
        return !drop.has(typed.attachment?.attachmentId ?? '')
      })
      let written = false
      const out: unknown[] = []
      for (const block of kept) {
        const typed = block as { type?: string }
        if (typed?.type === 'text') {
          if (written) continue
          written = true
          out.push({ ...(block as object), type: 'text', text: edit.text })
          continue
        }
        out.push(block)
      }
      if (!written) out.unshift({ type: 'text', text: edit.text })
      return out
    })()

  const { text, images, rest } = contentParts(effective)

  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return
    copyPending.current = true
    void writeClipboard(text).then((accepted) => {
      copyPending.current = false
      if (!accepted) return
      setCopied(true)
      copyTimer.current = setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])

  const onEdit = useCallback(() => {
    if (originSeq === undefined || controller === undefined) return
    const chips = attachmentChips(content)
    controller.begin({
      originSeq,
      kind: data['kind'] === 'steering' ? 'user' : 'user',
      text: text,
      attachments: chips,
    })
  }, [controller, content, data, originSeq, text])

  const clock = formatClock(data['time'])
  const badgeKey = edit?.deferred === true ? 'badge.deferred' : 'badge.edited'

  const actionStrip = h('div', { className: 'dme-actions' },
    clock !== null && h('span', { className: 'dme-time' }, clock),
    h('button', {
      type: 'button',
      className: 'dme-action',
      'aria-label': copied ? t('action.copied') : t('action.copy'),
      title: copied ? t('action.copied') : t('action.copy'),
      onClick: onCopy,
    }, copied ? h(IconCheck) : h(IconCopy)),
    originSeq !== undefined && h('button', {
      type: 'button',
      className: 'dme-action',
      'data-message-editor': 'edit',
      'data-active': edit !== undefined || undefined,
      'aria-label': t('action.edit'),
      title: t('action.edit'),
      onClick: onEdit,
    }, h(IconEdit)),
    edit !== undefined && controller !== undefined && h('button', {
      type: 'button',
      className: 'dme-action',
      'aria-label': t('action.revert'),
      title: t('action.revert'),
      disabled: pending,
      onClick: () => { controller.revert((edit as { originSeq: number }).originSeq) },
    }, h(IconRevert)),
    edit !== undefined && h('span', { className: 'dme-badge' },
      h('span', { className: 'dme-badge-dot', 'aria-hidden': true }),
      t(badgeKey)))

  // Drawn after every hook has run, so the hook order is unconditional.
  if (hidden) return null

  return h('div', { className: 'dme-user-row', 'data-time-hover-root': true },
    h('div', { className: 'dme-user-stack' },
      images.length > 0 && h('div', { className: 'dme-images' },
        ...images.map((image, index) => h(MessageImage, {
          key: image.attachmentId ?? index,
          attachment: image,
          loadImage: props.loadImage,
        }))),
      editing !== null && controller !== undefined
        ? h(InlineEditor, {
          editing,
          t,
          pending,
          error,
          onText: controller.setText,
          onToggleAttachment: controller.toggleAttachment,
          onSave: controller.save,
          onCancel: controller.cancel,
          onSaveRegenerate: controller.saveAndRegenerate,
        })
        : (text !== '' || rest.length > 0) && h('div', { className: 'dme-bubble' },
          h('div', { className: 'dme-text' }, ...projectUserText(text)),
          ...rest.map((block, index) => h('pre', { key: index, className: 'dme-extra' }, jsonPreview(block))))),
    actionStrip)
}
