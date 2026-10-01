/**
 * Build script: one browser bundle for the client half.
 *
 * The installed harness serves `exports["./client"]` byte for byte and expects
 * a classic script that only registers a lazy CJS factory, so the output is
 * wrapped exactly the way the in-box client packages are:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 *
 * The `id` must equal the package name: the loader attaches a client half only
 * to the graph row whose specifier is that bare name.
 *
 * Only React is external. The shell's module table seeds React (plus a handful
 * of shell-own modules) and nothing else, so every other dependency — and there
 * are none — would have to be inlined.
 */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'lib/client.js')

/** Specifiers the shell answers from its own module table. */
const EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

/** The package name, which is also the module-loader handoff id and patch row name. */
const PACKAGE_NAME = process.env.DSH_PLUGIN_ID ?? 'dsh-message-editor'

await mkdir(dirname(outfile), { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  outfile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari16'],
  jsx: 'automatic',
  sourcemap: true,
  legalComments: 'none',
  external: EXTERNAL,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    // esbuild's JS API has no `intro`, so the module wrapper rides the banner:
    // banner → bundled code → footer is exactly the loader's factory contract.
    js: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(PACKAGE_NAME)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: '\n\t\treturn module.exports;\n\t}\n});',
  },
  logLevel: 'info',
})

// A hand-written declaration pair keeps the package's `exports` map honest
// without pulling a declaration emitter into the build.
await writeFile(
  resolve(root, 'lib/client.d.ts'),
  [
    '/** Browser half of dsh-message-editor, served as a module-loader factory. */',
    'export declare const name: string',
    'export declare const inject: readonly string[]',
    'export declare function apply(ctx: unknown): void',
    '',
  ].join('\n'),
  'utf8',
)

console.log(`built ${outfile}`)
