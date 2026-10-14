/**
 * The host half of dsh-image-compare: the two read-only routes the right-column panel reads
 * directory listings and image bytes from.
 *
 * This plugin is a SIDEBAR tool — the panel browses the session workspace itself and the user
 * picks what to compare. The model-facing `view_images` / `browse_images` tools were removed
 * for this release: the card they produced could not reliably navigate the column, and the
 * panel's own browser covers the same ground without depending on a model call. See the
 * roadmap in README.md.
 *
 * The routes are where the filesystem actually lives: the client half has no usable directory
 * API in this deployment, so listing and byte reads happen here through `ctx.fs`. The bytes
 * never enter the conversation — the panel's `<img src>` points at `/raw`, so the browser
 * fetches and caches them itself.
 *
 * @module dsh-image-compare
 */

/** Row name; the loader patch and the client bundle id both use the package name. */
export const name = 'dsh-image-compare'

/** `fs` resolves paths and `webServer` hosts the two routes; nothing else is needed. */
export const inject = ['fs', 'webServer']

/** Read-only HTTP routes the panel's browser uses: directory listing and image bytes. */
const BROWSE_ROUTE = '/dsh-image-compare/browse'
const RAW_ROUTE = '/dsh-image-compare/raw'

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

/**
 * Register this plugin's two read-only routes.
 * @param ctx - the registrant context carrying `fs` and `webServer`.
 */
export function apply(ctx) {
  // The whole host half is these routes: the panel browses the session workspace itself, so
  // there is no Tool to register and nothing else to wire.
  registerBrowseRoute(ctx)
}

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
