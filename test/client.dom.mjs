/**
 * Client-half tests for dsh-image-compare under jsdom + React 18.
 * Run with:
 *   node --experimental-import-meta-resolve test/client.dom.mjs
 */
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true,
})

globalThis.window = dom.window
globalThis.document = dom.window.document
// Node 24 defines a getter-only `navigator`; shadow it rather than assign.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.WheelEvent = dom.window.WheelEvent
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)
/**
 * jsdom ships no ResizeObserver. The viewer uses one to re-measure a pane when its box
 * changes, and guards against its absence — but a guard left at its fallback is a code
 * path no check ever runs, so this stub keeps the real branch exercised. jsdom has no
 * layout either, so it deliberately never fires: it exists to be constructed and
 * disconnected, not to report resizes.
 */
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ReactDefault = await import('react')
const React = ReactDefault.default
/** The named-export shape the module loader hands a bundle as `require("react")`. */
const reactNamespace = { ...ReactDefault }
const { createRoot } = await import('react-dom/client')
const { act } = await import('react-dom/test-utils')
const { factory } = await import('./vendor/client.mjs')

//#region harness

/** Data URL standing in for one durable image's browser URL. */
const IMAGE_URL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIzMCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjMwIiBmaWxsPSIjNGFhIi8+PC9zdmc+'

/** The bundle must resolve with `react` alone: no other harness module may be required. */
const REQUIRED_SPECIFIERS = []

function createClient() {
  const calls = { load: 0, peek: 0 }
  let openedRightbar = 0
  const loadImage = (ref) => {
    calls.load += 1
    return Promise.resolve(`${IMAGE_URL}#${ref.attachmentId}`)
  }
  loadImage.peek = () => undefined
  const registered = []
  const effects = []
  const effectDisposers = []
  const slots = {
    inject: (key, callback) => { callback(); return () => {} },
    register: (registration, component) => {
      registered.push({ registration, component })
      return () => {}
    },
  }
  const effect = (callback, label) => {
    effects.push(label)
    const disposer = callback()
    effectDisposers.push(typeof disposer === 'function' ? disposer : () => {})
    return typeof disposer === 'function' ? disposer : () => {}
  }
  const exported = factory((specifier) => {
    REQUIRED_SPECIFIERS.push(specifier)
    if (specifier === 'react') return reactNamespace
    throw new Error(`unexpected require: ${specifier}`)
  })
  // Mirror the live Cordis guard: `ctx.effect`, `ctx.slots` and `ctx.get` are
  // core, every OTHER property must be declared by this plugin's own `inject`
  // or the read throws the runtime's exact "without inject" error (an undeclared
  // `styles` read is what parked the package in the field).
  const declared = new Set(['effect', 'slots', 'get', 'inject', ...exported.inject])
  const layout = {
    openRightbar: () => {
      openedRightbar += 1
    },
  }
  /** The session workspace file namespace, shaped like the built-in file tab expects. */
  const workspaceFiles = {
    list: async () => ({ ok: true, value: { entries: [], truncated: false } }),
    readBytes: async () => ({ ok: false, error: { code: 'not-used' } }),
  }
  const remote = { workspaceFiles }
  const tabTypes = []
  const ctx = new Proxy(
    {
      effect,
      slots,
      remote,
      // `layout` is a DECLARED dependency, so the plugin reads it as a property; the
      // stub must carry it or the card's column button silently does nothing.
      layout,
      get: (name) => (name === 'layout' ? layout : undefined),
      // `ctx.inject` is how the plugin reaches the optional tabs registry.
      inject: (names, callback) => {
        callback({
          effect,
          sidebarRightTabs: {
            register: (definition) => {
              tabTypes.push(definition)
              return () => {}
            },
          },
          remote,
        })
        return () => {}
      },
    },
    {
      has: (target, prop) => declared.has(prop),
      get: (target, prop) => {
        if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(target, prop)
        if (!declared.has(prop)) throw new Error(`cannot get property "${prop}" without inject`)
        return Reflect.get(target, prop)
      },
    },
  )
  return {
    exported,
    ctx,
    loadImage,
    registered,
    effects,
    effectDisposers,
    openedRightbar: () => openedRightbar,
    tabTypes,
  }
}

/**
 * One settled `view_images` tool node as the Tool slot delivers it.
 *
 * Presentation data rides `meta.viewImages` (this tool's
 * `output.presentationMeta`), the framework's own channel — the read-file card
 * reads `block.meta` the same way. `content` carries only the model-facing text
 * summary, exactly as the host emits it.
 */
function resultBlock(count, extra = {}) {
  const { meta: metaOverride, ...payloadExtra } = extra
  return {
    callId: 'call-1',
    call: { name: 'view_images', argsRaw: '{}' },
    content: [{ type: 'text', text: 'Opened images in the paginated image viewer: …' }],
    meta: metaOverride ?? {
      viewImages: {
        layout: 'vertical',
        pageSize: 2,
        images: Array.from({ length: count }, (_value, index) => ({
          attachmentId: `att-${index + 1}`,
          mediaType: 'image/png',
          bytes: 1024,
          width: 800,
          height: 600,
          name: `shot-${index + 1}.png`,
          path: `/w/shots/shot-${index + 1}.png`,
        })),
        ...payloadExtra,
      },
    },
  }
}

/** Host nodes every `mount` created, so the next one can drop abandoned trees. */
const mountedContainers = new Set()

async function mount(component, props) {
  // Preferences persist by design, so a check that changes them would silently alter
  // every later check's page size, font and box height. Every mount starts clean.
  try {
    window.localStorage?.removeItem('dsh-image-compare:settings')
  } catch {
    // Storage unavailable: nothing to leak.
  }
  exported.clearSettingsCache?.()
  // The viewer's floating shell lives inside the host node, so a check that ends
  // without unmounting leaves a whole second viewer in the document — and every later
  // `document.querySelector` would read THAT one. Only nodes whose tree is already
  // detached are dropped: taking down a live React tree would leave React's own
  // bookkeeping pointing at removed DOM.
  for (const stale of [...mountedContainers]) {
    if (!stale.isConnected) {
      mountedContainers.delete(stale)
      continue
    }
    if (stale.__live === true) continue
    // A node no live check owns: its React tree was abandoned, so dropping it is safe.
    stale.remove()
    mountedContainers.delete(stale)
  }
  const container = document.createElement('div')
  container.__live = true
  document.body.appendChild(container)
  mountedContainers.add(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(component, props))
  })
  await act(async () => {})
  return {
    container,
    root,
    // Unmount AND drop the host node: the viewer's floating shell renders inside this
    // container, so leaving it behind would let a later `document.querySelector` pick
    // the previous test's DOM (a whole extra viewer, buttons and all). The guard keeps
    // this safe when the pre-mount cleanup already detached the node.
    unmount: async () => {
      await act(() => root.unmount())
      container.__live = false
      if (container.isConnected) container.remove()
      mountedContainers.delete(container)
    },
  }
}

const settle = async () => {
  await act(async () => {})
}

const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

