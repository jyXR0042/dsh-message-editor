/**
 * The plugin's own icon set.
 *
 * A third-party client half may not `require` an in-box icon package, and the
 * installed shell seeds only React, so the four glyphs this feature needs are
 * inlined here. Each one uses `currentColor` and a 16px box so it inherits the
 * exact chrome of the host's own message actions.
 *
 * @module dsh-message-editor/client/icons
 */

import { createElement as h } from 'react'

/** Loose prop bag: every glyph accepts `size`/`className` and passes the rest through. */
type IconProps = Record<string, unknown>

/** Shared geometry of every glyph in this module. */
const BASE = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
}

/** Cast helper: `createElement`'s SVG overloads reject a `Record<string, unknown>` bag. */
const svg = (props: IconProps, ...children: unknown[]): React.ReactElement =>
  h('svg' as never, { ...BASE, ...props } as never, ...(children as never[]))

/** Pencil — the edit affordance (mirrors the host's own edit icon). */
export const IconEdit = (props: IconProps) => svg(props,
  h('path', { key: 'a', d: 'M11.05 2.6a1.35 1.35 0 0 1 1.9 1.9l-7.3 7.3-2.5.6.6-2.5 7.3-7.3Z' }),
  h('path', { key: 'b', d: 'M10.1 3.55 12.4 5.85' }),
)

/** Copy — the same action the host puts beside it. */
export const IconCopy = (props: IconProps) => svg(props,
  h('rect', { key: 'a', x: 5.6, y: 5.6, width: 7.6, height: 7.6, rx: 1.6 }),
  h('path', { key: 'b', d: 'M10.4 3.4H4.2a1.6 1.6 0 0 0-1.6 1.6v6.2' }),
)

/** Check — the short success swap after a copy. */
export const IconCheck = (props: IconProps) => svg(props,
  h('path', { key: 'a', d: 'M3.2 8.4 6.4 11.6 12.8 4.8' }),
)

/** Close — remove one attachment. */
export const IconClose = (props: IconProps) => svg(props,
  h('path', { key: 'a', d: 'M4 4l8 8M12 4l-8 8' }),
)

/** Undo — revert one edited message to its logged original. */
export const IconRevert = (props: IconProps) => svg(props,
  h('path', { key: 'a', d: 'M3 7.2h6.2a3.4 3.4 0 0 1 0 6.8H6.4' }),
  h('path', { key: 'b', d: 'M5.4 4.4 2.6 7.2l2.8 2.8' }),
)

/**
 * Regenerate — answer this turn again.
 *
 * The circular arrow the host's own retry uses, so it reads as the familiar
 * "do it once more" rather than as a new kind of control.
 */
export const IconRegenerate = (props: IconProps) => svg(props,
  h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
  h('path', { key: 'b', d: 'M13.4 2.6v3.6H9.8' }),
)
