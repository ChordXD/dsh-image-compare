/**
 * `view_images` — the host half of dsh-image-compare.
 *
 * One model-facing tool that OPENS a set of images in the harness's paginated
 * image viewer instead of returning a single image: it resolves each path
 * through the composed `ctx.fs`, reads the bytes, commits every image to the
 * durable attachment store (the same store `read_image` uses), and returns the
 * ordered durable references plus the presentation the viewer starts in.
 *
 * The bytes never enter the conversation: `output.render` emits one short text
 * summary, and the client half renders the images from the returned references
 * through the session-authorized image loader. The tool therefore costs a few
 * tokens however many megabytes the images are.
 *
 * @module dsh-image-compare
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** Row name; the loader patch and the client bundle id both use the package name. */
export const name = 'dsh-image-compare'

/** The registry services this plugin registers into. */
export const inject = ['tools', 'fs', 'webServer']

/** Read-only HTTP routes the panel's browser uses: directory listing and image bytes. */
const BROWSE_ROUTE = '/dsh-image-compare/browse'
const RAW_ROUTE = '/dsh-image-compare/raw'

/** Images accepted per call. Above this the call fails instead of stalling the session. */
const MAX_IMAGES = 60

/** Wire tool name; the client half keys its Tool view on exactly this string. */
const TOOL_NAME = 'view_images'

/** Directory-listing tool; the panel's project browser reads the workspace through it. */
const BROWSE_TOOL_NAME = 'browse_images'

/** Entries listed per directory, and per listing overall. */
const MAX_ENTRIES = 400

/** Filename-suffix → media type, mirroring what `read_image` accepts. */
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Identify the media type declared by a supported image file signature.
 * @param data - the file bytes just read.
 * @returns the detected media type, or undefined for other bytes.
 */