const press = async (key) => {
  await act(async () => {
    window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/**
 * A drag event carrying the payload the handles use.
 *
 * jsdom does not implement the drag-and-drop data store, so `dataTransfer` is a
 * plain stub; pointer coordinates are attached explicitly because a plain `Event`
 * would ignore them even though the reorder logic reads `clientX`.
 */
const dragEvent = (type, dataTransfer, clientX = 0) => {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  Object.defineProperty(event, 'clientX', { value: clientX })
  Object.defineProperty(event, 'clientY', { value: 0 })
  return event
}

/**
 * A wheel event on one pane, with the modifiers the zoom gestures use.
 *
 * Dispatched on the pane's CANVAS when it has one, because the zoom listener is a native
 * non-passive one bound there — React attaches `wheel` passively, so the handler cannot
 * live on the synthetic prop. Before any zoom the pane has no canvas, and the event lands
 * on the pane itself, which is where the fit view listens.
 *
 * jsdom's WheelEvent carries no `clientX/clientY` defaults, so they are attached
 * explicitly: the anchored zoom reads them.
 */
const paneWheel = async (pane, deltaY, modifiers = {}) => {
  const event = new dom.window.WheelEvent('wheel', {
    deltaY,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
  Object.defineProperty(event, 'clientX', { value: 100 })
  Object.defineProperty(event, 'clientY', { value: 60 })
  const target = pane.querySelector('.dshiv-canvas') ?? pane
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

/**
 * A middle-button press on one pane, as the pan gesture starts.
 *
 * `shiftKey` is stated explicitly rather than left to the event default. A plain press and
 * a Shift press mean different gestures here — one moves a single image, the other moves the
 * whole set — so a check that forgot the modifier would silently exercise the wrong one and
 * then fail somewhere else, blaming the drag for what the setup got wrong.
 */
const middleDown = async (pane, modifiers = {}) => {
  const event = new dom.window.MouseEvent('mousedown', {
    button: 1,
    shiftKey: false,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  })
  Object.defineProperty(event, 'clientX', { value: 200 })
  Object.defineProperty(event, 'clientY', { value: 200 })
  await act(async () => {
    pane.dispatchEvent(event)
  })
  return event
}

/** Move the pointer with dx/dy from the press point, then release. */
const dragPointer = async (dx, dy) => {
  await act(async () => {
    const move = new dom.window.MouseEvent('mousemove', { bubbles: true })
    Object.defineProperty(move, 'clientX', { value: 200 + dx })
    Object.defineProperty(move, 'clientY', { value: 200 + dy })
    window.dispatchEvent(move)
  })
  await act(async () => {
    window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }))
  })
}

/** The zoom percentage the zoom row currently reports. */
const zoomReadout = () => document.querySelector('.dshiv-zoom')?.textContent ?? ''

/** The pane whose caption mentions one image name. */
const paneFor = (name) =>
  [...document.querySelectorAll('.dshiv-pane')].find((pane) => (pane.textContent ?? '').includes(name))

const wheel = async (deltaY) => {
  const pager = document.querySelector('.dshiv-pager')
  const event = new dom.window.WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })
  await act(async () => {
    pager.dispatchEvent(event)
  })
  return event
}

/** Give a pager element the geometry jsdom does not lay out. */
function sizePager(width, height) {
  const pager = document.querySelector('.dshiv-pager')
  Object.defineProperty(pager, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(pager, 'clientHeight', { value: height, configurable: true })
  return pager
}

//#endregion

/**
 * Return the document and the preferences to a pristine state.
 *
 * A check that returns early (an assertion throws) never reaches its own `unmount`,
 * and the viewer's floating shell would then sit in the document for every later
 * check — `document.querySelector` would read THAT one. Preferences persist by
 * design, so a check that changes them would also leak its page size and font into
 * the rest. Resetting here keeps each result attributable to its own check.
 */
const resetEnvironment = () => {
  try {
    window.localStorage?.removeItem('dsh-image-compare:settings')
  } catch {
    // Storage unavailable: nothing to leak.
  }
  exported.clearSettingsCache?.()
  // The drag flag is module-scoped so a gesture survives a re-created pane; that also lets
  // it survive one check. A real pointer ends every gesture with a click or a mouseup, so
  // clearing it here reproduces that without weakening the rule it encodes.
  exported.resetDragFlag?.()
  for (const node of document.querySelectorAll('body > div')) node.remove()
  mountedContainers.clear()
}

const results = []
const check = (name, fn) => {
  resetEnvironment()
  try {
    fn()
    results.push(`✔ ${name}`)
  } catch (error) {
    results.push(`✖ ${name}\n    ${error.message}`)
    process.exitCode = 1
  }
}
const checkAsync = async (name, fn) => {
  resetEnvironment()
  try {
    await fn()
    results.push(`✔ ${name}`)
  } catch (error) {
    results.push(`✖ ${name}\n    ${error.stack ?? error.message}`)
    process.exitCode = 1
  }
}

//#region tests

/**
 * The stylesheet must survive its own template literal.
 *
 * The CSS lives in a template literal, so ONE accidental delimiter in a CSS comment
 * silently truncates it — the file still parses in some positions and the tail is simply
 * gone. That failure mode cost several debugging rounds, so it is checked first and
 * reported before anything else runs. The delimiter is BUILT rather than written: a
 * literal one in this file is precisely the hazard under test.
 */
const cssTick = String.fromCharCode(96)
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const cssOpen = clientSource.indexOf(`const CSS = ${cssTick}`)
if (cssOpen < 0) throw new Error('the client half declares no CSS block')
const cssBodyStart = cssOpen + `const CSS = ${cssTick}`.length
let cssBodyEnd = -1
for (let at = cssBodyStart; at < clientSource.length; at += 1) {
  if (clientSource[at] === '\\') {
    at += 1
    continue
  }
  if (clientSource[at] === cssTick) {
    cssBodyEnd = at
    break
  }
}
if (cssBodyEnd < 0) throw new Error('the CSS literal is never closed')
const cssText = clientSource.slice(cssBodyStart, cssBodyEnd)
const cssProblems = []
for (const marker of ['.dshiv-canvasInner img', '.dshiv-empty']) {
  if (!cssText.includes(marker)) cssProblems.push(`the CSS literal was truncated before ${marker}`)
}
const canvasRule = (cssText.match(/\.dshiv-canvasInner img\{[^}]*\}/) ?? [''])[0]
if (canvasRule === '') cssProblems.push('the zoomed-image rule is missing')
else {
  // A zoomed image must take the size the zoom gives it: as a flex item its shrink
  // defaults to 1, which compresses it back to the frame and leaves no scroll range.
  if (!canvasRule.includes('flex:none')) cssProblems.push(`the zoomed image can still be squeezed: ${canvasRule}`)
  if (!canvasRule.includes('max-width:none')) cssProblems.push(`the zoomed image is still capped: ${canvasRule}`)
}
// No pane may claim a fixed slice of the page: two fixed boxes overflow the pager and
// paint on top of each other. A min-height floor is fine — only a bare height is not,
// so the property is matched at a declaration boundary, never as a substring.
const paneRule = (cssText.match(/\.dshiv-pane\{[^}]*\}/) ?? [''])[0]
if (/(?:^|[;{])height:/.test(paneRule)) cssProblems.push(`a pane claims a fixed height and can overlap: ${paneRule}`)
// The canvas is a flex item as well, and its automatic minimum size is its CONTENT's: a
// wide zoomed image then stretches the frame to match and leaves nothing to scroll —
// exactly the "195% but only 16px of travel" symptom. min-width:0 is what lets it overflow.
const canvasFrame = (cssText.match(/\.dshiv-canvas\{[^}]*\}/) ?? [''])[0]
if (canvasFrame === '') cssProblems.push('the canvas frame rule is missing')
else if (!canvasFrame.includes('min-width:0')) {
  cssProblems.push(`the canvas frame has no min-width:0, so a wide image stretches it: ${canvasFrame}`)
}
if (cssProblems.length > 0) {
  console.error(`✖ the client stylesheet is damaged:\n    ${cssProblems.join('\n    ')}`)
  process.exit(1)
}

const { exported, ctx, loadImage, registered, effects, effectDisposers, openedRightbar, tabTypes } = createClient()
const registrationOf = (name, key) =>
  registered.find((entry) => entry.registration.name === name && entry.registration.key === key)

