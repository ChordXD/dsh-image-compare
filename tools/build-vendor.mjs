/**
 * Regenerate `test/vendor/client.mjs` from `lib/client.js`.
 *
 * The client half is shipped as a `window.__ModuleLoader__.load({ id, factory })` call,
 * which cannot be imported. This rewrites it into `export function factory(require)` so
 * the tests can drive the real code instead of a copy of it.
 *
 * Run: node tools/build-vendor.mjs
 *
 * It lives here rather than as a one-line shell `-replace` because that rule was wrong
 * about the file's own shape — it expected the tail indented by four spaces when the
 * closing brace actually sits in column zero — and it failed SILENTLY, leaving a bundle
 * that no longer matched its source. A wrong transform has to be loud.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const source = readFileSync(fileURLToPath(new URL('lib/client.js', root)), 'utf8')

// The loader wraps the whole file: `window.__ModuleLoader__.load({ id, factory: (require) => {`
// with the factory closed by `    },` + `  })`. Both anchors are matched loosely on
// whitespace but strictly on shape, and a miss THROWS rather than producing a broken file.
const OPEN = /^[\s\S]*?factory:\s*\(require\)\s*=>\s*\{\r?\n/
const CLOSE = /\r?\n[ \t]*\},[ \t]*\r?\n[ \t]*\}\)[ \t]*\r?\n?$/

if (!OPEN.test(source)) throw new Error('client.js: the module loader factory opening was not found')
if (!CLOSE.test(source)) throw new Error('client.js: the module loader factory closing was not found')

const body = source.replace(OPEN, '').replace(CLOSE, '')
const output = `export function factory(require) {\n${body}\n}\n`

// Structural check on the RESULT, not on the input: a mismatched brace count here is a
// bundle that parses into something other than the plugin, which is exactly the failure
// that went unnoticed before.
let depth = 0
for (const char of output) {
  if (char === '{') depth += 1
  if (char === '}') depth -= 1
  if (depth < 0) throw new Error('client.mjs: the transform produced unbalanced braces')
}
if (depth !== 0) throw new Error(`client.mjs: the transform produced unbalanced braces (depth ${depth})`)

for (const needle of ['export function factory(require)', 'exports.apply = apply', 'return module.exports']) {
  if (!output.includes(needle)) throw new Error(`client.mjs: the transform lost ${needle}`)
}

const target = fileURLToPath(new URL('test/vendor/client.mjs', root))
writeFileSync(target, output)
console.log(`test/vendor/client.mjs regenerated (${output.split('\n').length} lines, braces balanced)`)