function sniffImageMediaType(data) {
  const matches = (offset, expected) => {
    if (data.byteLength < offset + expected.length) return false
    for (let index = 0; index < expected.length; index += 1) {
      if (data[offset + index] !== expected[index]) return false
    }
    return true
  }
  const ascii = (offset, value) => matches(offset, [...value].map((char) => char.charCodeAt(0)))
  if (matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (matches(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/** The media type a path's suffix declares, or undefined when it declares none. */
function imageMediaTypeForPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot === -1 ? undefined : IMAGE_EXTENSIONS[base.slice(dot)]
}

/** The file base name of a path spelled with either separator. */
function baseName(path) {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** One image reference as it travels to the client and back through the session log. */
function imageValue(ref) {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined
      ? {}
      : { originalDimensions: { ...ref.originalDimensions } }),
  }
}

/**
 * One entry of the result's `images` array: the durable reference itself
 * (the shape the host's runtime output validator requires — the reference must
 * be the element, not a nested field) plus the human-facing annotations.
 *
 * `additionalProperties` is left open because the annotations ride the same
 * object; `required: true` appears only on named properties, since the author
 * DSL rejects `required` on any other node.
 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: MEDIA_TYPES, required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
    path: { type: 'string' },
    label: { type: 'string' },
  },
}

const LAYOUTS = ['vertical', 'horizontal']

const DESCRIPTION = [
  'Open several images in one paginated viewer so they can be looked at side by side and compared, instead of reading them one at a time.',
  'The viewer pages up/down or left/right, shows one image or a group of images per page, and supports fit/zoom.',
  '`images` is an ordered list of PNG/JPEG/WebP/GIF paths (one per page item). Pass `layout` to choose the paging axis and `page_size` for how many images one page holds (default 2, so two images can be compared on one page).',
  'Reading is bounded by the deployment image limits; the viewer is client-side, so this call costs almost no tokens.',
].join(' ')

/**
 * Register `view_images` on the calling composition.
 * @param ctx - the registrant context carrying `tools` and `fs`.
 */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      images: {
        type: 'array',
        required: true,
        description: 'Ordered image paths (relative paths resolve against the session workspace). Each entry becomes one item in the viewer.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: {
              type: 'string',
              required: true,
              description: 'Path to a PNG/JPEG/WebP/GIF file, resolved by the filesystem backend.',
            },
            label: {
              type: 'string',
              description: 'Optional short caption shown on the image and in the viewer page list.',
            },
          },
        },
      },
      layout: {
        type: 'string',
        enum: LAYOUTS,
        description: 'Paging axis: `vertical` pages up/down (上下翻页) or `horizontal` pages left/right (左右翻页). Defaults to `vertical`.',
      },
      page_size: {
        type: 'integer',
        description: 'Images shown on one page, 1-6. Defaults to 2, which compares a pair per page.',
      },
      title: {
        type: 'string',
        description: 'Optional viewer title shown in the card and the viewer header.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          layout: { type: 'string', enum: LAYOUTS, required: true },
          pageSize: { type: 'integer', required: true },
          images: { type: 'array', required: true, items: IMAGE_VALUE_SCHEMA },
          failures: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const pages = Math.max(1, Math.ceil(value.images.length / value.pageSize))
        const axis = value.layout === 'horizontal' ? '左右翻页 (left/right)' : '上下翻页 (up/down)'
        const failed = value.failures ?? []
        const lines = [
          `Opened ${value.images.length} image${value.images.length === 1 ? '' : 's'} in the paginated image viewer: ${pages} page${pages === 1 ? '' : 's'}, ${axis}, ${value.pageSize} per page.`,
          'The viewer renders in the chat card (already visible to the user); no image bytes were added to this conversation.',
        ]
        if (failed.length > 0) {
          lines.push(`Could not open ${failed.length}: ${failed.map((item) => `${item.path} (${item.reason})`).join('; ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      // Presentation data for the client half. The Tool view's `block.meta` is
      // the framework's own channel for it (the read-file card reads `block.meta`
      // the same way), so the viewer's item list reaches the browser WITHOUT a
      // single image byte or conversation token. `render` deliberately stays a
      // short text summary.
      presentationMeta: (_args, value) => ({
        viewImages: {
          ...(value.title === undefined ? {} : { title: value.title }),
          layout: value.layout,
          pageSize: value.pageSize,
          images: value.images.map((image) => ({ ...image })),
          ...(value.failures === undefined ? {} : { failures: value.failures.map((failure) => ({ ...failure })) }),
        },
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = args.images
      if (requested.length === 0) throw new Error('images must list at least one image path')
      if (requested.length > MAX_IMAGES) {
        throw new Error(`images lists ${requested.length} paths; the viewer accepts at most ${MAX_IMAGES} per call`)
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('cannot open the image viewer: no attachment service is mounted in this composition')
      }

      const pageSizeRaw = args.page_size
      const pageSize = pageSizeRaw === undefined ? 2 : pageSizeRaw
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 6) {
        throw new Error('page_size must be an integer between 1 and 6')
      }
      const layout = args.layout ?? 'vertical'
      if (!LAYOUTS.includes(layout)) throw new Error('layout must be "vertical" or "horizontal"')

      const cwd = exec.agent?.session.header?.cwd
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)

      const images = []
      const failures = []
      for (const entry of requested) {
        const rawPath = entry.path
        if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
          failures.push({ path: String(rawPath), reason: 'empty path' })
          continue
        }
        try {
          const declared = imageMediaTypeForPath(rawPath)
          const extension = rawPath.slice(rawPath.lastIndexOf('.')).toLowerCase()
          const hasExtension = rawPath.replaceAll('\\', '/').split('/').pop()?.includes('.') ?? false
          if (declared === undefined && hasExtension) {
            throw new Error(`the ${extension} extension does not declare a supported image format (PNG/JPEG/WebP/GIF)`)
          }
          const target = await ctx.fs.resolve(rawPath, { cwd, signal: exec.signal })
          const info = await ctx.fs.stat(target, exec.signal)
          if (info === undefined) throw new Error('no such file')
          if (info.type !== 'file') throw new Error(`expected a regular file, found a ${info.type}`)
          const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
          // The BYTES decide the type; the suffix is only a fallback for bytes the
          // sniffer does not recognise. A mislabelled suffix is common (a screenshot
          // saved as .jpg), and `saveImage` re-decodes and rejects a declared type
          // that disagrees with the data — so trusting the suffix would fail an image
          // that succeeds the moment it is renamed.
          const sniffed = sniffImageMediaType(data)
          const mediaType = sniffed ?? declared
          if (mediaType === undefined) throw new Error('the bytes are not a supported PNG/JPEG/WebP/GIF image')
          if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
            throw new Error(`${mediaType} images are not accepted by this deployment`)
          }
          const ref = await attachments.saveImage({
            data,
            mediaType,
            name: baseName(target.displayPath),
          })
          images.push({
            // The durable reference fields must be the element's own: the host's
            // runtime output validator matches `images[]` against the reference
            // schema, so nesting them under `image` fails the call after storage.
            ...imageValue(ref),
            path: target.displayPath,
            ...(typeof entry.label === 'string' && entry.label.trim().length > 0
              ? { label: entry.label.trim() }
              : {}),
          })
        } catch (error) {
          failures.push({ path: rawPath, reason: error instanceof Error ? error.message : String(error) })
        }
      }

      if (images.length === 0) {
        const detail = failures.map((item) => `${item.path}: ${item.reason}`).join('; ')
        throw new Error(`the image viewer has nothing to show — no image could be opened. ${detail}`)
      }

      return {
        ...(args.title === undefined ? {} : { title: args.title }),
        layout,
        pageSize,
        images: images.map((item) => ({ ...item })),
        ...(failures.length === 0 ? {} : { failures }),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.title ?? `View ${args.images.length} image${args.images.length === 1 ? '' : 's'}`,
      kind: 'read',
      rawInput: args.images,
      locations: args.images.slice(0, 8).map((entry) => ({ path: entry.path })),
    }),
  }))

  /**
   * Directory listing for the panel's browser.
   *
   * The Client side has no usable directory API in this deployment — the composed
   * picker serves the `native` capability only (`directoryPicker.list` answers
   * `directory-picker/unavailable`), and the Remote carrier answers
   * `gateway/bad-request` for an outside plugin — so the listing is served where
   * the filesystem actually lives: here, through `ctx.fs.listDir`.
   *
   * Nothing is read or committed: entries carry a path, a kind and a size only, so
   * browsing a folder costs no image bytes and no conversation tokens until the
   * user actually opens something.
   */
  ctx.tools.register(defineTool({
    name: BROWSE_TOOL_NAME,
    description: [
      'List one workspace directory for the image viewer panel: subdirectories and image files (PNG/JPEG/WebP/GIF) only.',
      'Use it to let the user choose which images to compare when a path is not known yet; opening them is still `view_images`.',
      'It reads no file content, so it is cheap and never adds image bytes to the conversation.',
    ].join(' '),
    parameters: {
      path: {
        type: 'string',
        description: 'Directory to list, resolved by the filesystem backend. Omit it to list the session workspace root — the default, and the correct target for a session routed to a remote host.',
      },
      recursive: {
        type: 'boolean',
        description: 'Walk subdirectories too (bounded by the entry cap). Defaults to false: list direct children only.',
      },
      max_depth: {
        type: 'integer',
        description: 'How deep a recursive walk may go, 1-4. Defaults to 2.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          dirs: { type: 'array', required: true, items: { type: 'string' } },
          images: { type: 'array', required: true, items: { type: 'string' } },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Listed ${value.path}: ${value.dirs.length} director${value.dirs.length === 1 ? 'y' : 'ies'}, ${value.images.length} image${value.images.length === 1 ? '' : 's'}${value.truncated === true ? ' (truncated)' : ''}.`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const workspaceCwd = exec.agent?.session.header?.cwd
      // The workspace root is the session's working directory: for a session routed
      // to a remote host that is the REMOTE path, so the same call lists the remote
      // directory without this plugin knowing anything about routing.
      const requested = args.path === undefined || args.path === '' ? (workspaceCwd ?? '.') : args.path
      const recursive = args.recursive === true
      const rawDepth = args.max_depth
      const maxDepth = rawDepth === undefined ? 2 : rawDepth
      if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4) {
        throw new Error('max_depth must be an integer between 1 and 4')
      }
      const root = await ctx.fs.resolve(requested, { cwd: workspaceCwd, signal: exec.signal })
      const rootInfo = await ctx.fs.stat(root, exec.signal)
      if (rootInfo === undefined) throw new Error(`no such directory: ${requested}`)
      if (rootInfo.type !== 'directory') throw new Error(`not a directory: ${root.displayPath}`)

      const dirs = []
      const images = []
      let truncated = false

      /** Walk one directory level, appending to the shared accumulators. */
      const walk = async (dir, depth) => {
        if (truncated) return
        const entries = await ctx.fs.listDir(dir, exec.signal)
        for (const entry of entries) {
          if (dirs.length + images.length >= MAX_ENTRIES) {
            truncated = true
            return
          }
          if (entry.type === 'directory') {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
            dirs.push(entry.target.displayPath)
            if (recursive && depth < maxDepth) await walk(entry.target, depth + 1)
            continue
          }
          if (entry.type !== 'file') continue
          if (imageMediaTypeForPath(entry.name) === undefined) continue
          images.push(entry.target.displayPath)
        }
      }

      await walk(root, 1)
      return { path: root.displayPath, dirs, images, ...(truncated ? { truncated } : {}) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `List ${args.path ?? 'workspace'}`,
      kind: 'read',
      rawInput: { path: args.path ?? '.' },
    }),
  }))

  registerBrowseRoute(ctx)
}

