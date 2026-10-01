/**
 * Host half of dsh-message-editor.
 *
 * The module is an ordinary Cordis plugin: `name`, `inject`, and `apply`.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export declare const name: string

/** Services required before `apply` runs. */
export declare const inject: readonly string[]

/**
 * Host plugin body: registers the `/message-editor` RPC channel and the staged
 * assistant-edit flush.
 * @param ctx - host cordis context.
 */
export declare function apply(ctx: Context): void

/** Pure helpers exported for the package's own tests. */
export declare const internals: Record<string, (...args: never[]) => unknown>
