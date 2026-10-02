/**
 * The assistant "answer again" control, contributed to the host's own
 * per-message action strip (`conversation.chat.assistant-actions`).
 *
 * This is the sanctioned placement: the strip already renders copy, branch and
 * the feedback pair between them, so the button inherits that row's geometry and
 * hover behaviour exactly — the same affordance the reference chat client puts
 * beside a message, drawn in the host's own chrome.
 *
 * It used to be a pencil, and that was a lie. A model message cannot be rewritten
 * on this session format: every surface replacement must cite the nodes it
 * shadows in `sourceEventSeqs`, and `assistant/message` refuses to carry that
 * field because it embeds its own source stream. The two rules together leave no
 * legal spelling, so a saved "edit" could never reach the model — it was staged,
 * reported as applied, and retried forever. What a reader actually wants from
 * that control is for the reply to be said differently, and that IS reachable:
 * the host retargets the request onto the message that opened the turn and
 * replaces the whole reply run, which is the same operation the user-message
 * editor's "Save & regenerate" already performs.
 *
 * The strip's owner hands over a `messageId` and nothing else. Resolving that to
 * a surface node is the host's job, so this component reads no conversation
 * snapshot at all.
 *
 * @module dsh-message-editor/client/assistant-action
 */

import { createElement as h, useCallback } from 'react'
import { IconRegenerate } from './icons.tsx'
import type { EditorView } from './controller.ts'

/** The injected face available at the assistant action strip. */
export interface ActionInjected {
  useEditor?: <S>(selector: (view: EditorView) => S) => S
  controller?: {
    regenerateTurn: (messageId: string) => Promise<unknown>
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

/**
 * Render the assistant strip's regenerate affordance.
 * @param props - the addressed message and the injected face.
 * @returns the regenerate button, or nothing when there is no addressable message.
 */
export function AssistantRegenerateAction(props: ActionProps) {
  const t = typeof props.t === 'function' ? props.t : (key: string) => props.fallbackT(key)
  const controller = props.controller
  const messageId = props.messageId

  const select = props.useEditor ?? NO_EDITOR
  const pending = select((view) => view.pending) === true

  const onRegenerate = useCallback(() => {
    if (messageId === undefined || controller === undefined) return
    void controller.regenerateTurn(messageId)
  }, [controller, messageId])

  // The strip renders for one finalized message; without an addressable id there
  // is nothing to redo, and rendering nothing keeps the row unchanged.
  if (messageId === undefined || messageId === '' || controller === undefined) return null

  return h('div', { className: 'dme-actions' },
    h('button', {
      type: 'button',
      className: 'dme-action',
      'data-message-editor': 'regenerate',
      'aria-label': t('action.regenerate'),
      title: t('action.regenerateHint'),
      disabled: pending,
      onClick: onRegenerate,
    }, h(IconRegenerate)))
}
