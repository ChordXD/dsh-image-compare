/**
 * Host-half smoke test for dsh-image-compare: compiles the declared schemas with
 * a stub `defineTool`, runs `execute` against a fake filesystem and fake
 * attachment store, and validates the RETURNED VALUE against the declared
 * output schema.
 *
 * That last step matters: the harness validates an executed tool's value at the
 * result boundary, so a schema that compiles but disagrees with what `execute`
 * returns fails the call (and only the call) with `returned invalid output` —
 * exactly the bug a compile-only check misses.
 *
 * Run with: node -e "import('./test/host.test.mjs')"
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** A 1x1 PNG, the smallest real image the magic-byte sniff accepts. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
])

/**
 * Fake composition: the plugin's tools over an in-memory file table.
 * @param files - path → bytes.
 * @param directories - extra directory paths (beyond those implied by `files`).
 */
function harness(files, directories = new Set()) {
  const saved = []
  const attachments = {
    imageLimits: {
      maxImageBytes: 1024 * 1024,
      maxMessageImageBytes: 4 * 1024 * 1024,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        ...(input.name === undefined ? {} : { name: input.name }),
      }
    },
  }
  const fs = {
    /**
     * Containment, mirroring `dsh-fs-local`'s own `contains`: the routes fence
     * against the workspace root with it, so the stub has to provide it.
     */
    contains(parent, child) {
      const base = String(parent.displayPath)
      const path = String(child.displayPath)
      return path === base || path.startsWith(`${base}/`)
    },
    async resolve(path, opts) {
      // '.' is the fixture's workspace root; any other relative path resolves
      // against it, so both absolute and relative spellings work in tests.
      const base = (opts?.cwd ?? '/w').replace(/\/$/, '')
      const normalized = path === '.' || path === './' ? base : path.startsWith('/') ? path : `${base}/${path}`
      const known = files[normalized] !== undefined || directories.has(normalized)
      const implied = [...Object.keys(files), ...directories].some((key) => key.startsWith(`${normalized}/`))
      if (!known && !implied) throw new Error(`FS_NOT_FOUND: ${path}`)
      return { targetKey: `key:${normalized}`, displayPath: normalized }
    },
    async stat(target) {
      const path = target.displayPath.replace(/\/$/, '')
      const implied = [...Object.keys(files), ...directories].some((key) => key.startsWith(`${path}/`))
      if (directories.has(path) || implied) return { version: 'v1', type: 'directory' }
      if (files[path] === undefined) return undefined
      return { version: 'v1', type: 'file', size: files[path].byteLength }
    },
    async readBytes(target) {
      return files[target.displayPath]
    },
    /** Direct children of one directory, derived from the flat tables above. */
    async listDir(target) {
      const base = target.displayPath.replace(/\/$/, '')
      const entries = []
      const seen = new Set()
      for (const path of [...Object.keys(files), ...directories]) {
        if (!path.startsWith(`${base}/`)) continue
        const rest = path.slice(base.length + 1)
        if (rest === '') continue
        const name = rest.split('/')[0]
        if (seen.has(name)) continue
        seen.add(name)
        const child = `${base}/${name}`
        entries.push({
          name,
          type: directories.has(child) ? 'directory' : 'file',
          target: { targetKey: `key:${child}`, displayPath: child },
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    },
  }
  const registeredTools = new Map()
  const registeredRoutes = []
  const disposers = []
  const ctx = {
    fs,
    get: (name) => (name === 'attachments' ? attachments : undefined),
    // Cordis effect ownership: the plugin registers its route disposer through it.
    effect: (callback) => {
      const dispose = callback()
      disposers.push(dispose)
      return () => {}
    },
    // The panel's directory browser reaches the host through this route: a missing
    // registration is exactly the `HTTP 404` the browser would report.
    webServer: {
      register(route) {
        registeredRoutes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        registeredTools.set(definition.name, definition)
        return () => {}
      },
    },
  }
  apply(ctx)
  const tool = registeredTools.get('view_images')
  assert.ok(tool !== undefined, 'view_images was registered')
  const browse = registeredTools.get('browse_images')
  assert.ok(browse !== undefined, 'browse_images was registered')
  return { tool, browse, saved, registeredTools, registeredRoutes }
}

test('the panel browse route is registered with the host carrier', () => {
  const { registeredRoutes } = harness({})
  const route = registeredRoutes.find((entry) => entry.path === '/dsh-image-compare/browse')
  if (route === undefined) {
    throw new Error(`browse route not registered: ${JSON.stringify(registeredRoutes.map((entry) => entry.path))}`)
  }
  assert.equal(route.kind, 'prefix')
  assert.equal(typeof route.handler, 'function')
})

const exec = (signal = new AbortController().signal) => ({
  signal,
  agent: { session: { header: { cwd: '/w' } } },
})

/**
 * Validate a value against a raw JSON Schema as the harness's result boundary
 * does: object requiredness, `additionalProperties: false`, arrays, scalars, enums.
 * @returns path-qualified violations; empty means the value is acceptable.
 */
function validateValue(schema, value, path = 'value') {
  const violations = []
  if (schema === undefined) return violations
  if (schema.oneOf !== undefined) {
    const branches = schema.oneOf.map((branch) => validateValue(branch, value, path))
    if (branches.every((branch) => branch.length > 0)) violations.push(`${path} matched no oneOf branch`)
    return violations
  }
  const type = schema.type
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      violations.push(`${path} must be an object`)
      return violations
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`)
    }
    const properties = schema.properties ?? {}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key} is not a declared property`)
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) violations.push(...validateValue(sub, value[key], `${path}.${key}`))
    }
    return violations
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path} must be an array`)
      return violations
    }
    value.forEach((item, index) => violations.push(...validateValue(schema.items, item, `${path}[${index}]`)))
    return violations
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) violations.push(`${path} must be an integer`)
    return violations
  }
  if (type !== undefined && typeof value !== type) violations.push(`${path} must be a ${type}`)
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.join(', ')}`)
  }
  return violations
}