check('exports the plugin face, inserts its own stylesheet, and claims both seats', () => {
  assertEqual(typeof exported.apply, 'function', 'apply is exported')
  assertEqual(Array.isArray(exported.inject) && exported.inject.includes('slots'), true, 'inject declares slots')
  assertEqual(exported.inject.includes('layout'), true, 'inject declares layout (the column navigation seat)')
  exported.apply(ctx)

  const card = registrationOf('tool.call.toolview', 'view_images')
  if (card === undefined) throw new Error(`the Tool card is not registered: ${JSON.stringify(registered.map((r) => r.registration))}`)
  assertEqual(typeof card.component, 'function', 'the Tool card has a component')

  const panel = registrationOf('sidebar.right.pane.tab', 'dsh-image-compare')
  if (panel === undefined) throw new Error('the right-column tab type is not registered')
  assertEqual(typeof panel.component, 'function', 'the tab body has a component')

  const title = registrationOf('sidebar.right.pane.tab.title', 'dsh-image-compare')
  if (title === undefined) throw new Error('the right-column tab title is not registered')

  // The tab TYPE (not just the body) is what lists the viewer on the column's
  // start page through its guide entries.
  const type = tabTypes.find((entry) => entry.id === 'dsh-image-compare')
  if (type === undefined) throw new Error(`the tab type is not registered: ${JSON.stringify(tabTypes)}`)
  if (!Array.isArray(type.guide) || type.guide.length === 0) throw new Error('the tab type carries no guide entry')
  assertEqual(typeof type.guide[0].title, 'function', 'the guide entry carries a title')
  assertEqual(typeof type.guide[0].description, 'function', 'the guide entry carries a description')

  // The stylesheet is a self-owned head tag: no `ctx.styles` access, which the
  // guard proxy above would have thrown on.
  const tag = document.querySelector('style[data-plugin-css="dsh-image-compare"]')
  if (tag === null) throw new Error('stylesheet tag was not inserted')
  if (!tag.textContent.includes('.dshiv-root')) throw new Error('stylesheet tag carries the viewer CSS')
  if (document.querySelectorAll('style[data-plugin-css="dsh-image-compare"]').length !== 1) {
    throw new Error('stylesheet tag is not unique')
  }

  // Inserting twice must be idempotent (the plugin can be re-activated/reloaded).
  effects.length = 0
  effectDisposers.length = 0
  exported.apply(ctx)
  assertEqual(document.querySelectorAll('style[data-plugin-css="dsh-image-compare"]').length, 1, 'second activation reuses the tag')

  // The disposer removes the module's tag; a second activation reuses that tag.
  for (const dispose of effectDisposers) dispose()
  assertEqual(document.querySelector('style[data-plugin-css="dsh-image-compare"]'), null, 'disposer removes the tag')
})

const Card = registrationOf('tool.call.toolview', 'view_images')?.component
const Panel = registrationOf('sidebar.right.pane.tab', 'dsh-image-compare')?.component

await checkAsync('the chat card lists every image and its paging metadata', async () => {
  const view = await mount(Card, { block: resultBlock(5), loadImage, sessionId: 's1' })
  const text = view.container.textContent
  if (!text.includes('已打开 5 张图片')) throw new Error(`card title missing: ${text}`)
  if (!text.includes('上下翻页')) throw new Error(`paging axis missing: ${text}`)
  if (!text.includes('每页 2 张')) throw new Error(`page size missing: ${text}`)
  if (!text.includes('3 页')) throw new Error(`page count missing: ${text}`)
  const thumbs = view.container.querySelectorAll('.dshiv-thumb img')
  assertEqual(thumbs.length, 5, 'five thumbnails rendered')
  if (!thumbs[0].src.includes('att-1')) throw new Error('thumbnail resolved through loadImage')
  if (!view.container.textContent.includes('5. shot-5.png')) throw new Error('per-image caption missing')
  await view.unmount()
})

await checkAsync('a failed path is reported instead of failing the card', async () => {
  const block = resultBlock(1, { failures: [{ path: '/w/missing.png', reason: 'no such file' }] })
  const view = await mount(Card, { block, loadImage })
  if (!view.container.textContent.includes('1 个路径未能打开')) throw new Error('failure notice missing')
  if (!view.container.textContent.includes('/w/missing.png')) throw new Error('failure path missing')
  await view.unmount()
})

await checkAsync('an unparseable result degrades to a notice instead of throwing', async () => {
  const view = await mount(Card, { block: { result: { value: { nothing: true } } }, loadImage })
  if (!view.container.textContent.includes('无法解析')) throw new Error('fallback notice missing')
  if (view.container.querySelector('.dshiv-thumb') !== null) throw new Error('no thumbnails expected')
  await view.unmount()
})

