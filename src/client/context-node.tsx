/**
 * The shadowed `context` transcript renderer.
 *
 * The chat surface draws any `user/message` whose source is not `user` as an
 * injected context row. That is exactly what a regenerate trigger looks like —
 * it enters the log to drive one more turn, and it is not something the reader
 * wrote — so this entry hides its own trigger and delegates every other context
 * row (system reminders, session references, injected notes) to the shipped
 * renderer unchanged.
 *
 * @module dsh-message-editor/client/context-node
 */

import { createElement as h } from 'react'
import type { NodeProps } from './user-node.tsx'

/** Injected face additions used only by this renderer. */
export interface ContextNodeInjected {
  /** This plugin's own package name, for recognizing its trigger rows. */
  pluginId?: string
  /** The shipped `context` renderer, captured from the ledger. */
  builtinNode?: unknown
}

/**
 * Render one injected context row.
 * @param props - the node, the captured shipped renderer, and the injected face.
 * @returns null for this plugin's regenerate trigger, otherwise the shipped row.
 */
export function EditedContextNodeView(props: NodeProps & ContextNodeInjected) {
  const data = props.node?.data ?? {}
  const source = data['source'] as { kind?: string; plugin?: string } | undefined
  // The trigger is this plugin's own bookkeeping, not conversation.
  if (source?.kind === 'plugin' && source.plugin === (props.pluginId ?? 'dsh-message-editor')) return null

  const builtin = props.builtinNode
  if (builtin === undefined || builtin === null || props.node === undefined) return null
  const conversationT = props.conversationT
  return h(builtin as never, conversationT === undefined
    ? props
    : { ...props, t: conversationT })
}
