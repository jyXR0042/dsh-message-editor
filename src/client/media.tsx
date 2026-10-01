/**
 * Message media and the small display helpers shared by both shadowed
 * renderers.
 *
 * `loadImage` is an owner prop the chat view down-threads from the session, so
 * the plugin renders durable images itself without importing the in-box
 * attachment package (which the installed shell does not seed for third-party
 * halves).
 *
 * @module dsh-message-editor/client/media
 */

import { useEffect, useMemo, useState } from 'react'
import { createElement as h } from 'react'

/** The image attachment shape this plugin reads. */
export interface MessageImage {
  attachmentId: string
  mediaType?: string
  name?: string
}

/** Resolve one durable image reference into a displayable URL. */
export function useImageUrl(
  loadImage: ((attachment: MessageImage) => Promise<string>) | undefined,
  attachment: MessageImage | undefined,
): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const id = attachment?.attachmentId

  useEffect(() => {
    let alive = true
    setUrl(null)
    setFailed(false)
    if (typeof loadImage !== 'function' || id === undefined) {
      setFailed(true)
      return () => { alive = false }
    }
    Promise.resolve(loadImage(attachment as MessageImage)).then(
      (resolved) => { if (alive) setUrl(resolved) },
      () => { if (alive) setFailed(true) },
    )
    return () => { alive = false }
  }, [loadImage, id])

  return { url, failed }
}

/**
 * Render one durable message image.
 * @param props.attachment - the reference to resolve.
 * @param props.loadImage - the session-authorized loader.
 * @param props.align - which edge the tile hugs; only affects the failure text.
 * @returns the image element or its failure label.
 */
export function MessageImage({ attachment, loadImage }: {
  attachment: MessageImage
  loadImage?: ((attachment: MessageImage) => Promise<string>) | undefined
}) {
  const { url, failed } = useImageUrl(loadImage, attachment)
  if (failed) {
    return h('span', { className: 'dme-image-fallback' }, attachment.name ?? attachment.attachmentId)
  }
  if (url === null) return null
  return h('img', {
    className: 'dme-image',
    src: url,
    alt: attachment.name ?? '',
    loading: 'lazy',
    draggable: false,
  })
}

/** Split a content list into the three shapes the transcript cares about. */
export function contentParts(content: unknown): {
  text: string
  images: MessageImage[]
  rest: unknown[]
} {
  const texts: string[] = []
  const images: MessageImage[] = []
  const rest: unknown[] = []
  for (const block of Array.isArray(content) ? content : []) {
    const typed = block as { type?: string; text?: string; attachment?: MessageImage }
    if (typed?.type === 'text' && typeof typed.text === 'string') texts.push(typed.text)
    else if (typed?.type === 'image' && typed.attachment !== undefined) images.push(typed.attachment)
    else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
}

/** Every attachment block of a content list, as editor chips. */
export function attachmentChips(content: unknown): { id: string; name: string }[] {
  const chips: { id: string; name: string }[] = []
  for (const block of Array.isArray(content) ? content : []) {
    const typed = block as { type?: string; attachment?: { attachmentId?: string; name?: string; mediaType?: string } }
    if (typed?.type !== 'image' && typed?.type !== 'file') continue
    const id = typed.attachment?.attachmentId
    if (typeof id !== 'string') continue
    chips.push({ id, name: typed.attachment?.name ?? typed.attachment?.mediaType ?? id })
  }
  return chips
}

/**
 * Apply one committed edit to a user message's content list: drop the removed
 * attachments, then collapse the text blocks into the edited string. Mirrors
 * the host's own rewrite so both sides agree byte for byte.
 */
export function applyEditToContent(content: unknown, text: string, removed: readonly string[]): unknown[] {
  const drop = new Set(removed)
  const kept = (Array.isArray(content) ? content : []).filter((block) => {
    const typed = block as { type?: string; attachment?: { attachmentId?: string } }
    if (typed?.type !== 'image' && typed?.type !== 'file') return true
    return !drop.has(typed.attachment?.attachmentId ?? '')
  })
  return collapseText(kept, text)
}

/** Collapse the text blocks of a block list into one, leaving the rest in order. */
export function collapseText(blocks: readonly unknown[], text: string): unknown[] {
  const out: unknown[] = []
  let written = false
  for (const block of blocks) {
    const typed = block as { type?: string }
    if (typed?.type === 'text') {
      if (written) continue
      written = true
      out.push({ ...(block as object), type: 'text', text })
      continue
    }
    out.push(block)
  }
  if (!written) out.unshift({ type: 'text', text })
  return out
}

/** `HH:MM` in the browser's own locale, matching the host clock's brevity. */
export function formatClock(time: unknown): string | null {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  const date = new Date(time)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** A stable string for the non-text blocks the transcript cannot render. */
export function jsonPreview(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Copy plain text, reporting whether the browser accepted the write. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * A memo-free variant selector: keeps a derived value stable while its inputs
 * are unchanged, which is what lets a selector hook publish a primitive.
 */
export function useStable<T>(factory: () => T, deps: readonly unknown[]): T {
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the caller owns the dependency list.
  return useMemo(factory, deps)
}
