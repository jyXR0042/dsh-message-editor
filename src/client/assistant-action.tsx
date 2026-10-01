/**
 * The assistant edit control, contributed to the host's own per-message action
 * strip (`conversation.chat.assistant-actions`).
 *
 * This is the sanctioned placement: the strip already renders copy, branch and
 * the feedback pair between them, so the pencil inherits that row's geometry and
 * hover behaviour exactly — the same affordance the reference chat client puts
 * beside a message, drawn in the host's own chrome.
 *
 * The strip's owner hands over a `messageId` and nothing else. Resolving that to
 * a surface node is the host's job, so this component reads no conversation
 * snapshot at all: it opens the editor through `beginForMessage` and matches the
 * edited state by id.
 *
 * @module dsh-message-editor/client/assistant-action
 */

import { createElement as h, useCallback } from 'react'
import { IconEdit, IconRevert } from './icons.tsx'
import type { EditRecord, EditorView } from './controller.ts'

/** The injected face available at the assistant action strip. */
export interface ActionInjected {
  useEditor?: <S>(selector: (view: EditorView) => S) => S
  controller?: {
    beginForMessage: (messageId: string) => Promise<unknown>
    revert: (originSeq: number) => Promise<unknown>
  }
  fallbackT: (key: string) => string
}

/** Props the strip's owner shares, plus the injected face. */
export interface ActionProps extends ActionInjected {
  messageId?: string
  t?: (key: string, params?: Record<string, unknown>) => string
}

/** Selector default so the hook order never depends on wiring. */
const NO_EDITOR = <S,>(_selector: (view: EditorView) => S): S | undefined => undefined

/** The committed edit of one message id, if any. */
function editOf(view: EditorView, messageId: string | undefined): EditRecord | undefined {
  if (messageId === undefined) return undefined
  for (const record of view.edits.values()) {
    if (record.messageId === messageId) return record
  }
  return undefined
}

/**
 * Render the assistant strip's edit affordance.
 * @param props - the addressed message and the injected face.
 * @returns the pencil, plus a revert control and badge once the message is edited.
 */
export function AssistantEditAction(props: ActionProps) {
  const t = typeof props.t === 'function' ? props.t : (key: string) => props.fallbackT(key)
  const controller = props.controller
  const messageId = props.messageId

  const select = props.useEditor ?? NO_EDITOR
  // The selector returns an existing record (or undefined), never a fresh value,
  // so it stays uSES-safe across unrelated renders.
  const edit = select((view) => editOf(view, messageId))
  const pending = select((view) => view.pending) === true

  const onEdit = useCallback(() => {
    if (messageId === undefined || controller === undefined) return
    void controller.beginForMessage(messageId)
  }, [controller, messageId])

  // The strip renders for one finalized message; without an addressable id there
  // is nothing to edit, and rendering nothing keeps the row unchanged.
  if (messageId === undefined || messageId === '' || controller === undefined) return null

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
      onClick: () => { void controller.revert(edit.originSeq) },
    }, h(IconRevert)),
    edit !== undefined && h('span', { className: 'dme-badge' },
      h('span', { className: 'dme-badge-dot', 'aria-hidden': true }),
      t(edit.deferred ? 'badge.deferred' : 'badge.edited')))
}
