/**
 * The plugin's entire stylesheet, kept as one string.
 *
 * A third-party client half may not import a CSS-module pipeline, and the
 * installed shell seeds no stylesheet loader, so the surface injects one
 * `<style>` tag itself under a stable `data-plugin-css` key.
 *
 * Every value is a `--dsw-alias-*` theme token; each reference carries a
 * fallback chain because a token that a given release does not advertise must
 * degrade to a neighbouring alias rather than to nothing.
 *
 * @module dsh-message-editor/client/styles
 */

/** Stable identity of this plugin's `<style>` tag. */
const STYLE_ID = 'dsh-message-editor'

/** The stylesheet text. */
export const STYLES = `
.dme-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  cursor: pointer;
  transition: background 80ms ease, color 80ms ease;
}
.dme-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dme-action:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
.dme-action[disabled] {
  opacity: 0.45;
  cursor: default;
}
.dme-action[data-active] {
  color: var(--dsw-alias-brand-primary, #4d6bfe);
}

.dme-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
}

.dme-time {
  font-size: 14px;
  line-height: 24px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  white-space: nowrap;
}

.dme-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 24px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  white-space: nowrap;
}
.dme-badge-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
}

/* ---- user bubble -------------------------------------------------------- */

.dme-user-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  width: 100%;
}
.dme-user-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: min(525px, 82%);
}
.dme-bubble {
  background: var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1)));
  border-radius: 22px;
  padding: 10px 16px;
  font-size: 16px;
  line-height: 24px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
  word-break: break-word;
}
.dme-text {
  white-space: pre-wrap;
}
.dme-ref {
  display: inline-block;
  padding: 0 6px;
  margin: 0 1px;
  border-radius: 6px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  font-size: 15px;
}
.dme-images {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.dme-image {
  max-width: 220px;
  max-height: 220px;
  border-radius: 12px;
  object-fit: cover;
  cursor: zoom-in;
  display: block;
}
.dme-image-fallback {
  font-size: 12px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
}
.dme-extra {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.06));
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  max-height: 160px;
  overflow: auto;
}

/* ---- editor ------------------------------------------------------------- */

.dme-editor {
  width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 18px;
  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.05));
  padding: 10px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dme-editor:focus-within {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
}
.dme-input {
  width: 100%;
  min-height: 84px;
  max-height: 45vh;
  resize: vertical;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 24px;
  padding: 0;
  field-sizing: content;
}
.dme-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.dme-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 3px 4px 3px 10px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.14));
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dme-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dme-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dme-chip-remove:hover {
  background: var(--dsw-alias-state-error-primary, #e5484d);
  color: #fff;
}
.dme-chip[data-removed] .dme-chip-label {
  text-decoration: line-through;
  opacity: 0.6;
}

.dme-editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dme-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dme-hint[data-tone='error'] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.dme-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.dme-btn {
  height: 28px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 13px;
  line-height: 26px;
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  white-space: nowrap;
}
.dme-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dme-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
.dme-btn[disabled] {
  opacity: 0.45;
  cursor: default;
}
.dme-btn[data-variant='primary'] {
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  color: #fff;
}
.dme-btn[data-variant='primary']:hover {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d6bfe));
  color: #fff;
}

/* ---- assistant fallback body ------------------------------------------- */

.dme-assistant {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.dme-reasoning {
  border-left: 2px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  padding: 2px 0 2px 10px;
  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary, #8a8a8a));
  font-size: 14px;
  line-height: 22px;
  white-space: pre-wrap;
}

.dme-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: 40;
  max-width: 70vw;
  padding: 8px 14px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, rgba(20, 20, 20, 0.92));
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font-size: 13px;
  line-height: 20px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.24);
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .dme-action { transition: none; }
}
`

/**
 * Install the stylesheet exactly once per document.
 * @param doc - the document to style; defaults to the global one.
 */
export function installStyles(doc?: Document): void {
  const target = doc ?? (typeof document === 'undefined' ? undefined : document)
  if (target === undefined) return
  if (target.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
  const tag = target.createElement('style')
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = STYLES
  target.head.appendChild(tag)
}
