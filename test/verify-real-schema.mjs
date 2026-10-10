/**
 * Compile the plugin's declared schemas with the REAL `defineTool` from the
 * desktop app image, not the test stub.
 *
 * The desktop app ships its own dsh build under
 *   <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools
 * and that is the code that boots the profile, so a schema accepted by the stub
 * but rejected there still fails at boot. This script registers the plugin into
 * a stub `ctx` exactly as the harness does, letting the real `defineTool` throw.
 *
 * Usage: node verify-real-schema.mjs <path-to-dsh-tools-package>
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const toolsDir = process.argv[2]
if (toolsDir === undefined) throw new Error('usage: node verify-real-schema.mjs <dsh-tools dir>')

const pkg = JSON.parse(readFileSync(`${toolsDir}/package.json`, 'utf8'))
console.log(`real dsh-tools: ${pkg.name}@${pkg.version}`)

const require = createRequire(pathToFileURL(`${toolsDir}/`))
const entry = pkg.exports?.['.']?.default ?? pkg.exports?.['.'] ?? pkg.main
const tools = await import(pathToFileURL(`${toolsDir}/${String(entry).replace(/^\.\//, '')}`).href)
if (typeof tools.defineTool !== 'function') throw new Error('the real package exposes no defineTool')

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

/** Every tool the plugin registers, in registration order. */
const registered = []
let routeCount = 0
const ctx = {
  fs: {},
  get: () => undefined,
  tools: { register(definition) { registered.push(definition); return () => {} } },
  webServer: { register() { routeCount += 1; return () => {} } },
  effect: (callback) => { callback(); return () => {} },
}

console.log('calling apply() against the REAL defineTool…')
plugin.apply(ctx)
if (registered.length === 0) throw new Error('apply() registered no tool')

for (const tool of registered) {
  console.log(`registered tool: ${tool.name}`)
  console.log('  parameter schema properties:', Object.keys(tool.parameters?.properties ?? {}).join(','))
  console.log('  output schema properties:', Object.keys(tool.output?.schema?.properties ?? {}).join(','))
}
console.log(`registered HTTP routes: ${routeCount}`)
console.log('OK: the real compiler accepted every declared schema')
