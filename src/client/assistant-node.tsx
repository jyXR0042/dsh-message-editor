/**
 * The shadowed `assistant-step` transcript renderer.
 *
 * Assistant bodies are markdown with reasoning rows, code blocks and image
 * galleries — re-implementing that would be both large and permanently behind
 * the shipped renderer. The cell is keyed, so this entry takes the cell and
 * then *delegates*: it renders the shipped component with a patched node whose
 * text blocks carry the edited string. When no edit exists the node is passed
 * through untouched, so the transcript is byte-for-byte the stock UI.
 *
 * The shipped component is read from the live registration ledger through the
 * documented `entries()` inspection surface, captured before this plugin
 * registers its own occupant. When it cannot be resolved the entry falls back
 * to a small self-contained body rather than painting nothing.
 *
 * @module dsh-message-editor/client/assistant-node
 */

import { Component, createElement as h, Fragment } from 'react'
import type { ReactNode } from 'react'
import { InlineEditor } from './editor.tsx'
import { MessageImage, formatClock, jsonPreview } from './media.tsx'
import type { EditorView } from './controller.ts'
import type { NodeProps } from './user-node.tsx'

/** Selector default so the hook order never depends on wiring. */
const NO_EDITOR = <S,>(_selector: (view: EditorView) => S): S | undefined => undefined

/**
 * Contains a failure inside the shipped renderer this entry delegates to.
 *
 * A slot entry that throws is retired from its cell, which would silently
 * downgrade the whole transcript to the shipped view. Catching here instead
 * keeps this entry — and its edit affordance — alive, and falls back to the
 * self-contained body for the one node that failed.
 */
