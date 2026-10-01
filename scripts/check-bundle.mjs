/**
 * Guard the browser bundle's loader contract.
 *
 * The harness serves `exports["./client"]` verbatim, so a wrong handoff id, a
 * missing wrapper, or an external that the shell's module table does not seed
 * would only surface as a silently absent client half at runtime.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const bundlePath = resolve(root, manifest.exports['./client'].default)
const text = await readFile(bundlePath, 'utf8')

/** Specifiers the installed shell seeds into the browser module table. */
const SEEDED = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])

const problems = []

if (!text.startsWith('window.__ModuleLoader__.load(')) {
  problems.push('the bundle does not open with window.__ModuleLoader__.load(')
}
const id = /id:\s*"([^"]+)"/.exec(text)?.[1]
if (id !== manifest.name) {
  problems.push(`handoff id ${JSON.stringify(id)} must equal the package name ${JSON.stringify(manifest.name)}`)
}
if (!text.includes('return module.exports;')) {
  problems.push('the factory does not return module.exports')
}

const requires = [...new Set([...text.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))]
const unseeded = requires.filter((name) => !SEEDED.has(name))
if (unseeded.length > 0) {
  problems.push(`unseeded external module(s): ${unseeded.join(', ')}`)
}

if (problems.length > 0) {
  console.error('bundle check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`bundle ok — id ${id}, ${requires.length} external specifier(s): ${requires.join(', ') || 'none'}`)