await checkAsync('opening the viewer pages with the arrow keys, and Escape closes it', async () => {
  const view = await mount(Card, { block: resultBlock(5), loadImage })
  const openButton = [...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏'))
  if (openButton === undefined) throw new Error('open button missing')
  await click(openButton)

  const root = document.querySelector('.dshiv-root')
  if (root === null) throw new Error('viewer did not open')
  if (!root.textContent.includes('第 1/3 页')) throw new Error(`initial page label wrong: ${root.textContent}`)
  if (!root.textContent.includes('图片 1-2/5')) throw new Error('initial image range wrong')

  const pager = sizePager(900, 700)
  let scrolls = []
  pager.scrollTo = (options) => { scrolls.push(options) }

  await press('ArrowDown')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 2/3 页')) throw new Error('ArrowDown did not page')
  if (scrolls.at(-1)?.top !== 700) throw new Error(`vertical paging scrolled wrong: ${JSON.stringify(scrolls.at(-1))}`)

  await press('ArrowRight')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 3/3 页')) throw new Error('ArrowRight did not page')
  await press('ArrowDown')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 3/3 页')) throw new Error('paging ran past the last page')

  await press('Home')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 1/3 页')) throw new Error('Home did not return to the first page')

  await press('Escape')
  if (document.querySelector('.dshiv-root') !== null) throw new Error('Escape did not close the viewer')
  await view.unmount()
})

await checkAsync('the layout toggle switches the paging axis and resets the page', async () => {
  const view = await mount(Card, { block: resultBlock(5, { layout: 'horizontal' }), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  const pager = () => document.querySelector('.dshiv-pager')
  assertEqual(pager().getAttribute('data-axis'), 'horizontal', 'starts on the payload axis')

  const horizontal = [...document.querySelectorAll('.dshiv-seg button')].find((node) => node.textContent.includes('左右'))
  const vertical = [...document.querySelectorAll('.dshiv-seg button')].find((node) => node.textContent.includes('上下'))
  assertEqual(horizontal.getAttribute('data-active'), 'true', 'horizontal segment active')

  const sized = sizePager(900, 700)
  const scrolls = []
  sized.scrollTo = (options) => { scrolls.push(options) }
  await press('ArrowDown')
  assertEqual(scrolls.length, 0, 'horizontal mode ignores vertical arrows')
  await press('ArrowRight')
  assertEqual(scrolls.at(-1)?.left, 900, 'horizontal paging scrolls left')
  assertEqual(scrolls.at(-1)?.top, 0, 'horizontal paging does not scroll vertically')

  await click(vertical)
  assertEqual(pager().getAttribute('data-axis'), 'vertical', 'axis switched')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 1/3 页')) throw new Error('page did not reset on axis change')
  await press('ArrowDown')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 2/3 页')) throw new Error('vertical paging broken after the switch')
  await view.unmount()
})

await checkAsync('a wheel gesture flips exactly one page while fitted', async () => {
  const view = await mount(Card, { block: resultBlock(5), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  const first = await wheel(120)
  assertEqual(first.defaultPrevented, true, 'the page gesture is claimed')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 2/3 页')) throw new Error('wheel did not page forward')

  const throttled = await wheel(120)
  assertEqual(throttled.defaultPrevented, true, 'the follow-up gesture is still claimed')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 2/3 页')) throw new Error('wheel paged twice for one gesture')

  await new Promise((resolve) => setTimeout(resolve, 220))
  await wheel(-120)
  if (!document.querySelector('.dshiv-root').textContent.includes('第 1/3 页')) throw new Error('wheel did not page back')
  await view.unmount()
})

await checkAsync('zoomed pages keep native panning, and the filmstrip jumps pages', async () => {
  const view = await mount(Card, { block: resultBlock(5), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  await press('+')
  const canvases = document.querySelectorAll('.dshiv-canvas')
  if (canvases.length === 0) throw new Error('zoom did not switch to the pannable canvas')
  assertEqual(document.querySelector('.dshiv-pager').getAttribute('data-zoomed'), 'true', 'pager marked zoomed')
  if (!document.querySelector('.dshiv-zoom').textContent.includes('125%')) throw new Error('zoom readout missing')

  const pinned = await wheel(120)
  assertEqual(pinned.defaultPrevented, false, 'a zoomed page keeps native panning')
  if (!document.querySelector('.dshiv-root').textContent.includes('第 1/3 页')) throw new Error('zoomed wheel must not page')

  await press('0')
  assertEqual(document.querySelectorAll('.dshiv-canvas').length, 0, 'fit restores the page layout')

  const film = document.querySelectorAll('.dshiv-filmItem')
  assertEqual(film.length, 5, 'filmstrip lists every image')
  await click(film[4])
  if (!document.querySelector('.dshiv-root').textContent.includes('第 3/3 页')) throw new Error('filmstrip did not jump to the last page')
  await view.unmount()
})

await checkAsync('a rejected loader is retryable and never breaks the page', async () => {
  let failures = 0
  // The card mounts one thumbnail load per image; fail the first four calls so the
  // viewer's panes start failed too, then serve every retry.
  const flaky = (ref) => {
    if (failures < 4) {
      failures += 1
      return Promise.reject(new Error('boom'))
    }
    return Promise.resolve(`${IMAGE_URL}#${ref.attachmentId}`)
  }
  flaky.peek = () => undefined
  const view = await mount(Card, { block: resultBlock(2), loadImage: flaky })
  const failed = [...view.container.querySelectorAll('.dshiv-thumbStatus')].map((node) => node.textContent)
  if (!failed.includes('加载失败')) throw new Error(`expected a failed thumbnail, saw ${JSON.stringify(failed)}`)
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  const retry = [...document.querySelectorAll('.dshiv-btn')].filter((node) => node.textContent === '重试')
  assertEqual(retry.length, 2, 'both panes offer a retry')
  await click(retry[0])
  if (document.querySelectorAll('.dshiv-fit img').length === 0) throw new Error('retry did not load the image')
  await view.unmount()
})

await checkAsync('every inline icon keeps its declared size in the DOM', async () => {
  const view = await mount(Card, { block: resultBlock(3), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  const seats = [
    ...[...document.querySelectorAll('.dshiv-root .dshiv-bar button')].map((node) => ({ where: 'toolbar', node })),
    ...[...document.querySelectorAll('.dshiv-root .dshiv-zoombar button')].map((node) => ({ where: 'zoombar', node })),
    ...[...document.querySelectorAll('.dshiv-root .dshiv-cardIcon')].map((node) => ({ where: 'card-icon', node })),
  ]
  let checked = 0
  for (const { where, node } of seats) {
    for (const icon of node.querySelectorAll(':scope > svg')) {
      checked += 1
      const width = Number(icon.getAttribute('width'))
      const height = Number(icon.getAttribute('height'))
      const label = `${where} (${(node.textContent ?? '').trim().slice(0, 12) || node.className})`
      if (!Number.isFinite(width) || width < 8 || width > 16) {
        throw new Error(`${label}: icon width ${JSON.stringify(icon.getAttribute('width'))} out of range in ${icon.outerHTML.slice(0, 100)}`)
      }
      if (!Number.isFinite(height) || height < 8 || height > 16) {
        throw new Error(`${label}: icon height ${JSON.stringify(icon.getAttribute('height'))} out of range`)
      }
      // The inline style guard is what stops a flex line from stretching an icon;
      // read it as text because jsdom does not expand the `flex` shorthand.
      const inline = icon.getAttribute('style') ?? ''
      if (!inline.includes('flex')) throw new Error(`${label}: icon lacks the inline flex guard: ${JSON.stringify(inline)}`)
    }
  }
  if (checked < 6) throw new Error(`expected the toolbar and card icons, saw ${checked}`)
  await view.unmount()
})

await checkAsync('the card publishes the set to the right-column panel and opens the column', async () => {
  // The panel is mounted first and shows its empty state: it is a resident tab,
  // not something the card re-creates.
  const panel = await mount(Panel, {})
  if (!panel.container.textContent.includes('还没有打开的图片')) throw new Error('panel did not start empty')
  // The queue is the panel's edit surface: it starts empty and says how to fill it.
  if (!panel.container.textContent.includes('队列为空')) throw new Error('panel did not start with an empty queue')

  const view = await mount(Card, { block: resultBlock(4), loadImage })
  const button = [...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('右侧栏'))
  if (button === undefined) throw new Error('the card has no right-column entry')
  const before = openedRightbar()
  await click(button)
  if (openedRightbar() !== before + 1) throw new Error('the entry did not ask the layout service to open the column')

  // The already-mounted panel now follows the published set.
  const text = panel.container.textContent
  if (!text.includes('已打开 4 张图片') && !text.includes('4 张图片')) throw new Error(`panel did not follow the set: ${text}`)
  if (panel.container.querySelectorAll('img').length === 0) throw new Error('panel rendered no images')
  if (panel.container.querySelector('.dshiv-panel') === null) throw new Error('panel did not use the embedded shell')

  await panel.unmount()
  await view.unmount()
})

await checkAsync('the queue is edited by selection, reorderable, and only 「打开」 publishes it', async () => {
  // The browser lists whatever the host route answers, so the fixture route feeds
  // one directory with two images: ticking them is the queue edit under test.
  const listing = {
    path: '/w/shots',
    entries: [
      { name: 'alpha.png', type: 'file', path: '/w/shots/alpha.png' },
      { name: 'beta.png', type: 'file', path: '/w/shots/beta.png' },
    ],
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/dsh-image-compare/browse')) {
      return { ok: true, status: 200, json: async () => listing }
    }
    return { ok: true, status: 200, headers: new Map([['content-type', 'image/png']]).get && { get: () => 'image/png' } }
  }
  try {
    const panel = await mount(Panel, {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    const rowFor = (label) =>
      [...panel.container.querySelectorAll('button.dshiv-pickerItem')].find((node) => node.textContent.includes(label))
    const queueRows = () => [...panel.container.querySelectorAll('.dshiv-queueRow')]

    if (queueRows().length !== 0) throw new Error('queue should start empty')

    const alpha = rowFor('alpha.png')
    const beta = rowFor('beta.png')
    if (alpha === undefined || beta === undefined) throw new Error('the fixture listing did not render')

    // Ticking a file queues it; the viewer stays untouched until 「打开」.
    await click(alpha)
    if (queueRows().length !== 1) throw new Error('ticking a file did not queue it')
    if (panel.container.textContent.includes('第 1/1 页')) throw new Error('queueing must not publish the viewer')

    await click(beta)
    if (queueRows().length !== 2) throw new Error('second tick did not queue')

    // The row's × removes it again.
    const remove = queueRows()[0].querySelector('.dshiv-queueRemove')
    if (remove === null) throw new Error('a queue row has no remove control')
    await click(remove)
    if (queueRows().length !== 1) throw new Error('removing a row did not shrink the queue')

    // Reordering lives on the IMAGES (each pane carries a drag handle), not on the
    // queue rows: the queue keeps order and removal, the images do the sorting.
    const clear = [...panel.container.querySelectorAll('button')].find((node) => node.textContent.trim() === '清空')
    if (clear === undefined) throw new Error('the panel has no clear-queue button')
    await click(clear)
    if (queueRows().length !== 0) throw new Error('清空 did not empty the queue')
    await click(alpha)
    await click(beta)
    const queued = queueRows().map((row) => row.textContent)
    if (!queued[0].includes('alpha.png') || !queued[1].includes('beta.png')) {
      throw new Error(`queue kept the tick order: ${queued.join(' | ')}`)
    }
    if (panel.container.querySelector('.dshiv-queueGrip') !== null) {
      throw new Error('queue rows should no longer carry a drag grip')
    }

    // 「打开」 is what publishes the queue to the viewer.
    const open = [...panel.container.querySelectorAll('button')].find((node) => node.textContent.trim() === '打开')
    if (open === undefined) throw new Error('the panel has no open button')
    await click(open)
    if (panel.container.querySelectorAll('img').length === 0) throw new Error('opening the queue rendered no images')

    // Reordering lives on the THUMBNAIL STRIP — the only order control there is.
    const captionText = () =>
      [...panel.container.querySelectorAll('.dshiv-fitName, .dshiv-fitNameOverlay')].map((node) => node.textContent)
    const films = () => [...panel.container.querySelectorAll('.dshiv-filmItem')]
    if (!String(captionText()[0]).includes('alpha.png')) {
      throw new Error(`opened set starts with the wrong image: ${captionText().join(' | ')}`)
    }
    if (films().length !== 2) throw new Error(`the strip did not render both images: ${films().length}`)

    // Drag the SECOND thumbnail onto the LEFT half of the first: it must land before
    // it, so the set becomes beta, alpha.
    const transfer = {
      types: ['Files', 'text/plain'],
      files: [],
      cleared: [],
      clearData(type) {
        this.cleared.push(type)
        this.types = this.types.filter((entry) => entry !== type)
      },
      setData(type) {
        if (!this.types.includes(type)) this.types.push(type)
      },
      getData: () => '1',
    }
    await act(async () => {
      films()[1].dispatchEvent(dragEvent('dragstart', transfer))
    })
    // The dragged thumbnail is marked while the gesture is live.
    if (panel.container.querySelectorAll('.dshiv-filmItem[data-dragging="true"]').length !== 1) {
      throw new Error('the dragged thumbnail was not marked')
    }
    // Re-query: dragstart re-renders, so the pre-drag nodes are detached.
    await act(async () => {
      films()[0].dispatchEvent(dragEvent('dragover', transfer))
    })
    await act(async () => {
      films()[0].dispatchEvent(dragEvent('drop', transfer))
    })
    if (!String(captionText()[0]).includes('beta.png')) {
      throw new Error(`dropping on the left half did not put beta first: ${captionText().join(' | ')}`)
    }
    // Half-slot semantics on the SAME gesture direction: with the strip at
    // beta, alpha, dragging beta onto alpha's LEFT half means "put me before alpha"
    // (no move), and onto its RIGHT half means "put me after alpha" (they swap).
    const strip = panel.container.querySelector('.dshiv-film')
    const at = (item, left) =>
      Object.defineProperty(item, 'getBoundingClientRect', {
        value: () => ({ left, width: 50, top: 0, height: 40, right: left + 50, bottom: 40 }),
        configurable: true,
      })
    at(films()[0], 0)
    at(films()[1], 60)
    await act(async () => {
      films()[0].dispatchEvent(dragEvent('dragstart', transfer))
    })
    await act(async () => {
      films()[1].dispatchEvent(dragEvent('dragover', transfer, 65))
    })
    await act(async () => {
      strip.dispatchEvent(dragEvent('drop', transfer, 65))
    })
    if (!String(captionText()[0]).includes('beta.png')) {
      throw new Error(`dropping on the left half moved the image: ${captionText().join(' | ')}`)
    }
    at(films()[0], 0)
    at(films()[1], 60)
    await act(async () => {
      films()[0].dispatchEvent(dragEvent('dragstart', transfer))
    })
    await act(async () => {
      films()[1].dispatchEvent(dragEvent('dragover', transfer, 95))
    })
    await act(async () => {
      strip.dispatchEvent(dragEvent('drop', transfer, 95))
    })
    if (!String(captionText()[0]).includes('alpha.png')) {
      throw new Error(`dropping on the right half did not move the image after the slot: ${captionText().join(' | ')}`)
    }

    await panel.unmount()
  } finally {
    globalThis.fetch = realFetch
  }
})

await checkAsync('a directory with no images still offers a way back up, and the strip is resizable', async () => {
  // One nested directory that holds nothing: the user must be able to leave it
  // without retyping a path.
  const listing = {
    path: '/w/shots/deep',
    entries: [],
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => listing })
  try {
    const panel = await mount(Panel, {})
    await new Promise((resolve) => setTimeout(resolve, 0))

    const pathInput = panel.container.querySelector('.dshiv-pickerPath')
    if (pathInput === null) throw new Error('the browser has no path field')
    // React tracks the value through its own property setter, so a plain assignment
    // is invisible to onChange. Writing through the PROTOTYPE setter is what makes
    // the synthetic change event fire, exactly as a real keystroke would.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      setter.call(pathInput, 'shots/deep')
      pathInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await act(async () => {
      pathInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    if (pathInput.value !== 'shots/deep') throw new Error(`the path field did not take the value: ${pathInput.value}`)

    const upButton = [...panel.container.querySelectorAll('button')].find((node) => node.textContent.includes('上一级'))
    if (upButton === undefined) throw new Error('the browser has no up-one-level control')
    if (upButton.disabled) {
      throw new Error(`up-one-level is disabled at path ${JSON.stringify(pathInput.value)}`)
    }
    // The empty state must also offer the way back, since that is the screen a user
    // lands on inside a directory with nothing to pick.
    if (!panel.container.textContent.includes('返回上一级')) {
      throw new Error('the empty directory state offers no way back')
    }

    // The divider between the images and the strip drags the strip's height.
    const host = panel.container.querySelector('.dshiv-pickerHost')
    const resizer = panel.container.querySelector('.dshiv-resizer')
    if (host === null || resizer === null) throw new Error('the browser has no drag divider')
    const heightOf = () => Number.parseFloat(host.style.height)
    const before = heightOf()
    if (!Number.isFinite(before)) throw new Error(`the strip has no pixel height: ${host.style.height}`)
    await act(async () => {
      resizer.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientY: 400, bubbles: true, cancelable: true }))
    })
    await act(async () => {
      // Dragging UP grows the strip: the distance comes off the image area instead.
      window.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientY: 300, bubbles: true }))
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.MouseEvent('mouseup', { clientY: 300, bubbles: true }))
    })
    const after = heightOf()
    if (!(after > before)) throw new Error(`dragging up did not grow the strip: ${before} → ${after}`)
    // Clamping must hold whatever the pointer does.
    await act(async () => {
      resizer.dispatchEvent(new dom.window.MouseEvent('mousedown', { clientY: 400, bubbles: true, cancelable: true }))
    })
    await act(async () => {
      window.dispatchEvent(new dom.window.MouseEvent('mousemove', { clientY: 99999, bubbles: true }))
      window.dispatchEvent(new dom.window.MouseEvent('mouseup', { clientY: 99999, bubbles: true }))
    })
    if (heightOf() < 120) throw new Error(`the strip shrank past its minimum: ${heightOf()}`)

    await panel.unmount()
  } finally {
    globalThis.fetch = realFetch
  }
})

await checkAsync('an internal image drag never reaches the document-level attachment drop zone', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/dsh-image-compare/browse')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          path: '/w/shots',
          entries: [
            { name: 'alpha.png', type: 'file', path: '/w/shots/alpha.png' },
            { name: 'beta.png', type: 'file', path: '/w/shots/beta.png' },
          ],
        }),
      }
    }
    return { ok: true, status: 200, headers: { get: () => 'image/png' } }
  }
  // Exactly the attachment drop zone's listener: bubbling on the document, and it
  // only reacts when the transfer advertises "Files".
  const seenByDocument = []
  const watch = (event) => {
    if (event.dataTransfer?.types?.includes('Files')) seenByDocument.push(event.type)
  }
  for (const type of ['dragenter', 'dragover', 'drop']) document.addEventListener(type, watch)
  try {
    const panel = await mount(Panel, {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (const label of ['alpha.png', 'beta.png']) {
      const row = [...panel.container.querySelectorAll('button.dshiv-pickerItem')].find((node) => node.textContent.includes(label))
      if (row === undefined) throw new Error(`picker row for ${label} is missing`)
      await click(row)
    }
    const open = [...panel.container.querySelectorAll('button')].find((node) => node.textContent.trim() === '打开')
    await click(open)

    const handle = panel.container.querySelector('.dshiv-filmItem')
    if (handle === null) throw new Error('no thumbnail to exercise')
    // A realistic transfer: the browser autofills "Files" for a dragged <img>, which
    // is exactly what must be cleared before the gesture can be mistaken for a drop.
    const transfer = {
      types: ['Files', 'text/plain'],
      files: [],
      effectAllowed: 'all',
      dropEffect: 'none',
      cleared: [],
      clearData(type) {
        this.cleared.push(type)
        this.types = this.types.filter((entry) => entry !== type)
      },
      setData(type) {
        if (!this.types.includes(type)) this.types.push(type)
      },
      getData: () => '1',
    }
    await act(async () => {
      handle.dispatchEvent(dragEvent('dragstart', transfer))
    })
    if (!transfer.cleared.includes('Files') || transfer.types.includes('Files')) {
      throw new Error(`the drag advertised Files after dragstart: ${JSON.stringify(transfer.types)}`)
    }
    // The drop zone's own events, raised on a pane as the pointer crosses it.
    const pane = panel.container.querySelector('.dshiv-fit, .dshiv-canvas')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      await act(async () => {
        pane.dispatchEvent(dragEvent(type, transfer))
      })
    }
    if (seenByDocument.length > 0) {
      throw new Error(`the attachment drop zone saw the internal drag: ${seenByDocument.join(',')}`)
    }
    await panel.unmount()
  } finally {
    for (const type of ['dragenter', 'dragover', 'drop']) document.removeEventListener(type, watch)
    globalThis.fetch = realFetch
  }
})