class DelegateBoundary extends Component<{ fallback: ReactNode; children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error('[dsh-message-editor] the shipped assistant renderer failed; using the built-in fallback:', error)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Blocks of an assistant step, as the runtime projects them. */
interface AssistantBlock {
  kind?: string
  text?: string
  attachment?: { attachmentId: string; name?: string }
  block?: unknown
}

/**
 * The append-origin seq of an assistant step.
 *
 * `anchorSeq` is the field every chat node carries, and a settled assistant step
 * anchors on its own `assistant/message` event — the coordinate the host keys an
 * edit by. `finalNode.seq` carries the same value once the step is finalized, so
 * it serves only as a fallback for a node projected an older way.
 */
export function assistantOriginSeq(node: NodeProps['node']): number | undefined {
  if (typeof node?.anchorSeq === 'number') return node.anchorSeq
  const finalNode = node?.data?.['finalNode'] as { seq?: number } | undefined
  if (typeof finalNode?.seq === 'number') return finalNode.seq
  return typeof node?.anchorSeq === 'number' ? node.anchorSeq : undefined
}

/** Collapse an assistant step's text blocks into one, leaving every other block in order. */
function collapseAssistantText(blocks: readonly AssistantBlock[], text: string): AssistantBlock[] {
  const out: AssistantBlock[] = []
  let written = false
  for (const block of blocks) {
    if (block?.kind === 'text') {
      if (written) continue
      written = true
      out.push({ ...block, text })
      continue
    }
    out.push(block)
  }
  if (!written) out.unshift({ kind: 'text', text })
  return out
}

/** Build the node the shipped renderer should see for one committed edit. */
function withEditedText(
  node: NonNullable<NodeProps['node']>,
  text: string,
): NonNullable<NodeProps['node']> {
  const data = node.data ?? {}
  const blocks = Array.isArray(data['blocks']) ? (data['blocks'] as AssistantBlock[]) : []
  const finalNode = data['finalNode'] as { blocks?: AssistantBlock[] } | undefined
  const nextData: Record<string, unknown> = { ...data, blocks: collapseAssistantText(blocks, text) }
  if (finalNode !== undefined && Array.isArray(finalNode.blocks)) {
    nextData['finalNode'] = { ...finalNode, blocks: collapseAssistantText(finalNode.blocks, text) }
  }
  return { ...node, data: nextData }
}

/** The self-contained body used when the shipped renderer cannot be resolved. */
function FallbackBody({ blocks, t }: { blocks: readonly AssistantBlock[]; t: (key: string) => string }) {
  // ReactNode children of a mixed provenance (elements, text, null) — the array
  // is only ever spread into createElement.
  const parts: React.ReactNode[] = []
  blocks.forEach((block, index) => {
    if (block?.kind === 'text') {
      parts.push(h('div', { key: `t${index}`, className: 'dme-text' }, block.text ?? ''))
      return
    }
    if (block?.kind === 'reasoning') {
      parts.push(h('div', { key: `r${index}`, className: 'dme-reasoning' },
        h('div', { className: 'dme-hint' }, t('reasoning.label')),
        block.text ?? ''))
      return
    }
    if (block?.kind === 'image' && block.attachment !== undefined) {
      parts.push(h(MessageImage, { key: `i${index}`, attachment: block.attachment }))
      return
    }
    if (block?.kind === 'tool-call') return
    parts.push(h('pre', { key: `o${index}`, className: 'dme-extra' }, jsonPreview(block?.block ?? block)))
  })
  return h('div', { className: 'dme-assistant' }, ...parts)
}

/** Injected face additions used only by this renderer. */
export interface AssistantNodeInjected {
  /** The shipped `assistant-step` renderer, captured from the ledger. */
  builtinNode?: unknown
}

/**
 * Render one assistant step: the inline editor while editing, otherwise the
 * shipped markdown renderer with the edited text substituted.
 *
 * When the shipped renderer cannot be resolved — or throws — the entry falls
 * back to a self-contained body rather than painting nothing, and keeps its
 * edit affordance either way.
 * @param props - the node, the session image loader, the captured renderer and
 * the injected face.
 * @returns the step body.
 */
export function EditedAssistantStepView(props: NodeProps & AssistantNodeInjected) {
  const t = typeof props.t === 'function' ? props.t : (key: string) => props.fallbackT(key)
  const controller = props.controller
  const useEditor = props.useEditor
  const node = props.node
  const originSeq = assistantOriginSeq(node)

  const select = useEditor ?? NO_EDITOR
  const edit = select((view) => (originSeq === undefined ? undefined : view.edits.get(originSeq)))
  const editing = select((view) => (view.editing !== null && view.editing.originSeq === originSeq ? view.editing : null)) ?? null
  const pending = select((view) => view.pending) === true
  const error = select((view) => view.error) ?? null
  // A regenerate replaced this reply together with the question it answered, so
  // the transcript drops it rather than showing an answer the model cannot see.
  const hidden = select((view) => (originSeq === undefined ? false : view.hidden.has(originSeq))) === true

  if (hidden) return null

  const data = node?.data ?? {}
  const blocks = Array.isArray(data['blocks']) ? (data['blocks'] as AssistantBlock[]) : []
  const effective = edit === undefined ? blocks : collapseAssistantText(blocks, edit.text)

  if (editing !== null && controller !== undefined) {
    return h('div', { className: 'dme-assistant' }, h(InlineEditor, {
      editing,
      t,
      pending,
      error,
      onText: controller.setText,
      onToggleAttachment: controller.toggleAttachment,
      onSave: controller.save,
      onCancel: controller.cancel,
    }))
  }

  const builtin = props.builtinNode
  if (builtin !== undefined && builtin !== null && node !== undefined) {
    const target = edit === undefined ? node : withEditedText(node, edit.text)
    // `t` is replaced with the host's own `conversation` dictionary: the shipped
    // renderer resolves its labels from that namespace, not from this plugin's.
    const conversationT = props.conversationT
    const delegated = conversationT === undefined
      ? { ...props, node: target }
      : { ...props, node: target, t: conversationT }
    return h(DelegateBoundary, { fallback: h(FallbackBody, { blocks: effective, t }) },
      h(builtin as never, delegated))
  }

  const clock = formatClock(data['time'])
  return h(Fragment, null,
    h(FallbackBody, { blocks: effective, t }),
    clock !== null && h('div', { className: 'dme-actions' }, h('span', { className: 'dme-time' }, clock)))
}