/** Assert the declared output schema accepts what `execute` actually returned. */
function assertOutputValid(tool, value) {
  const violations = validateValue(tool.output.schema, value)
  assert.deepEqual(violations, [], `execute returned a value the output schema rejects:\n  ${violations.join('\n  ')}`)
}

test('view_images declares a valid argument and output schema', () => {
  const { tool } = harness({})
  assert.equal(tool.name, 'view_images')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['images'])
  assert.equal(tool.parameters.properties.images.type, 'array')
  assert.deepEqual(tool.parameters.properties.layout.enum, ['vertical', 'horizontal'])
  assert.equal(tool.output.schema.type, 'object')
  assert.ok(tool.output.schema.properties.images.items.properties.attachmentId)
})

test('execute opens every readable image and returns durable references', async () => {
  const { tool, saved } = harness({
    '/w/a.png': PNG,
    '/w/nested/b.png': PNG,
  })
  const value = await tool.execute(
    { images: [{ path: 'a.png' }, { path: 'nested/b.png', label: '第二个' }], layout: 'horizontal', page_size: 2 },
    exec(),
  )
  assert.equal(value.layout, 'horizontal')
  assert.equal(value.pageSize, 2)
  assert.equal(value.images.length, 2)
  assert.equal(value.failures, undefined)
  assert.deepEqual(value.images.map((entry) => entry.path), ['/w/a.png', '/w/nested/b.png'])
  assert.equal(value.images[0].mediaType, 'image/png')
  assert.equal(value.images[0].attachmentId, 'att-1')
  assert.equal(value.images[1].label, '第二个')
  assert.equal(value.images[1].name, 'b.png')
  assert.equal('image' in value.images[0], false, 'the reference must NOT be nested under an `image` key')
  assert.equal(saved.length, 2)
  assertOutputValid(tool, value)

  // The client half reads its item list from this presentation channel.
  const meta = tool.output.presentationMeta(undefined, value)
  assert.ok(meta.viewImages !== undefined, 'presentationMeta exposes viewImages')
  assert.equal(meta.viewImages.images.length, 2)
  assert.equal(meta.viewImages.images[0].attachmentId, 'att-1')
  assert.equal(meta.viewImages.images[0].path, '/w/a.png')
  assert.equal(meta.viewImages.images[1].label, '第二个')
  assert.equal(meta.viewImages.layout, 'horizontal')
  assert.equal(meta.viewImages.pageSize, 2)
})

test('execute defaults layout and page size, and reports partial failures', async () => {
  const { tool } = harness({ '/w/a.png': PNG })
  const value = await tool.execute({ images: [{ path: 'a.png' }, { path: 'missing.png' }] }, exec())
  assert.equal(value.layout, 'vertical')
  assert.equal(value.pageSize, 2)
  assert.equal(value.images.length, 1)
  assert.equal(value.failures.length, 1)
  assert.equal(value.failures[0].path, 'missing.png')
  assert.match(value.failures[0].reason, /FS_NOT_FOUND/)
  assertOutputValid(tool, value)
})

test('execute refuses non-images, empty lists, and oversized batches', async () => {
  const { tool } = harness({ '/w/a.txt': new Uint8Array([1, 2, 3]), '/w/b.png': PNG })
  await assert.rejects(
    () => tool.execute({ images: [{ path: 'a.txt' }] }, exec()),
    /no image could be opened/,
  )
  await assert.rejects(() => tool.execute({ images: [] }, exec()), /at least one image/)
  await assert.rejects(
    () => tool.execute({ images: Array.from({ length: 61 }, () => ({ path: 'b.png' })) }, exec()),
    /at most 60/,
  )
  await assert.rejects(() => tool.execute({ images: [{ path: 'b.png' }], page_size: 9 }, exec()), /page_size/)
})

test('render emits a text summary naming the paging axis and page count', async () => {
  const { tool } = harness({ '/w/a.png': PNG, '/w/b.png': PNG, '/w/c.png': PNG })
  const value = await tool.execute({ images: [{ path: 'a.png' }, { path: 'b.png' }, { path: 'c.png' }] }, exec())
  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /3 images/)
  assert.match(blocks[0].text, /2 pages/)
  assert.match(blocks[0].text, /up\/down/)
  assertOutputValid(tool, value)
})