await checkAsync('Ctrl+wheel zooms exactly one image, and the zoom row reads it', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  // Before any zoom every pane is fitted: no scroll box exists.
  if (document.querySelectorAll('.dshiv-canvas').length !== 0) throw new Error('a fitted viewer must have no canvas')
  assertEqual(zoomReadout(), '100%', 'the row starts at 100%')

  const first = document.querySelectorAll('.dshiv-pane')[0]
  await paneWheel(first, -120, { ctrlKey: true })

  const canvases = document.querySelectorAll('.dshiv-canvas')
  assertEqual(canvases.length, 1, 'only the wheeled image gains a canvas')
  assertEqual(first.getAttribute('data-zoomed'), 'true', 'the wheeled pane reports zoomed')
  const second = document.querySelectorAll('.dshiv-pane')[1]
  assertEqual(second.getAttribute('data-zoomed'), 'false', 'the neighbour stays fitted')
  if (!zoomReadout().includes('125%')) throw new Error(`the readout did not follow: ${zoomReadout()}`)

  // Scrolling the pointer panes that one image; the neighbour has no scroll box to move.
  assertEqual(canvases[0].getAttribute('data-pane-index'), '0', 'the canvas names its image')

  await view.unmount()
})

await checkAsync('the zoom row drives one image, and its buttons reset it', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  const button = (label) => [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => node.textContent.trim() === label)
  const big = button('100%')
  if (big === undefined) throw new Error('the zoom row has no 100% action')
  await click(big)
  assertEqual(document.querySelectorAll('.dshiv-canvas').length, 0, 'the clicked image is already at 1:1 while fitted')

  const plus = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => (node.getAttribute('aria-label') ?? '') === '放大这张')
  const minus = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => (node.getAttribute('aria-label') ?? '') === '缩小这张')
  if (plus === undefined || minus === undefined) throw new Error('the zoom row has no + / - actions')

  await click(plus)
  if (!zoomReadout().includes('125%')) throw new Error(`+ did not zoom: ${zoomReadout()}`)
  await click(plus)
  if (!zoomReadout().includes('156%')) throw new Error(`+ did not step again: ${zoomReadout()}`)
  await click(minus)
  if (!zoomReadout().includes('125%')) throw new Error(`- did not zoom back: ${zoomReadout()}`)

  const fit = button('适应')
  await click(fit)
  assertEqual(document.querySelectorAll('.dshiv-canvas').length, 0, '适应 returns the image to the fitted shell')
  assertEqual(zoomReadout(), '100%', '适应 reports 100%')

  await click(plus)
  const reset = button('重置')
  await click(reset)
  assertEqual(document.querySelectorAll('.dshiv-canvas').length, 0, '重置 clears every override')

  await view.unmount()
})

