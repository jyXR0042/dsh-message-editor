/**
 * The assistant edit control, contributed to the host's own per-message action
 * strip (`conversation.chat.assistant-actions`).
 *
 * This is the sanctioned placement: the strip already renders copy, branch and
 * the feedback pair between them, so the pencil inherits that row's geometry
 * and hover behaviour exactly — the same affordance the reference chat client
 * puts beside a message, drawn in the host's own chrome.
 *
 * The strip's owner hands over a `messageId`; the transcript node that owns the
 * message is resolved from the live conversation snapshot, because the edit is
 * keyed by the message's append-origin surface seq.
 *
 * @module dsh-message-editor/client/assistant-action
 */

import { createElement as h, useCallback, useMemo } from 'react'
import { IconEdit, IconRevert } from './icons.tsx'
import { assistantOriginSeq } from './assistant-node.tsx'
import type { EditorView } from './controller.ts'

/** The injected face available at the assistant action strip. */
export interface ActionInjected {
  useEditor?: <S>(selector: (view: EditorView) => S) => S
  controller?: {
    begin: (input: {
      originSeq: number
      kind: 'user' | 'assistant'
      text: string
      attachments: readonly { id: string; name: string }[]
    }) => void
    revert: (originSeq: number) => void
  }
  fallbackT: (key: string) => string
}

/** Props the strip's owner shares, plus the injected face and the session kit. */
export interface ActionProps extends ActionInjected {
  messageId?: string
  t?: (key: string, params?: Record<string, unknown>) => string
  useSession?: <S>(selector: (snapshot: unknown) => S) => S
}

/** Selector default so the hook order never depends on wiring. */
const NO_EDITOR = <S,>(_selector: (view: EditorView) => S): S | undefined => undefined

/** Snapshot default: no session kit means no addressable message. */
const NO_SESSION = <S,>(_selector: (snapshot: unknown) => S): S | undefined => undefined

/** One resolved assistant step: its append-origin seq and visible plain text. */
interface ResolvedStep {
  originSeq: number
  text: string
}

/** Resolve `messageId` to the assistant step that owns it. */
function findAssistantStep(snapshot: unknown, messageId: string | undefined): ResolvedStep | undefined {
  if (messageId === undefined || snapshot === undefined || snapshot === null) return undefined
  const chat = (snapshot as { chat?: { order?: readonly string[]; nodes?: { get?: (key: string) => unknown } } })?.chat
  const order = chat?.order
  const nodes = chat?.nodes
  if (!Array.isArray(order) || typeof nodes?.get !== 'function') return undefined
  for (const key of order) {
    const node = nodes.get(key) as { kind?: string; anchorSeq?: number; data?: Record<string, unknown> } | undefined
    if (node?.kind !== 'assistant-step') continue
    const finalNode = node.data?.['finalNode'] as { messageId?: string } | undefined
    if (finalNode?.messageId !== messageId) continue
    const originSeq = assistantOriginSeq(node)
    if (originSeq === undefined) continue
    const blocks = Array.isArray(node.data?.['blocks']) ? (node.data?.['blocks'] as readonly unknown[]) : []
    let text = ''
    for (const block of blocks) {
      const typed = block as { kind?: string; text?: string }
      if (typed?.kind === 'text' && typeof typed.text === 'string') text += typed.text
    }
    return { originSeq, text }
  }
  return undefined
}

/**
 * Render the assistant strip's edit affordance.
 * @param props - the addressed message, the session snapshot hook, and the
 * injected face.
 * @returns the pencil, plus a revert control and badge once the message is edited.
 */
export function AssistantEditAction(props: ActionProps) {
  const t = typeof props.t === 'function' ? props.t : (key: string) => props.fallbackT(key)
  const selectSession = props.useSession ?? NO_SESSION
  const selectEdit = props.useEditor ?? NO_EDITOR
  const controller = props.controller
  const messageId = props.messageId

  // The snapshot reference is stable between conversation changes, so this
  // selector re-renders the strip only when the transcript actually moved.
  const snapshot = selectSession((value: unknown) => value)
  const step = useMemo(() => findAssistantStep(snapshot, messageId), [snapshot, messageId])
  const originSeq = step?.originSeq

  const edit = selectEdit((view) => (originSeq === undefined ? undefined : view.edits.get(originSeq)))
  const pending = selectEdit((view) => view.pending) === true

  const onEdit = useCallback(() => {
    if (step === undefined || controller === undefined) return
    controller.begin({
      originSeq: step.originSeq,
      kind: 'assistant',
      text: step.text,
      attachments: [],
    })
  }, [controller, step])

  if (originSeq === undefined || controller === undefined) return null

  return h('div', { className: 'dme-actions' },
    h('button', {
      type: 'button',
      className: 'dme-action',
      'data-message-editor': 'edit',
      'data-active': edit !== undefined || undefined,
      'aria-label': t('action.edit'),
      title: t('action.edit'),
      onClick: onEdit,
    }, h(IconEdit)),
    edit !== undefined && h('button', {
      type: 'button',
      className: 'dme-action',
      'aria-label': t('action.revert'),
      title: t('action.revert'),
      disabled: pending,
      onClick: () => { controller.revert(originSeq) },
    }, h(IconRevert)),
    edit !== undefined && h('span', { className: 'dme-badge' },
      h('span', { className: 'dme-badge-dot', 'aria-hidden': true }),
      t(edit.deferred ? 'badge.deferred' : 'badge.edited')))
}
