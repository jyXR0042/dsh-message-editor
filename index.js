/**
 * dsh-message-editor — host half entry.
 *
 * The loader imports a bundle by its bare package name, so this file is what
 * `exports["."]` points at; the implementation lives in `lib/host.js` beside the
 * built browser half. Keeping one implementation file avoids two copies of the
 * log-rewriting logic drifting apart.
 *
 * @module dsh-message-editor
 */

export { name, inject, apply, internals } from './lib/host.js'