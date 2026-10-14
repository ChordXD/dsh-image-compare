/**
 * Verify that dsh-image-compare's CLIENT half actually loads and activates on a
 * live harness page — the check that catches "web boot: 1 entry did not
 * activate" and "plugin did not finish syncing" before a user sees them.
 *
 * It performs exactly what the browser does at boot:
 *   1. authenticate (`GET /?token=…` → session cookie),
 *   2. read the `__DSH_BOOT__` payload out of the served page,
 *   3. download every bootstrap/application batch script,
 *   4. execute them with a stub `window.__ModuleLoader__`,
 *   5. materialize this package's factory and run `apply()` against a stub
 *      Cordis client context,
 *   6. assert the observable effects: one `tool.call.toolview#view_images` slot
 *      entry and one self-owned `<style data-plugin-css="dsh-image-compare">`.
 *
 * Usage:
 *   node tools/verify-boot.mjs <base-url> [token]
 *
 * `base-url` is the URL the harness prints (`http://127.0.0.1:<port>`); `token`
 * is optional — when omitted, the page is read unauthenticated, which works on
 * a loopback bind that needs no token.
 */
import vm from 'node:vm'

const baseUrl = process.argv[2]
const token = process.argv[3]
if (baseUrl === undefined) {
  console.error('usage: node tools/verify-boot.mjs <base-url> [token]')
  process.exit(2)
}

const PLUGIN_ID = 'dsh-image-compare'
const STYLE_MARKER = `style[data-plugin-css="${PLUGIN_ID}"]`

/** Authenticate when a token is given and return the session cookie, if any. */
async function authenticate() {
  if (token === undefined) return undefined
  const response = await fetch(`${baseUrl}/?token=${token}`, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie()
  if (cookies.length === 0) throw new Error(`no session cookie in the ${response.status} response — wrong token?`)
  return cookies[0].split(';')[0]
}

const cookie = await authenticate()
const headers = cookie === undefined ? {} : { cookie }

const pageResponse = await fetch(`${baseUrl}/`, { headers })
const html = await pageResponse.text()
if (pageResponse.status !== 200) throw new Error(`GET ${baseUrl}/ answered ${pageResponse.status}: ${html.slice(0, 120)}`)

const marker = html.indexOf('__DSH_BOOT__')
if (marker === -1) throw new Error('the served page carries no __DSH_BOOT__ payload (not a dsh harness page?)')
const payload = JSON.parse(html.slice(html.indexOf('=', marker) + 1, html.indexOf('</script>', marker)))
console.log(`graph rev ${payload.rev}: ${payload.entries.length} module rows, ${payload.batches.length} batches`)

const mine = payload.entries.find((entry) => entry.id === PLUGIN_ID)
if (mine === undefined) {
  throw new Error(`${PLUGIN_ID} is NOT in the boot graph — the host half did not declare dsh.client, the bundle is missing, or the entry failed to load; check the host log`)
}
console.log(`module row: ${JSON.stringify(mine)}`)

/**
 * A stub good enough to RUN the real client half, because simply parsing it is not enough:
 * a bundle that throws while registering never claims its slots, and the boot then looks
 * healthy while the UI is missing. Every API the half actually reaches for must be here —
 * a missing one surfaces as a false "the plugin is broken".
 */
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: Symbol('Fragment'),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useLayoutEffect: () => {},
  useSyncExternalStore: (_subscribe, snapshot) => (typeof snapshot === 'function' ? snapshot() : snapshot),
  createContext: (initial) => ({ _current: initial, Provider: Symbol('Provider'), Consumer: Symbol('Consumer') }),
  useContext: (context) => context?._current,
}

const factories = new Map()
const styleTags = []
const documentStub = {
  createElement: (tagName) => ({ tagName, dataset: {}, style: {}, textContent: '', parentNode: null, remove() {}, addEventListener() {} }),
  head: {
    appendChild(element) {
      element.parentNode = documentStub.head
      styleTags.push(element)
    },
    removeChild(element) {
      element.parentNode = null
    },
  },
  body: { appendChild: () => {} },
  querySelector: () => null,
}
const context = vm.createContext({
  window: { __ModuleLoader__: { load: (registration) => factories.set(registration.id, registration.factory) } },
  document: documentStub,
  console, Symbol, Object, Array, JSON, Promise, Error, Map, Set, Math, Date, String, Number, Boolean, RegExp, URL,
})