test('presentCall describes the call without reading anything', () => {
  const { tool } = harness({})
  const view = tool.presentCall({ images: [{ path: 'x.png' }, { path: 'y.png' }] })
  assert.equal(view.card, 'generic')
  assert.equal(view.title, 'View 2 images')
  assert.deepEqual(view.locations, [{ path: 'x.png' }, { path: 'y.png' }])
})

test('browse_images lists subdirectories and image files only', async () => {
  const { browse } = harness(
    {
      '/w/shots/a.png': PNG,
      '/w/shots/b.jpg': PNG,
      '/w/shots/notes.txt': Uint8Array.from([1, 2, 3]),
    },
    new Set(['/w/shots', '/w/shots/nested']),
  )
  const value = await browse.execute({ path: 'shots' }, exec())
  assert.equal(value.path, '/w/shots')
  assert.deepEqual(value.dirs, ['/w/shots/nested'])
  assert.deepEqual(value.images, ['/w/shots/a.png', '/w/shots/b.jpg'])
  assertOutputValid(browse, value)
})

test('browse_images walks deeper only when asked, and refuses a file', async () => {
  const { browse } = harness(
    {
      '/w/a.png': PNG,
      '/w/deep/b.png': PNG,
    },
    new Set(['/w/deep']),
  )
  // Absolute spelling keeps the fixture's own path rules out of the assertion.
  const flat = await browse.execute({ path: '/w' }, exec())
  assert.deepEqual(flat.images, ['/w/a.png'], `flat listing: ${JSON.stringify(flat)}`)
  const deep = await browse.execute({ path: '/w', recursive: true, max_depth: 2 }, exec())
  assert.deepEqual(deep.images, ['/w/a.png', '/w/deep/b.png'], `recursive listing: ${JSON.stringify(deep)}`)
  await assert.rejects(() => browse.execute({ path: '/w/a.png' }, exec()), /not a directory/)
  await assert.rejects(() => browse.execute({ path: '/w', max_depth: 9 }, exec()), /max_depth/)
})

test('the HTTP routes refuse anything outside the session workspace', async () => {
  // A workspace with one image, one plain-text file, plus a "secret" the routes
  // must never serve.
  const { registeredRoutes } = harness({
    '/w/shots/a.png': PNG,
    '/w/notes.txt': Uint8Array.from([110, 111, 116, 101, 115]),
    '/elsewhere/secret.txt': Uint8Array.from([115, 101, 99, 114, 101, 116]),
  })
  const routeFor = (path) => registeredRoutes.find((entry) => entry.path === path)
  const browse = routeFor('/dsh-image-compare/browse')
  const raw = routeFor('/dsh-image-compare/raw')
  assert.ok(browse !== undefined && raw !== undefined, 'both routes are registered')

  /** Drive one route the way the carrier does and capture its answer. */
  const callRoute = async (route, query) => {
    const req = { url: `${route.path}?${query}`, headers: {}, on: () => {} }
    let status
    let body
    const res = {
      headersSent: false,
      writeHead(code) {
        status = code
        this.headersSent = true
        return this
      },
      end(payload) {
        body = payload
      },
    }
    await route.handler(req, res)
    return { status, json: (() => { try { return JSON.parse(body) } catch { return undefined } })() }
  }

  // 1. Inside the workspace: allowed, and the listing hides dot-dirs.
  const inside = await callRoute(browse, `path=${encodeURIComponent('/w/shots')}`)
  assert.equal(inside.status, 200)
  assert.deepEqual(inside.json.entries.map((entry) => entry.name), ['a.png'])

  // 2. Outside the workspace: refused, with no path leak in the body.
  const outside = await callRoute(browse, `path=${encodeURIComponent('/elsewhere')}`)
  assert.equal(outside.status, 403, `expected 403, saw ${outside.status}: ${JSON.stringify(outside.json)}`)

  // 3. An absolute escape is refused even though fs.resolve() happily resolves it.
  const escape = await callRoute(raw, `path=${encodeURIComponent('/elsewhere/secret.txt')}`)
  assert.equal(escape.status, 403, `expected 403, saw ${escape.status}`)

  // 4. The root spelling ('') means "the workspace root", never the host root.
  const root = await callRoute(browse, 'path=')
  assert.equal(root.status, 200)
  assert.equal(root.json.path, '/w')

  // 5. A missing directory is a JSON 404 flagged as missing, so the client can tell
  //    it apart from "the route is not registered at all".
  const missing = await callRoute(browse, `path=${encodeURIComponent('/w/nope')}`)
  assert.equal(missing.status, 404)
  assert.equal(missing.json.missing, true)

  // 6. A file that is not an image is refused by the raw route's byte check.
  const notImage = await callRoute(raw, `path=${encodeURIComponent('/w/notes.txt')}`)
  assert.equal(notImage.status, 415, `expected 415, saw ${notImage.status}`)
})