await checkAsync('同步全部 and Ctrl+Shift+wheel zoom the whole set', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  const panes = [...document.querySelectorAll('.dshiv-pane')]
  await paneWheel(panes[0], -120, { ctrlKey: true })
  assertEqual(document.querySelectorAll('.dshiv-canvas').length, 1, 'one image zoomed so far')

  const sync = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => node.textContent.trim() === '同步全部')
  await click(sync)
  // Every image of the set now carries the same zoom, in and out of the viewport.
  assertEqual(document.querySelectorAll('.dshiv-canvas').length, 4, 'every image of the set zoomed')

  // Ctrl+Shift+wheel is the same action from the pointer.
  await paneWheel(document.querySelectorAll('.dshiv-pane')[1], -120, { ctrlKey: true, shiftKey: true })
  if (!zoomReadout().includes('156%')) throw new Error(`Ctrl+Shift+wheel did not step the set: ${zoomReadout()}`)

  await view.unmount()
})

await checkAsync('middle drag pans one image; Shift+middle drag pans every image', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  // Zoom two images so both own a scroll box.
  await paneWheel(document.querySelectorAll('.dshiv-pane')[0], -120, { ctrlKey: true })
  await paneWheel(document.querySelectorAll('.dshiv-pane')[0], -120, { ctrlKey: true })
  await paneWheel(document.querySelectorAll('.dshiv-pane')[1], -120, { ctrlKey: true })
  const canvases = [...document.querySelectorAll('.dshiv-canvas')]
  assertEqual(canvases.length, 2, 'two images are zoomed')
  // jsdom has no layout: give both a scrollable box by hand.
  for (const node of canvases) {
    Object.defineProperty(node, 'scrollWidth', { value: 4000, configurable: true })
    Object.defineProperty(node, 'scrollHeight', { value: 4000, configurable: true })
    node.scrollLeft = 500
    node.scrollTop = 500
  }
  // Both canvases must actually hold what was just written. An earlier check's convergence
  // window writes scroll offsets on a timer, and jsdom cannot repaint between its ticks, so
  // a leftover tick could otherwise overwrite this setup and make the assertion below blame
  // the drag for something that happened before it. Measured, not assumed: this says WHICH
  // of the two it was instead of failing the gesture's own assertion.
  if (canvases[1].scrollLeft !== 500) {
    throw new Error(`the setup itself was overwritten: canvas 2 sits at ${canvases[1].scrollLeft}`)
  }

  await middleDown(canvases[0])
  await dragPointer(80, 40)
  // Dragging right carries the image right = showing more of its left side = scrollLeft UP.
  assertEqual(canvases[0].scrollLeft, 580, 'the pressed image followed the pointer')
  assertEqual(canvases[1].scrollLeft, 500, 'the other image was left alone')
  if (canvases[0].getAttribute('data-panning') !== 'false') throw new Error('the pan marker outlived the gesture')

  // Shift makes the same gesture move the whole set in the same direction.
  await middleDown(canvases[0], { shiftKey: true })
  await dragPointer(60, 0)
  assertEqual(canvases[0].scrollLeft, 640, 'the set followed the pointer from the pressed image')
  assertEqual(canvases[1].scrollLeft, 560, 'the set followed the pointer on the other image too')

  // A wheel arriving mid-drag must NOT page the viewer: an un-zoomed pager turns one
  // notch into a whole page flip, which is what makes a drag look like a slide.
  const pageBefore = document.querySelector('.dshiv-bar').textContent
  await middleDown(canvases[0])
  await act(async () => {
    const wheelDuringDrag = new dom.window.WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    canvases[0].dispatchEvent(wheelDuringDrag)
  })
  await dragPointer(0, 0)
  if (document.querySelector('.dshiv-bar').textContent !== pageBefore) {
    throw new Error('a wheel during a pan flipped the page')
  }

  // A drag is a pan, not a selection gesture: the click it ends with is ignored, and
  // only that one click — a later plain click still selects. The middle press itself
  // selects the pressed image, so the state to compare is the one after the press.
  const panes = () => [...document.querySelectorAll('.dshiv-pane')]
  const activeIndexNow = () => panes().findIndex((pane) => pane.getAttribute('data-active') === 'true')
  await click(panes()[3])
  assertEqual(activeIndexNow(), 3, 'a plain click still selects')

  await middleDown(canvases[0])
  await dragPointer(30, 0)
  const afterDrag = activeIndexNow()
  await act(async () => {
    panes()[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  assertEqual(activeIndexNow(), afterDrag, 'the click that ended a drag did not select')
  if (activeIndexNow() === 2) throw new Error('the trailing click selected the wrong image')

  await click(panes()[2])
  assertEqual(activeIndexNow(), 2, 'the NEXT click selects again')

  // Replaying a move must not move the image again. The pan is applied as
  // (origin + total travel), not as a nudge, so a duplicated event is idempotent — that is
  // the difference between a drag that tracks the pointer and one that runs away from it.
  // A relative implementation doubles here, and the drag then feels far too fast.
  await middleDown(canvases[0])
  await dragPointer(40, 25)
  const settledLeft = canvases[0].scrollLeft
  const settledTop = canvases[0].scrollTop
  await act(async () => {
    for (let repeat = 0; repeat < 5; repeat += 1) {
      const replay = new dom.window.MouseEvent('mousemove', { bubbles: true })
      Object.defineProperty(replay, 'clientX', { value: 240 })
      Object.defineProperty(replay, 'clientY', { value: 225 })
      window.dispatchEvent(replay)
    }
  })
  assertEqual(canvases[0].scrollLeft, settledLeft, 'a replayed move does not pan again (horizontal)')
  assertEqual(canvases[0].scrollTop, settledTop, 'a replayed move does not pan again (vertical)')
  await act(async () => {
    window.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }))
  })
  // The drag flag is module-scoped on purpose (it has to outlive a re-created pane), so a
  // gesture left half-finished here would swallow the NEXT check's first click.
  await click(panes()[0])

  await view.unmount()
})