for (const batch of payload.batches) {
  // The plugin route keys responses by pathname+search verbatim, so the auth
  // cookie — never an appended query parameter — carries the session.
  const url = `${baseUrl}/${batch.url.replaceAll('&amp;', '&')}`
  const response = await fetch(url, { headers })
  const body = await response.text()
  if (!response.ok) throw new Error(`batch ${batch.phase} answered ${response.status}: ${body.slice(0, 120)}`)
  vm.runInContext(body, context, { filename: batch.url.slice(0, 80) })
  console.log(`batch ${batch.phase}: 200, ${body.length} bytes, ${factories.size} factories registered`)
}

if (!factories.has(PLUGIN_ID)) {
  throw new Error(`${PLUGIN_ID} executed its bundle without registering a factory — check the bundle's first line (window.__ModuleLoader__.load({ id: '${PLUGIN_ID}', … }))`)
}
console.log('factory registered: yes')

const exported = factories.get(PLUGIN_ID)((specifier) => {
  if (specifier === 'react') return react
  throw new Error(`bundle requires an unexpected module: ${specifier}`)
})
console.log(`exports: ${Object.keys(exported).join(',')} | inject: ${JSON.stringify(exported.inject)}`)

const registered = []
const effectDisposers = []
const tabTypes = []
const openedTabs = []
exported.apply({
  effect: (callback) => {
    const disposer = callback()
    effectDisposers.push(typeof disposer === 'function' ? disposer : () => {})
    return () => {}
  },
  // The declared services are read as PROPERTIES, exactly as the plugin reads them,
  // so this stub must carry them: a stub that omits one hides a real activation bug.
  // `sidebarRight` is the navigation controller — the tab navigation goes through its
  // `openTab`, which is the only thing that actually opens that column.
  sidebarRight: {
    openTab: (kind) => { openedTabs.push(kind) },
  },
  // The tab registry is reached through `ctx.inject`, which activates only once the
  // service exists (this deployment has it).
  inject: (names, callback) => {
    callback({
      effect: (cb) => { cb(); return () => {} },
      sidebarRightTabs: {
        register: (definition) => { tabTypes.push(definition); return () => {} },
      },
    })
    return () => {}
  },
  slots: {
    inject: (_key, callback) => { callback(); return () => {} },
    register: (registration, component) => {
      registered.push(`${registration.name}#${registration.key} (component: ${typeof component})`)
      return () => {}
    },
  },
})

const failures = []
// The column tab body and its title chip. The Tool card is gone with the model-facing tools,
// so claiming `tool.call.toolview` would be a seat for something that cannot render.
const expectedSlots = [
  'sidebar.right.pane.tab#dsh-image-compare',
  'sidebar.right.pane.tab.title#dsh-image-compare',
]
for (const entry of registered) console.log(`slot: ${entry}`)
for (const expected of expectedSlots) {
  if (!registered.some((entry) => entry.startsWith(expected))) failures.push(`missing slot registration ${expected}`)
}
if (registered.length !== expectedSlots.length) {
  failures.push(`expected ${expectedSlots.length} slot registrations, saw ${registered.length}`)
}
const tabType = tabTypes.find((definition) => definition.id === 'dsh-image-compare')
if (tabType === undefined) failures.push('the right-column tab type was not registered')
else {
  console.log(`tab type: ${tabType.id} (kind ${tabType.kind}, ${tabType.guide?.length ?? 0} guide entries)`)
  if (!Array.isArray(tabType.guide) || tabType.guide.length === 0) {
    failures.push('the tab type carries no guide entry, so the column start page cannot list it')
  }
}
// Activating must not navigate: the card does that when the user presses it, not apply().
// `openedTabs` stays empty here, which is what this asserts.
if (openedTabs.length !== 0) failures.push(`apply() opened the column by itself: ${openedTabs.join(', ')}`)
if (styleTags.length !== 1) failures.push(`expected exactly one self-owned style tag, saw ${styleTags.length}`)
for (const tag of styleTags) console.log(`style: <${tag.tagName} data-plugin-css="${tag.dataset.pluginCss}"> ${tag.textContent.length} bytes`)
for (const dispose of effectDisposers) dispose()
if (styleTags[0] !== undefined && styleTags[0].parentNode !== null) failures.push('the disposer left the style tag in the head')

if (failures.length > 0) {
  console.error(`\nFAILED:\n${failures.map((line) => `  - ${line}`).join('\n')}`)
  process.exit(1)
}
console.log('\nOK: the client half registers its column tab (body, title chip, start-page entry) and its stylesheet, and disposes cleanly')
