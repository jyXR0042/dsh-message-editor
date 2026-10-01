/**
 * The inline message editor.
 *
 * Deliberately inline rather than a dialog: the message being changed stays in
 * place, so the edit reads as a correction to the conversation rather than a
 * separate form. The chrome is the host's own language — a bordered card on
 * `--dsw-alias-bg-layer-1`, capsule buttons, a 28px control height — so it
 * looks like a native surface rather than a bolt-on.
 *
 * @module dsh-message-editor/client/editor
 */

import { useCallback, useEffect, useRef } from 'react'
import { createElement as h } from 'react'
import { IconClose } from './icons.tsx'
import type { EditingState } from './controller.ts'

/**
 * Render the inline editor body.
 * @param props.editing - the open draft.
 * @param props.t - translate seat.
 * @param props.pending - a mutation is in flight.
 * @param props.error - failure text to show beside the buttons.
 * @param props.onText - draft text changed.
 * @param props.onToggleAttachment - one attachment toggled.
 * @param props.onSave - commit.
 * @param props.onCancel - discard.
 * @param props.onSaveRegenerate - commit and have the model answer again; omitted
 *   where the message has no reply of its own to redo.
 * @returns the editor element.
 */
export function InlineEditor({
  editing, t, pending, error, onText, onToggleAttachment, onSave, onCancel, onSaveRegenerate,
}: {
  editing: EditingState
  t: (key: string, params?: Record<string, unknown>) => string
  pending: boolean
  error: string | null
  onText: (text: string) => void
  onToggleAttachment: (id: string) => void
  onSave: () => void
  onCancel: () => void
  onSaveRegenerate?: (() => void) | undefined
}) {
  const area = useRef<HTMLTextAreaElement | null>(null)

  // Focus the caret at the end of the draft the moment the editor opens, which
  // is where a correction starts.
  useEffect(() => {
    const element = area.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    // Enter commits, Shift+Enter breaks the line — the host composer's contract
    // for a single-line-intent field, kept here so the muscle memory carries.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSave()
    }
  }, [onCancel, onSave])

  const removed = editing.removed

  return h('div', { className: 'dme-editor', 'data-message-editor': 'editor' },
    h('textarea', {
      ref: area,
      className: 'dme-input',
      value: editing.text,
      rows: 3,
      spellCheck: false,
      'aria-label': t('editor.title'),
      placeholder: t('editor.placeholder'),
      disabled: pending,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { onText(event.target.value) },
      onKeyDown,
    }),
    editing.attachments.length > 0 && h('div', { className: 'dme-attachments' },
      ...editing.attachments.map((attachment) => {
        const isRemoved = removed.has(attachment.id)
        return h('span', {
          key: attachment.id,
          className: 'dme-chip',
          'data-removed': isRemoved || undefined,
          title: isRemoved ? t('editor.removedAttachment') : attachment.name,
        },
        h('span', { className: 'dme-chip-label' }, attachment.name || attachment.id),
        h('button', {
          type: 'button',
          className: 'dme-chip-remove',
          'aria-label': t('editor.removeAttachment'),
          'aria-pressed': isRemoved,
          disabled: pending,
          onClick: () => { onToggleAttachment(attachment.id) },
        }, h(IconClose, { width: 12, height: 12 })))
      })),
    h('div', { className: 'dme-editor-foot' },
      h('span', {
        className: 'dme-hint',
        'data-tone': error === null ? undefined : 'error',
        role: error === null ? undefined : 'alert',
      }, error ?? t(editing.kind === 'assistant' ? 'editor.hint.assistant' : 'editor.hint.user')),
      h('span', { className: 'dme-buttons' },
        h('button', {
          type: 'button',
          className: 'dme-btn',
          disabled: pending,
          onClick: onCancel,
        }, t('editor.cancel')),
        // The cold edit stays the default; regenerating is the deliberate
        // second choice, so it sits beside Save without taking its emphasis.
        onSaveRegenerate !== undefined && h('button', {
          type: 'button',
          className: 'dme-btn',
          'data-message-editor': 'save-regenerate',
          title: t('editor.hint.regenerate'),
          disabled: pending,
          onClick: onSaveRegenerate,
        }, t('editor.saveRegenerate')),
        h('button', {
          type: 'button',
          className: 'dme-btn',
          'data-message-editor': 'save',
          'data-variant': 'primary',
          disabled: pending,
          onClick: onSave,
        }, pending ? t('editor.saving') : t('editor.save')))))
}

/**
 * Render one attachment chip list without the editor, used when a draft has no
 * editable text left. Exported for symmetry with {@link InlineEditor}.
 * @param props.t - translate seat.
 * @returns a fragment of chips.
 */
export function AttachmentChips({ labels, t }: { labels: readonly string[]; t: (key: string) => string }) {
  if (labels.length === 0) return null
  return h('div', { className: 'dme-attachments' },
    ...labels.map((label, index) => h('span', { key: `${label}-${index}`, className: 'dme-chip' },
      h('span', { className: 'dme-chip-label' }, label))),
    h('span', { className: 'dme-hint' }, t('editor.attachments')))
}