await checkAsync('zoom follows an image across a filmstrip reorder', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  const second = document.querySelectorAll('.dshiv-pane')[1]
  const secondName = (second.textContent.match(/(shot-\d+\.png)/) ?? [])[1]
  await paneWheel(second, -120, { ctrlKey: true })
  assertEqual(document.querySelectorAll('.dshiv-canvas').length, 1, 'one image zoomed')

  // Drag it to the first slot: zoom is keyed by attachment, so it must travel with it.
  const transfer = { types: ['Files'], files: [], clearData() {}, setData() {}, getData: () => '1' }
  const films = () => [...document.querySelectorAll('.dshiv-filmItem')]
  await act(async () => {
    films()[1].dispatchEvent(dragEvent('dragstart', transfer))
  })
  await act(async () => {
    films()[0].dispatchEvent(dragEvent('dragover', transfer, 0))
  })
  await act(async () => {
    document.querySelector('.dshiv-film').dispatchEvent(dragEvent('drop', transfer, 0))
  })

  const moved = document.querySelectorAll('.dshiv-pane')[0]
  if (!(moved.textContent ?? '').includes(secondName)) {
    throw new Error(`the reorder did not move ${secondName} to the front: ${moved.textContent}`)
  }
  assertEqual(moved.getAttribute('data-zoomed'), 'true', 'the zoomed image is still zoomed after the reorder')

  await view.unmount()
})

await checkAsync('the settings panel persists its choices and rejects bad ones', async () => {
  window.localStorage.removeItem('dsh-image-compare:settings')
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))

  const gear = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => node.textContent.trim() === '⚙')
  if (gear === undefined) throw new Error('the zoom row has no settings button')
  await click(gear)
  const panel = document.querySelector('.dshiv-settings')
  if (panel === null) throw new Error('the settings panel did not open')

  // Change the group size through the panel's own control.
  const select = panel.querySelector('select')
  await act(async () => {
    select.value = '4'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  const stored = JSON.parse(window.localStorage.getItem('dsh-image-compare:settings'))
  assertEqual(stored.pageSize, 4, 'the choice was persisted')
  if (!document.querySelector('.dshiv-bar').textContent.includes('第 1/1 页')) {
    throw new Error('the new group size did not reach the pager')
  }

  // Out-of-range and unknown values fall back instead of breaking the viewer.
  window.localStorage.setItem('dsh-image-compare:settings', JSON.stringify({ pageSize: 99, viewerFontSize: -5, nope: 1 }))
  // The module caches the snapshot for the page's lifetime, so re-read on purpose —
  // this is the "another page wrote settings" path. Unmount first so only ONE viewer
  // is in the document and the assertions below cannot read the previous one.
  exported.clearSettingsCache()
  await view.unmount()
  const remount = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...remount.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  const again = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => node.textContent.trim() === '⚙')
  if (again === undefined) throw new Error('the remounted viewer has no settings button')
  await click(again)
  const fallback = document.querySelector('.dshiv-settings')
  if (fallback === null) throw new Error('the settings panel did not reopen after the cache was cleared')
  assertEqual(Number(fallback.querySelector('select').value), 2, 'an unknown group size falls back to the default')
  const fontField = [...fallback.querySelectorAll('.dshiv-setNum')].find((node) => node.type === 'number')
  if (fontField !== undefined && Number(fontField.value) === -5) throw new Error('an out-of-range font size was kept')

  window.localStorage.removeItem('dsh-image-compare:settings')
  exported.clearSettingsCache()
  await remount.unmount()
})

await checkAsync('a left click selects the image the zoom row drives', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  const panes = () => [...document.querySelectorAll('.dshiv-pane')]
  assertEqual(panes()[0].getAttribute('data-active'), 'true', 'the first image starts selected')

  await click(panes()[2])
  assertEqual(panes()[2].getAttribute('data-active'), 'true', 'the clicked image became the active one')
  assertEqual(panes()[0].getAttribute('data-active'), 'false', 'the previous selection was cleared')

  // The per-pane minimum must reach the viewer, or a page's images overlap.
  const style = document.querySelector('.dshiv-root').getAttribute('style') ?? ''
  if (!style.includes('--dshiv-pane-min')) throw new Error(`the pane minimum never reached the viewer: ${style}`)

  await view.unmount()
})

await checkAsync('a line-mode wheel still pages the viewer', async () => {
  const view = await mount(Card, { block: resultBlock(5), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  // Firefox's line mode reports ±3 per notch, which the raw threshold would discard.
  const pager = document.querySelector('.dshiv-pager')
  const event = new dom.window.WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true })
  await act(async () => {
    pager.dispatchEvent(event)
  })
  if (!document.querySelector('.dshiv-root').textContent.includes('第 2/3 页')) {
    throw new Error(`a line-mode notch did not page: ${document.querySelector('.dshiv-bar').textContent}`)
  }
  await view.unmount()
})