/**
 * Serve the panel's project browser over a read-only HTTP route.
 *
 * WHY A ROUTE: the panel cannot list a directory itself on this deployment. The
 * Client's `remote.workspaceFiles` namespace answers `gateway/bad-request` for a
 * plugin-scoped caller (the built-in file tab reaches it through a session-scoped
 * carrier a third-party plugin does not share) and the composed directory picker
 * serves the `native` capability only. So the panel asks the side that CAN list —
 * the host, through `ctx.fs` — and `fetch`es the answer.
 *
 * The route is read-only, lists nothing outside the requested path, and follows
 * the Host filesystem's own routing, so a session whose workspace lives on a
 * remote host lists that host's directory.
 *
 * @param ctx - the registrant context (optionally carrying `webServer`).
 */
function registerBrowseRoute(ctx) {
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('dsh-image-compare: no webServer; the panel cannot list directories')
    return
  }

  /**
   * Resolve the filesystem to use and the workspace root that fences it.
   *
   * The SESSION decides both: a session routed to a remote host carries a remote
   * `cwd`, and its own scoped `fs` IS the routing provider, so listing through it
   * answers with that host's directory. The root is what makes the routes safe —
   * without it the query string could name any file on the machine.
   */
  const resolveRouteContext = (sessionId, requestedCwd) => {
    let fs = ctx.fs
    let root = requestedCwd
    try {
      const agent = sessionId === undefined ? undefined : ctx.get('agents')?.get(sessionId)
      if (agent !== undefined) {
        root = agent.session?.header?.cwd ?? root
        if (agent.ctx?.fs !== undefined) fs = agent.ctx.fs
      }
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-image-compare: cannot resolve session ${String(sessionId)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { fs, root }
  }

  /**
   * Resolve one request target, refusing anything outside the workspace.
   *
   * `ctx.fs.resolve` deliberately provides NO containment ("a resolution default,
   * not a containment boundary"), so the fence is applied here, against the
   * session's workspace root. Both the resolved target and its display path are
   * checked: the first catches aliasing, the second catches a `..` spelling that
   * never left the string domain.
   *
   * @returns `{ target, root }`, or `{ status, error }` for the caller to answer.
   */
  const resolveFenced = async (fs, root, requested) => {
    const resolvedRoot = await fs.resolve(root ?? '.')
    let target
    try {
      target =
        requested === '' || requested === '.'
          ? resolvedRoot
          : await fs.resolve(requested, root === undefined ? undefined : { cwd: root })
    } catch (error) {
      // An unresolvable path is a normal "no such entry", not a server fault: the
      // client shows the reason and the user keeps browsing.
      return { status: 404, error: error instanceof Error ? error.message : String(error), missing: true }
    }

    const inside = (parent, child) => {
      const path = child.displayPath ?? ''
      const base = parent.displayPath ?? ''
      return path === base || path.startsWith(base.endsWith('/') || base.endsWith('\\') ? base : `${base}/`) || path.startsWith(`${base}\\`)
    }
    if (target !== resolvedRoot && (!inside(resolvedRoot, target) || !fs.contains(resolvedRoot, target))) {
      return { status: 403, error: 'path is outside the session workspace' }
    }
    return { target, root: resolvedRoot }
  }

  /** List one directory and answer JSON; every failure is a JSON error body. */
  const browseHandler = async (req, res) => {
    const url = req.url ?? '/'
    const query = new URL(url, 'http://localhost').searchParams
    const requested = query.get('path') ?? ''
    const { fs, root } = resolveRouteContext(query.get('session') ?? undefined, query.get('cwd') ?? undefined)

    try {
      const at = await resolveFenced(fs, root, requested)
      if (at.error !== undefined) {
        return respond(res, at.status, { error: at.error, ...(at.missing === true ? { missing: true } : {}) })
      }

      const info = await fs.stat(at.target)
      if (info === undefined) {
        // `missing` tells the client this is a normal "no such directory", not the
        // "host route not loaded" case it must report differently.
        return respond(res, 404, { error: `no such directory: ${requested || at.root.displayPath}`, missing: true })
      }
      if (info.type !== 'directory') return respond(res, 400, { error: `not a directory: ${at.target.displayPath}` })

      const all = await fs.listDir(at.target)
      const entries = []
      let truncated = false
      for (const entry of all) {
        // Same hygiene as the tool: dot-directories and dependency trees stay out.
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        if (entries.length >= MAX_ENTRIES) {
          truncated = true
          break
        }
        entries.push({
          name: entry.name,
          type: entry.type,
          path: entry.target?.displayPath ?? entry.name,
          ...(entry.size === undefined ? {} : { size: entry.size }),
        })
      }
      respond(res, 200, {
        path: at.target.displayPath,
        ...(at.root.displayPath === undefined ? {} : { root: at.root.displayPath }),
        ...(truncated ? { truncated } : {}),
        entries,
      })
    } catch (error) {
      respond(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Serve one image's bytes.
   *
   * The panel cannot read a workspace file itself, so picking images is only useful
   * if the bytes come from here: an `<img src>` points at this route and the browser
   * does the fetching, the MIME handling and the caching. Only bytes that really ARE
   * an image are served, whatever the path claims.
   */
  const rawHandler = async (req, res) => {
    const url = req.url ?? '/'
    const query = new URL(url, 'http://localhost').searchParams
    const requested = query.get('path') ?? ''
    if (requested === '') return respond(res, 400, { error: 'path is required' })

    const { fs, root } = resolveRouteContext(query.get('session') ?? undefined, query.get('cwd') ?? undefined)
    const abort = new AbortController()
    req.on?.('close', () => abort.abort())

    try {
      const at = await resolveFenced(fs, root, requested)
      if (at.error !== undefined) {
        return respond(res, at.status, { error: at.error, ...(at.missing === true ? { missing: true } : {}) })
      }

      const info = await fs.stat(at.target, abort.signal)
      if (info === undefined || info.type !== 'file') {
        return respond(res, 404, { error: `no such file: ${requested}`, missing: true })
      }

      const cap = ctx.get('attachments')?.imageLimits?.maxImageBytes ?? 32 * 1024 * 1024
      const data = await fs.readBytes(at.target, abort.signal, cap)
      // The bytes decide the type; the suffix is only a fallback for the rare image
      // whose magic bytes are not recognised (an exotic but valid variant).
      const sniffed = sniffImageMediaType(data)
      const mediaType = sniffed ?? imageMediaTypeForPath(at.target.displayPath ?? requested)
      if (mediaType === undefined) {
        return respond(res, 415, { error: 'not an image (the file content is not PNG/JPEG/WebP/GIF)', missing: true })
      }
      if (res.headersSent) return
      res.writeHead(200, {
        'content-type': mediaType,
        'content-length': data.byteLength,
        'cache-control': 'no-store',
      })
      res.end(data)
    } catch (error) {
      respond(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  // Declared dependencies, so neither registration is raced: by the time apply
  // runs, the carrier exists and the routes are live for the panel's first fetch.
  const disposeBrowse = webServer.register({ kind: 'prefix', path: BROWSE_ROUTE, handler: browseHandler })
  const disposeRaw = webServer.register({ kind: 'prefix', path: RAW_ROUTE, handler: rawHandler })
  ctx.effect(() => disposeBrowse, 'dsh-image-compare: browse route')
  ctx.effect(() => disposeRaw, 'dsh-image-compare: raw route')
  ctx.logger?.info?.(`dsh-image-compare: routes registered at ${BROWSE_ROUTE} and ${RAW_ROUTE}`)
}

/** Answer one request with a JSON body, tolerating an already-answered response. */
function respond(res, status, body) {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}
