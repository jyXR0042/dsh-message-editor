/**
 * Smoke-check the host entry's contract: the loader reads `name`, `inject`, and
 * `apply` off the package namespace, and the harness verifies the client half
 * separately.
 */

const module = await import('../index.js')

const problems = []
if (typeof module.name !== 'string' || module.name.length === 0) problems.push('name must be a non-empty string')
if (!Array.isArray(module.inject)) problems.push('inject must be an array')
for (const service of module.inject ?? []) {
  if (typeof service !== 'string') problems.push(`inject contains a non-string: ${String(service)}`)
}
if (typeof module.apply !== 'function') problems.push('apply must be a function')
if (typeof module.internals !== 'object' || module.internals === null) problems.push('internals must be an object')

if (problems.length > 0) {
  console.error('host entry check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`host entry ok — name ${module.name}, inject [${module.inject.join(', ')}], ${Object.keys(module.internals).length} test helper(s)`)