await checkAsync('同步全部 copies the zoom AND the viewed position onto every image', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  const panes = () => [...document.querySelectorAll('.dshiv-pane')]
  await paneWheel(panes()[0], -120, { ctrlKey: true })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  const canvases = [...document.querySelectorAll('.dshiv-canvas')]
  assertEqual(canvases.length, 1, 'one image is magnified before the sync')
  // jsdom does not lay out scroll boxes, so give this one a real range and park it at
  // three quarters across — the position the sync has to hand to the others.
  Object.defineProperty(canvases[0], 'scrollWidth', { value: 4000, configurable: true })
  Object.defineProperty(canvases[0], 'scrollHeight', { value: 4000, configurable: true })
  Object.defineProperty(canvases[0], 'clientWidth', { value: 1000, configurable: true })
  Object.defineProperty(canvases[0], 'clientHeight', { value: 1000, configurable: true })
  canvases[0].scrollLeft = 2250
  canvases[0].scrollTop = 2250

  const sync = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => node.textContent.trim() === '同步全部')
  await click(sync)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  const all = [...document.querySelectorAll('.dshiv-canvas')]
  assertEqual(all.length, 4, 'every image is magnified after the sync')
  const sizeBox = (node) => {
    Object.defineProperty(node, 'scrollWidth', { value: 4000, configurable: true })
    Object.defineProperty(node, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(node, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(node, 'clientHeight', { value: 1000, configurable: true })
  }
  for (const node of all) {
    sizeBox(node)
    node.scrollLeft = 0
    node.scrollTop = 0
  }
  // Park the source image at three quarters across, then sync again: the others must land
  // on the SAME relative spot. The alignment converges over a short window (panes settle
  // at different moments), so give it those ticks — asserting immediately would race the
  // very thing this test is about. Re-query afterwards: applying the sync re-renders the
  // panes, so the pre-sync NodeList may hold detached elements.
  all[0].scrollLeft = 1500
  all[0].scrollTop = 750
  await click(sync)
  await act(async () => {
    // Longer than the alignment's own polling window, so a pass here means it converged.
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
  const settled = [...document.querySelectorAll('.dshiv-canvas')]
  assertEqual(settled.length, 4, 'still four magnified images')
  for (const [index, node] of settled.entries()) {
    assertEqual(node.scrollLeft, 1500, `image ${index} took the same horizontal fraction`)
    assertEqual(node.scrollTop, 750, `image ${index} took the same vertical fraction`)
  }

  await view.unmount()
})


await checkAsync('同步全部 takes the SELECTED image as its reference', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  const panes = () => [...document.querySelectorAll('.dshiv-pane')]
  const canvasOf = (paneIndex) => document.querySelector(`.dshiv-canvas[data-pane-index="${paneIndex}"]`)
  const sizeBox = (node) => {
    Object.defineProperty(node, 'scrollWidth', { value: 4000, configurable: true })
    Object.defineProperty(node, 'scrollHeight', { value: 4000, configurable: true })
    Object.defineProperty(node, 'clientWidth', { value: 1000, configurable: true })
    Object.defineProperty(node, 'clientHeight', { value: 1000, configurable: true })
  }

  // Make the SECOND image the selected one and the only magnified one: the reference has
  // to be the selection, not merely whichever pane happens to be first.
  await click(panes()[1])
  await paneWheel(panes()[1], -120, { ctrlKey: true })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const source = canvasOf(1)
  if (source === null) throw new Error('the selected image never gained a canvas')
  sizeBox(source)
  source.scrollLeft = 750
  source.scrollTop = 250
  assertEqual(document.querySelectorAll('.dshiv-pane[data-active="true"]').length, 1, 'exactly one image is selected')

  const sync = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => node.textContent.trim() === '同步全部')
  await click(sync)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })

  const others = [...document.querySelectorAll('.dshiv-canvas')].filter((node) => node !== source)
  if (others.length === 0) throw new Error('the sync magnified no other image')
  for (const node of others) {
    sizeBox(node)
  }
  // Re-sync once the boxes are known, so the assertion checks the alignment itself rather
  // than jsdom's missing layout.
  await click(sync)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
  for (const node of others) {
    assertEqual(node.scrollLeft, 750, `the selected image's column was copied (pane ${node.getAttribute('data-pane-index')})`)
    assertEqual(node.scrollTop, 250, `the selected image's row was copied (pane ${node.getAttribute('data-pane-index')})`)
  }

  await view.unmount()
})

await checkAsync('the 100% button reaches one image pixel per screen pixel', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  // jsdom lays out nothing, so model the pane's box by hand: an 800x600 image inside a
  // 400x300 box is shown at 0.5x when fitted, which is what the button has to invert. The
  // pane measures that box itself, so the box is what a check has to provide.
  const pane = document.querySelector('.dshiv-pane')
  if (pane === null) throw new Error('no pane was rendered')
  const fitImage = pane.querySelector('.dshiv-fit img')
  if (fitImage === null) throw new Error('the pane has no fit image')
  Object.defineProperty(fitImage, 'naturalWidth', { value: 800, configurable: true })
  Object.defineProperty(fitImage, 'naturalHeight', { value: 600, configurable: true })
  Object.defineProperty(pane, 'clientWidth', { value: 400, configurable: true })
  Object.defineProperty(pane, 'clientHeight', { value: 300, configurable: true })
  // The pane re-measures on a window resize, which is the same path a real window uses.
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('resize'))
  })

  // A fitted pane reads as 100% already, which is exactly why the button looked like a
  // duplicate of 适应: the zoom is relative to the FIT, not to the pixels.
  const readout = () => document.querySelector('.dshiv-zoom').textContent.trim()
  assertEqual(readout(), '100%', 'a fitted image reads as 100% before the button is pressed')
  const fitWidth = Number.parseFloat(pane.style.getPropertyValue('--dshiv-fit-w'))
  assertEqual(fitWidth, 400, 'the pane published the width it fits the image into')

  const hundred = [...document.querySelectorAll('.dshiv-zoombar button')].find((node) => node.textContent.trim() === '100%')
  if (hundred === undefined) throw new Error('the zoom row has no 100% button')
  await click(hundred)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  // Fit is 0.5x, so actual pixels are 2x — NOT the 1x the readout used to snap back to.
  assertEqual(readout(), '200%', 'the button inverted the fit instead of resetting to 1x')

  // The size the pane renders a magnified image at is `fitted * zoom`, NOT `natural * zoom`.
  // Sizing from the natural pixels made the first zoom jump to actual size while the fitted
  // view had been scaled down to fit — the change was abrupt and unrelated to the window.
  const magnified = document.querySelector('.dshiv-canvas img')
  if (magnified === null) throw new Error('no magnified image was rendered')
  const shown = Number.parseFloat(magnified.style.width)
  assertEqual(Number.isFinite(shown), true, 'the magnified image declares a width')
  // Box 400x300 around an 800x600 image, then 2x: 800 on screen, not 800 * (800/400) = 1600.
  assertEqual(Math.round(shown), 800, 'the first zoom continued from the fitted size')
  if (shown > 800) throw new Error(`the zoom jumped past the window: ${shown}px`)

  await view.unmount()
})

await checkAsync('the first zoom continues from the fitted size, not from the raw pixels', async () => {
  const view = await mount(Card, { block: resultBlock(4), loadImage })
  await click([...view.container.querySelectorAll('button')].find((node) => node.textContent.includes('全屏')))
  sizePager(900, 700)

  // Model a pane whose box shows an 800x600 image at 400x300 (fitted at 0.5x).
  const pane = document.querySelector('.dshiv-pane')
  if (pane === null) throw new Error('no pane was rendered')
  const fitImage = pane.querySelector('.dshiv-fit img')
  if (fitImage === null) throw new Error('the pane has no fit image')
  Object.defineProperty(fitImage, 'naturalWidth', { value: 800, configurable: true })
  Object.defineProperty(fitImage, 'naturalHeight', { value: 600, configurable: true })
  Object.defineProperty(pane, 'clientWidth', { value: 400, configurable: true })
  Object.defineProperty(pane, 'clientHeight', { value: 300, configurable: true })
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('resize'))
  })
  assertEqual(Number.parseFloat(pane.style.getPropertyValue('--dshiv-fit-w')), 400, 'the pane measured its fitted width')

  // One notch of Ctrl+wheel is +25%. The image on screen must go 400 -> 500, a step the eye
  // reads as zooming in. Sizing from raw pixels would have gone 400 -> 1000 in one notch.
  const readout = () => document.querySelector('.dshiv-zoom').textContent.trim()
  await paneWheel(pane, -120, { ctrlKey: true })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  assertEqual(readout(), '125%', 'one wheel notch is 125%')
  const first = document.querySelector('.dshiv-canvas img')
  if (first === null) throw new Error('the first zoom rendered no magnified image')
  assertEqual(Math.round(Number.parseFloat(first.style.width)), 500, 'the magnified width is fitted * zoom')
  if (Number.parseFloat(first.style.width) !== 500) {
    throw new Error(`the zoom did not start from the fitted size: ${first.style.width}`)
  }

  await view.unmount()
})

check('the bundle requires nothing but react, and labels its effects', () => {  assertEqual(exported.inject.length >= 1 && exported.inject.includes('slots'), true, 'injects the slot registry')
  assertEqual([...new Set(REQUIRED_SPECIFIERS)].join(','), 'react', 'resolves with react alone')
  if (!effects.some((label) => typeof label === 'string' && label.includes('dsh-image-compare'))) {
    throw new Error(`effect labels: ${JSON.stringify(effects)}`)
  }
})

//#endregion

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log(results.join('\n'))
console.log(`\n${results.filter((line) => line.startsWith('✔')).length}/${results.length} client checks passed`)
