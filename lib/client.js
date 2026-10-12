/**
 * The client half of dsh-image-compare: the Tool view for `view_images`.
 *
 * Renders a chat card with the opened images plus a full-screen paginated
 * viewer. The viewer pages along one axis (`vertical` → 上下翻页, `horizontal`
 * → 左右翻页) with CSS scroll-snap, so paging works with the wheel, the
 * scrollbar, the arrow keys, and the previous/next buttons alike; each page
 * holds `pageSize` images side by side so they can be compared, and every image
 * has its own fit / zoomed view with panning. A filmstrip under the pager jumps
 * straight to any image.
 *
 * No image bytes travel through the tool result: the card resolves each durable
 * reference with the session-authorized `loadImage` loader the Tool slot hands
 * every view, and the page's item list is read from the settled result block.
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-compare',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect, useSyncExternalStore } = React

    //#region icons
    //
    // Icons are inlined as SVG instead of requiring
    // `@deepseek-ai/dsh-client-ui-primitives`: it keeps this bundle's require list
    // down to `react` (which every harness shell preloads), so a shell rename or a
    // primitives change can never turn the viewer into a blank card.
    /** Stroke icon sharing the primitives' 16px grid and currentColor stroke. */
    function Icon({ children, size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          // Shrink resistance is pinned here rather than by a stylesheet rule: a
          // flex item with an intrinsic ratio stretches to its line when it may
          // grow, which is exactly how these icons once filled the whole viewer.
          style: {
            display: 'block',
            flex: '0 0 auto',
          },
        },
        children,
      )
    }

    const Icons = {
      images: (props) => h(Icon, props, h('rect', { x: 1.9, y: 2.9, width: 12.2, height: 10.2, rx: 1.6 }), h('circle', { cx: 6, cy: 6.6, r: 1.15 }), h('path', { d: 'M2.4 11.6 6 8.4l2.6 2.3 2-1.7 3 2.6' })),
      expand: (props) => h(Icon, props, h('path', { d: 'M6 2.2H2.2V6' }), h('path', { d: 'M10 13.8h3.8V10' }), h('path', { d: 'M13.8 6V2.2H10' }), h('path', { d: 'M2.2 10v3.8H6' })),
      close: (props) => h(Icon, props, h('path', { d: 'M3.5 3.5l9 9M12.5 3.5l-9 9' })),
      chevronLeft: (props) => h(Icon, props, h('path', { d: 'M10 3.5 5.5 8l4.5 4.5' })),
      chevronRight: (props) => h(Icon, props, h('path', { d: 'M6 3.5 10.5 8 6 12.5' })),
      chevronUp: (props) => h(Icon, props, h('path', { d: 'M3.5 10 8 5.5l4.5 4.5' })),
      chevronDown: (props) => h(Icon, props, h('path', { d: 'M3.5 6 8 10.5 12.5 6' })),
      upDown: (props) => h(Icon, props, h('path', { d: 'M5.5 2.8v10.4M5.5 2.8 3.2 5.1M5.5 2.8l2.3 2.3' }), h('path', { d: 'M10.5 13.2V2.8M10.5 13.2l-2.3-2.3M10.5 13.2l2.3-2.3' })),
      leftRight: (props) => h(Icon, props, h('path', { d: 'M2.8 5.5h10.4M2.8 5.5l2.3-2.3M2.8 5.5l2.3 2.3' }), h('path', { d: 'M13.2 10.5H2.8M13.2 10.5l-2.3-2.3M13.2 10.5l2.3 2.3' })),
    }
    //#endregion

    /** Wire tool name this view owns; the host half registers the same name. */
    const TOOL_NAME = 'view_images'
    /** Locale namespace: the composer/dictionary the Tool call rows already bind. */
    const CONVERSATION_NS = 'conversation'
    /** Inline thumbnails per row in the chat card. */
    const THUMBNAIL_COLUMNS = 4
    /** Wheel deltas below this are trackpad noise, not a page gesture. */
    const WHEEL_THRESHOLD = 4
    /** How long one wheel gesture owns the pager before the next flip. */
    const WHEEL_LOCK_MS = 180
    /** Scales the zoom buttons step by. */
    const ZOOM_RATIO = 1.25
    const MIN_SCALE = 0.1
    const MAX_SCALE = 8

    /** Page sizes the toolbar and the settings panel both offer. */
    const PAGE_SIZES = [1, 2, 3, 4, 6]

    /** Where this plugin's own preferences live; never read by anything else. */
    const SETTINGS_KEY = 'dsh-image-compare:settings'

    /** Only these four keys are user-settable, and each carries its own bounds. */
    const SETTINGS_SCHEMA = {
      defaultScale: { min: MIN_SCALE, max: MAX_SCALE, fallback: 1 },
      pageSize: { values: PAGE_SIZES, fallback: 2 },
      showFilmstrip: { boolean: true, fallback: true },
      viewerFontSize: { min: 10, max: 20, fallback: 13 },
      /**
       * One image's MINIMUM box height, as a share of the viewport: a floor, not a size.
       * Panes share the rest, so this only decides how small an image may get (and how
       * many of them fit before the pager scrolls instead of shrinking further).
       */
      paneHeightVh: { min: 8, max: 40, fallback: 12 },
    }

    /** Pointer travel that turns a middle press into a drag rather than a click. */
    const DRAG_SLOP = 3

    /**
     * Whether the pan gesture that just ended actually moved.
     *
     * Module-scoped on purpose: it has to survive a pane being re-created mid-gesture
     * (React keys panes by attachment AND position), which a per-component ref cannot.
     * Only the middle button writes it and only the trailing click reads it.
     */
    const lastDragRef = { current: false }

    /**
     * The plugin's preferences.
     *
     * The Client exposes no key/value preference service (`theme.setFontSize` owns
     * the global `--dsh-content-font-size`, which is DSH's own setting, not ours), so
     * this store owns its keys in `localStorage` and falls back to memory whenever
     * storage is unavailable — private mode or a quota rejection must not break the UI.
     */
    let settingsCache

    /** The live preferences, read from storage once and validated on the way in. */
    function readSettings() {
      if (settingsCache !== undefined) return settingsCache
      let stored
      try {
        const raw = window.localStorage?.getItem(SETTINGS_KEY)
        stored = raw === null || raw === undefined ? undefined : JSON.parse(raw)
      } catch {
        stored = undefined
      }
      settingsCache = sanitizeSettings(stored, settingsDefaults())
      return settingsCache
    }

    /** Keep only known keys and only values inside their declared bounds. */
    function sanitizeSettings(input, defaults) {
      const next = { ...defaults }
      if (input === null || typeof input !== 'object') return next
      for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
        const value = input[key]
        if (rule.values !== undefined) {
          if (rule.values.includes(value)) next[key] = value
          continue
        }
        if (rule.boolean === true) {
          if (typeof value === 'boolean') next[key] = value
          continue
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
          next[key] = Math.max(rule.min, Math.min(rule.max, value))
        }
      }
      return next
    }

    const settingsListeners = new Set()

    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => {
        settingsListeners.delete(listener)
      }
    }

    /** Stable snapshot identity: the cache object only changes when settings change. */
    function settingsSnapshot() {
      return readSettings()
    }

    /** Merge one patch into the preferences, persist it, and notify subscribers. */
    function updateSettings(patch) {
      const merged = { ...readSettings(), ...patch }
      settingsCache = sanitizeSettings(merged, settingsDefaults())
      try {
        window.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settingsCache))
      } catch {
        // Storage is unavailable: the in-memory value still applies for this page.
      }
      for (const listener of [...settingsListeners]) listener()
      return settingsCache
    }

    /** The declared defaults, as a plain object (sanitizing input is not). */
    function settingsDefaults() {
      return Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([key, rule]) => [key, rule.fallback]))
    }

    /** Subscribe one component to the plugin's preferences. */
    function useSettings() {
      return useSyncExternalStore(subscribeSettings, settingsSnapshot)
    }

    /**
     * Drop the cached preferences so the next read re-consults storage.
     *
     * The module-level cache is what makes the snapshot stable across a page's
     * lifetime, so it is intentionally never re-read on its own; this exists for
     * tests that simulate "another page wrote different settings".
     */
    function clearSettingsCache() {
      settingsCache = undefined
    }

    /** Browser-strip height bounds, in px: enough for a few rows, never the whole column. */
    const MIN_BROWSER_HEIGHT = 120
    const MAX_BROWSER_HEIGHT = 900

    //#region styles
    const CSS = `
.dshiv-card{border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);overflow:hidden;margin:2px 0}
.dshiv-cardHead{display:flex;align-items:center;gap:8px;padding:8px 10px;min-height:32px}
.dshiv-cardIcon{display:inline-flex;align-items:center;flex:none;height:16px;width:16px;color:var(--dsw-alias-label-secondary)}
.dshiv-cardIcon>svg{max-width:14px;max-height:14px;width:auto;height:auto;flex:none}
.dshiv-cardTitle{font-size:13px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshiv-cardMeta{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;font-variant-numeric:tabular-nums}
.dshiv-grid{display:grid;gap:6px;padding:0 10px 10px}
.dshiv-thumb{position:relative;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);overflow:hidden;padding:0;cursor:zoom-in;min-height:56px}
.dshiv-thumb img{display:block;max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain}
.dshiv-thumbStatus{font-size:11px;color:var(--dsw-alias-label-secondary);padding:8px}
.dshiv-thumbBadge{position:absolute;left:0;right:0;bottom:0;font-size:10px;line-height:1.5;padding:1px 4px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 82%, transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.dshiv-open{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-primary);background:transparent;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:3px 8px;cursor:pointer;flex:none;height:24px;box-sizing:border-box}
.dshiv-open>svg{max-width:13px;max-height:13px;width:auto;height:auto;flex:none}
.dshiv-open:hover{background:var(--dsw-alias-bg-layer-2)}
.dshiv-note{font-size:11px;color:var(--dsw-alias-state-warn-primary);padding:0 10px 8px}
.dshiv-root{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:13px}
/* Embedded shell: the same pager inside the right column instead of a floating
   layer. No fixed positioning and no stacking context of its own, so the column
   owns geometry and every control stays clickable. */
.dshiv-panel{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}
.dshiv-panelWrap{display:flex;flex-direction:column;width:100%;height:100%;min-height:0}
.dshiv-panelImage{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
/* Images and their captions are inert to the pointer: a gesture over them can never
   start a NATIVE image drag (whose transfer advertises Files, which the attachment
   drop zone accepts). Reordering is driven by the handle, which stays interactive. */
.dshiv-panelImage .dshiv-fit img,
.dshiv-panelImage .dshiv-canvas img,
.dshiv-panelImage .dshiv-fitName,
.dshiv-panelImage .dshiv-fitNameOverlay,
.dshiv-panelImage .dshiv-fitStatus{pointer-events:none}
/* The project browser strip: its height comes from the panel's own drag state, so
   the divider below the image area can be pulled to any size the user wants. */
.dshiv-panelWrap>.dshiv-pickerHost{flex:none;min-height:0;display:flex;flex-direction:column;border-top:0.5px solid var(--dsw-alias-border-l1)}
.dshiv-pickerHost>.dshiv-picker{flex:1;min-height:0}
.dshiv-resizer{flex:none;height:7px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;background:transparent}
.dshiv-resizer:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.dshiv-resizerGrip{width:34px;height:2px;border-radius:1px;background:var(--dsw-alias-border-l2)}
.dshiv-resizer:hover .dshiv-resizerGrip{background:var(--dsw-alias-brand-primary)}
.dshiv-panelTools{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex:none}
.dshiv-panelWrap>.dshiv-panel{flex:1;min-height:0}
/* Workspace image picker: browse a directory, tick images, open them. */
.dshiv-picker{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1)}
/* Diagnostics: what the client context actually exposed, shown small and grey. */
.dshiv-diag{padding:6px 10px;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);border-top:0.5px solid var(--dsw-alias-border-l1);word-break:break-all;flex:none}
.dshiv-diagLine{cursor:text;padding:0;font-size:11px}
/* Chosen-directory row: the native picker is the only directory capability this
   deployment composes, so the path is surfaced as copyable text. */
/* Open queue: rows are edited by selection in the browser, reorderable by drag or
   by the ↑/↓ buttons, and only 「打开」 publishes them to the viewer. */
.dshiv-queue{flex:none;max-height:32%;overflow:auto;padding:4px 6px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshiv-queue[data-open="false"]{display:none}
.dshiv-queueEmpty{padding:4px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshiv-queueRow{display:flex;align-items:center;gap:4px;padding:2px 4px;font-size:11px;line-height:1.5;border-radius:var(--dsw-radius-sm,6px)}
.dshiv-queueRow:hover{background:var(--dsw-alias-bg-layer-1)}
.dshiv-queueIndex{flex:none;width:14px;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshiv-queueName{flex:none;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dshiv-queuePath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;color:var(--dsw-alias-label-secondary)}
.dshiv-fitNameOverlay{position:absolute;left:8px;bottom:6px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent);border-radius:4px;padding:1px 6px}
.dshiv-pickerBar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex:none}
.dshiv-pickerPath{flex:1;min-width:0;height:26px;box-sizing:border-box;font-size:12px;padding:2px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px)}
.dshiv-pickerList{flex:1;min-height:0;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:2px}
.dshiv-pickerItem{display:flex;align-items:center;gap:8px;padding:5px 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer}
.dshiv-pickerItem:hover{background:var(--dsw-alias-bg-layer-2)}
.dshiv-pickerItem[data-chosen="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent)}
.dshiv-pickerCheck{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;font-size:11px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:3px}
.dshiv-pickerName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshiv-panelEmpty{display:flex;align-items:center;justify-content:center;height:100%;padding:20px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshiv-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);flex:none;flex-wrap:wrap}
/* Every icon-bearing seat is a flex row, so an icon never inherits a stretch
   line, and a hard cap keeps a stray stylesheet from resizing one. */
.dshiv-bar button{display:inline-flex;align-items:center;gap:4px;height:26px;box-sizing:border-box;line-height:1;flex:none}
.dshiv-bar button>svg{max-width:16px;max-height:16px;width:auto;height:auto;flex:none}
.dshiv-barTitle{font-size:13px;font-weight:500;margin-right:4px;max-width:32vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.dshiv-spacer{flex:1}
.dshiv-seg{display:inline-flex;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);overflow:hidden}
.dshiv-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:3px 9px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.dshiv-seg button+button{border-left:0.5px solid var(--dsw-alias-border-l2)}
/* The zoom row scopes everything to ONE image, so it reads as its own strip. */
.dshiv-zoombar{display:flex;align-items:center;gap:6px;padding:5px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none;flex-wrap:wrap}
.dshiv-zoombar button{display:inline-flex;align-items:center;gap:4px;height:24px;box-sizing:border-box;line-height:1;flex:none}
.dshiv-zoombar button>svg{max-width:15px;max-height:15px;width:auto;height:auto;flex:none}
.dshiv-zoombar .dshiv-zoom{min-width:46px}
.dshiv-settings{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}
.dshiv-setRow{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-primary);padding:2px 0;cursor:pointer}
.dshiv-setLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshiv-setNum{flex:none;height:24px;box-sizing:border-box;font-size:12px;padding:2px 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);min-width:72px}
/* The viewer's own text scale: set per instance from the plugin's settings. */
.dshiv-root,.dshiv-panel{font-size:var(--dshiv-font-size,13px)}
.dshiv-fitName,.dshiv-filmIndex{font-size:calc(var(--dshiv-font-size,13px) - 2px)}
.dshiv-cardMeta,.dshiv-zoom{font-size:calc(var(--dshiv-font-size,13px) - 1px)}
.dshiv-setRow,.dshiv-setNum,.dshiv-fitStatus{font-size:calc(var(--dshiv-font-size,13px) - 1px)}
.dshiv-filmItem[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1.5px var(--dsw-alias-brand-primary)}
.dshiv-seg button[data-active="true"]{background:var(--dsw-alias-brand-primary);color:#fff}
.dshiv-btn{display:inline-flex;align-items:center;gap:4px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm,6px);font-size:12px;padding:3px 8px;cursor:pointer}
.dshiv-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshiv-btn:disabled{opacity:.4;cursor:default}
.dshiv-btnIcon{padding:3px 6px}
.dshiv-zoom{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
.dshiv-pager{flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.dshiv-pager[data-axis="vertical"]{scroll-snap-type:y mandatory}
.dshiv-pager[data-axis="horizontal"]{scroll-snap-type:x mandatory;display:flex;flex-direction:row}
.dshiv-pager[data-zoomed="true"]{scroll-snap-type:none}
.dshiv-page{position:relative;display:flex;box-sizing:border-box;scroll-snap-align:start;scroll-snap-stop:always;flex:none;padding:16px;gap:16px}
/* A page is ONE container tall, but only as a floor: height:100% would clip a page whose
   content still ends up taller (an image with a long caption, a very crowded page), and a
   clipped page is what makes an image unreachable. min-height keeps the "one page = one
   screen" geometry the paging math relies on while letting such a page grow and scroll. */
.dshiv-pager[data-axis="vertical"] .dshiv-page{min-height:100%;width:100%}
.dshiv-pager[data-axis="horizontal"] .dshiv-page{width:100%;min-height:100%}
.dshiv-page[data-zoomed="true"]{scroll-snap-align:none}
.dshiv-pad{display:flex;align-items:center;justify-content:center;min-width:0;max-width:100%;min-height:0;flex:1;gap:16px}
/* Per-pane zoom: each image owns its own fit/canvas shell, so the page no longer
   flips as a whole — a zoomed pane keeps the SAME outer box and only its inside
   switches to the scrollable canvas.
   The panes SHARE the available space (flex 1 1 0) rather than each claiming a fixed
   slice: two fixed 44vh boxes inside a shorter pager overflow it and stack on top of
   each other, which is exactly the overlap this replaces. min-height is the knob — it
   stops a pane collapsing to nothing when a page holds many images, while a short
   viewport still shrinks the pane instead of overlapping its neighbour. */
.dshiv-pane{position:relative;display:flex;flex-direction:column;min-width:0;max-width:100%;min-height:0;flex:1 1 0}
/* One page is exactly one container tall, so the panes on it have to SHARE that height.
   A fixed floor (12vh each) does not survive a narrow window: four panes then want 48vh
   plus gaps plus padding, the page overflows, and every scroll offset stops being a whole
   multiple of the container — which is what pushed the first image up out of view. The
   floor is therefore capped by an even share of the space: the user's value is an upper
   bound that yields to a crowded page, never a floor that overflows one. */
.dshiv-pager[data-axis="vertical"] .dshiv-pane{min-height:min(var(--dshiv-pane-min,120px), calc(88% / var(--dshiv-pane-n,1)))}
.dshiv-pager[data-axis="horizontal"] .dshiv-pane{min-width:min(var(--dshiv-pane-min,120px), calc(88% / var(--dshiv-pane-n,1)))}
.dshiv-pane>.dshiv-pad{display:none}
.dshiv-pane[data-zoomed="true"]>.dshiv-fit{display:none}
.dshiv-pane[data-active="true"]{outline:1.5px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm,6px)}
.dshiv-fit{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:0;min-height:0;flex:1;gap:8px}
.dshiv-fit img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:var(--dsw-radius-sm,6px);box-shadow:0 2px 12px rgba(0,0,0,.18)}
.dshiv-fitName{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshiv-fitStatus{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:12px}
.dshiv-fitError{color:var(--dsw-alias-state-error-primary)}
/* The scroll box carries the breathing room, NOT the content. Padding here sits OUTSIDE the
   scrollbar, so a magnified image keeps the same gutter the fitted view has and the bars no
   longer clamp onto the picture's own edge. box-sizing keeps that padding from inflating the
   frame, which matters because the pane measures this box for its zoom reference.
   The value is generous on purpose: a bar or two of pixels reads as "still touching", which
   is exactly how this looked when it was 6px. */
.dshiv-canvas{width:100%;max-width:100%;min-width:0;height:100%;max-height:100%;min-height:0;overflow:auto;display:block;scrollbar-width:thin;cursor:grab;flex:1 1 auto;box-sizing:border-box;padding:12px}
/* A scroll frame must be narrower than its content by construction, or there is nothing to
   scroll. Every flex item above it hands its content's width up as its own automatic
   minimum size, so the whole chain — page, pad, pane, canvas — pins min-width to 0 and
   caps max-width at 100%. One missing link stretches the frame to the width of the zoomed
   image, and the pan range collapses to the scrollbar's own size. */
.dshiv-page,.dshiv-pad,.dshiv-pane,.dshiv-canvas{min-width:0;max-width:100%}
.dshiv-canvas[data-panning="true"]{cursor:grabbing}
/* One rule per concern: the box says how the image is laid out inside it, the rule below
   says how the image itself is sized. */
.dshiv-canvasInner{display:flex;align-items:center;justify-content:center;width:max-content;min-width:100%;min-height:100%}
/* The zoomed image is sized by the zoom alone, and must NOT be squeezed by the frame.
   As a flex item its flex-shrink defaults to 1, which quietly compresses it back to the
   canvas width — the image then looks magnified in the readout while its scroll range
   (and so the panning distance) never grows. flex:none keeps the declared size, and the
   100% floor keeps a small upscale filling the frame so there is something to pan against. */
.dshiv-canvasInner img{display:block;image-rendering:auto;border-radius:var(--dsw-radius-sm,6px);flex:none;max-width:none;max-height:none;min-width:100%;min-height:100%;object-fit:contain}
/* Safe centring is load-bearing, not cosmetic: a plain centre in a flex container whose
   content is WIDER than it puts the overflow on BOTH sides, and the leading side then
   sits at a negative offset no scrollbar can reach — the classic "cannot scroll the image
   fully to the right" of a zoomed view. The safe keyword falls back to start alignment as
   soon as the content overflows, so every part of the image is reachable. */
.dshiv-canvasInner{justify-content:safe center;align-items:safe center}
.dshiv-film{flex:none;display:flex;gap:6px;align-items:center;padding:6px 10px;border-top:0.5px solid var(--dsw-alias-border-l1);overflow-x:auto;scrollbar-width:thin}
.dshiv-filmItem{position:relative;width:52px;height:40px;flex:none;padding:0;border:1.5px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);overflow:hidden;cursor:grab}
.dshiv-filmItem:active{cursor:grabbing}
.dshiv-filmItem img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.dshiv-filmItem[data-active="true"]{border-color:var(--dsw-alias-brand-primary)}
.dshiv-filmItem[data-dragging="true"]{opacity:0.4}
.dshiv-filmIndex{position:absolute;left:2px;bottom:1px;font-size:9px;color:#fff;text-shadow:0 0 3px rgba(0,0,0,.9)}
.dshiv-filmItem[data-dragging="true"]::after{content:'';position:absolute;inset:0;border-radius:var(--dsw-radius-sm,6px);box-shadow:inset 0 0 0 1.5px var(--dsw-alias-brand-primary)}
.dshiv-empty{padding:40px;text-align:center;color:var(--dsw-alias-label-secondary)}
`
    //#endregion

    //#region image plumbing

    /** The file base name of a path spelled with either separator. */
    function baseNameOf(path) {
      const normalized = String(path).replaceAll('\\', '/')
      return normalized.slice(normalized.lastIndexOf('/') + 1)
    }

    /** Narrow one wire image reference defensively; replay may carry anything. */
    function narrowRef(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
      const { attachmentId, mediaType, bytes, width, height, name, originalDimensions } = value
      if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
      if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) return undefined
      return {
        attachmentId,
        mediaType,
        ...(typeof bytes === 'number' ? { bytes } : {}),
        ...(typeof width === 'number' ? { width } : {}),
        ...(typeof height === 'number' ? { height } : {}),
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof originalDimensions === 'object' && originalDimensions !== null
          ? {
              originalDimensions: {
                width: Number(originalDimensions.width) || 0,
                height: Number(originalDimensions.height) || 0,
              },
            }
          : {}),
      }
    }

    /** Composed viewer model: one entry per opened image, in viewer order. */
    function fromPayload(payload) {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
      const rawImages = Array.isArray(payload.images) ? payload.images : undefined
      if (rawImages === undefined) return undefined
      const items = []
      for (const entry of rawImages) {
        if (typeof entry !== 'object' || entry === null) continue
        const ref = narrowRef(entry.image ?? entry)
        if (ref === undefined) continue
        const path = typeof entry.path === 'string' ? entry.path : (ref.name ?? ref.attachmentId)
        items.push({
          path,
          name: typeof entry.label === 'string' && entry.label !== '' ? entry.label : (ref.name ?? baseNameOf(path)),
          ref,
        })
      }
      if (items.length === 0) return undefined
      const rawPageSize = Number(payload.pageSize)
      const pageSize = Number.isInteger(rawPageSize) && rawPageSize >= 1 && rawPageSize <= 6 ? rawPageSize : 2
      return {
        title: typeof payload.title === 'string' && payload.title !== '' ? payload.title : undefined,
        layout: payload.layout === 'horizontal' ? 'horizontal' : 'vertical',
        pageSize,
        items,
        failures: Array.isArray(payload.failures)
          ? payload.failures
              .filter((entry) => typeof entry === 'object' && entry !== null)
              .map((entry) => ({ path: String(entry.path ?? ''), reason: String(entry.reason ?? '') }))
          : [],
      }
    }

    /**
     * Viewer model of one settled `view_images` call.
     *
     * Sources, in order:
     *   1. `block.meta.viewImages` — this tool's `output.presentationMeta`, the
     *      framework's own channel for presentation data (the read-file card reads
     *      `block.meta` the same way). It carries the full reference list with no
     *      bytes and no conversation tokens.
     *   2. `block.value` / `block.result.value` — replay of older logs.
     *   3. `block.content` image blocks — the generic path: whatever image blocks
     *      the result carries still render, so a future meta shape change degrades
     *      to "images without captions" instead of "nothing to show".
     */
    function parseViewerResult(block) {
      if (typeof block !== 'object' || block === null) return undefined
      const meta = block.meta
      const fromMeta =
        typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? fromPayload(meta.viewImages) : undefined
      if (fromMeta !== undefined) return fromMeta
      const fromValue = fromPayload(block.value ?? block.result?.value ?? block.result)
      if (fromValue !== undefined) return fromValue
      const content = Array.isArray(block.content) ? block.content : []
      const images = []
      for (const part of content) {
        if (typeof part !== 'object' || part === null || part.type !== 'image') continue
        const ref = narrowRef(part.attachment)
        if (ref !== undefined) images.push(ref)
      }
      return images.length === 0 ? undefined : fromPayload({ images, layout: 'vertical', pageSize: 2 })
    }

    /**
     * Resolve one durable reference to a browser URL, memoized per loader.
     * A rejection releases its cache entry, so a later render retries; `retry`
     * drops an entry up front.
     */
    function createImageResolver(load, peek) {
      const cache = new Map()
      const resolve = (ref) => {
        const key = ref.attachmentId
        const cached = cache.get(key)
        if (cached !== undefined) return cached
        if (typeof peek === 'function') {
          const ready = peek(ref)
          if (typeof ready === 'string' && ready !== '') {
            const settled = Promise.resolve(ready)
            cache.set(key, settled)
            return settled
          }
        }
        const pending = Promise.resolve()
          .then(() => load(ref))
          .then((url) => {
            if (typeof url !== 'string' || url === '') throw new Error('image loader returned no URL')
            return url
          })
          .catch((error) => {
            if (cache.get(key) === pending) cache.delete(key)
            throw error
          })
        cache.set(key, pending)
        return pending
      }
      resolve.retry = (ref) => cache.delete(ref.attachmentId)
      return resolve
    }

    /**
     * Load one image URL for display, tracking its ready/failed state.
     * Bumping the returned retry callback re-runs the load once.
     */
    function useImageUrl(resolve, ref) {
      const [url, setUrl] = useState(null)
      const [failed, setFailed] = useState(false)
      const [attempt, setAttempt] = useState(0)
      // Depend on the stable attachment identity, never on the reference object:
      // the card rebuilds those objects on every render, so an object dependency
      // would re-run the effect forever.
      const refKey = ref === undefined ? '' : ref.attachmentId
      useEffect(() => {
        if (ref === undefined) return undefined
        let live = true
        setFailed(false)
        Promise.resolve()
          .then(() => resolve(ref))
          .then(
            (value) => {
              if (live) setUrl(value)
            },
            () => {
              if (live) setFailed(true)
            },
          )
        return () => {
          live = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [resolve, refKey, attempt])
      const retry = useCallback(() => {
        if (ref !== undefined) resolve.retry?.(ref)
        setAttempt((value) => value + 1)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [resolve, refKey])
      return { url, failed, retry }
    }

    //#endregion

    //#region shared viewer state

    /**
     * The images each SESSION's panel is showing, plus the loader for them.
     *
     * Keyed by session on purpose: the client half is one instance per page, so a
     * single shared slot would leak one conversation's images into every other
     * conversation's panel. With a per-session slot, switching conversations shows
     * that conversation's own set — empty until something is opened there.
     *
     * The card and the panel remain two views of one set: whichever entry opened the
     * viewer publishes into its session's slot, and that session's panel follows.
     */
    const viewerStates = new Map()

    /** The empty slot every session starts on. Frozen so identity is stable. */
    const EMPTY_VIEWER_STATE = Object.freeze({ viewer: undefined, resolve: undefined })

    /** Listeners for every session; the snapshot getter filters by key. */
    const viewerListeners = new Set()

    /** The session key used when a publisher has no session (a Tool card, say). */
    const DEFAULT_SESSION_KEY = '*'

    /** The slot one session is showing, or the shared empty slot. */
    function viewerStateOf(sessionKey) {
      return viewerStates.get(sessionKey ?? DEFAULT_SESSION_KEY) ?? EMPTY_VIEWER_STATE
    }

    /** Publish the set one session's panel should show. */
    function setViewerState(next, sessionKey) {
      viewerStates.set(sessionKey ?? DEFAULT_SESSION_KEY, next)
      for (const listener of [...viewerListeners]) listener()
    }

    // Stable identities: useSyncExternalStore resubscribes whenever either function
    // identity changes, so per-session getters are cached rather than recreated.
    function subscribeViewerState(listener) {
      viewerListeners.add(listener)
      return () => {
        viewerListeners.delete(listener)
      }
    }

    const viewerSnapshotGetters = new Map()

    function viewerStateSnapshotFor(sessionKey) {
      const key = sessionKey ?? DEFAULT_SESSION_KEY
      const cached = viewerSnapshotGetters.get(key)
      if (cached !== undefined) return cached
      const getter = () => viewerStateOf(key)
      viewerSnapshotGetters.set(key, getter)
      return getter
    }

    /** Subscribe one component to ONE session's viewer state. */
    function useViewerState(sessionKey) {
      return React.useSyncExternalStore(subscribeViewerState, viewerStateSnapshotFor(sessionKey))
    }

    //#endregion

    //#region chat card

    /** One thumbnail: lazy, self-contained, never fatal. */
    function Thumb({ resolve, item, index, onOpen }) {
      const { url, failed } = useImageUrl(resolve, item.ref)
      return h(
        'button',
        {
          type: 'button',
          className: 'dshiv-thumb',
          title: item.path,
          'aria-label': `打开看图器查看 ${item.name}`,
          onClick: () => onOpen(index),
        },
        url === null
          ? h('span', { className: 'dshiv-thumbStatus' }, failed ? '加载失败' : '加载中…')
          : h('img', { src: url, alt: item.name, loading: 'lazy', decoding: 'async' }),
        h('span', { className: 'dshiv-thumbBadge' }, `${index + 1}. ${item.name}`),
      )
    }

    /** The `view_images` chat card: what was opened, plus the viewer entry point. */
    function ImagesCard(props) {
      const { block, loadImage } = props
      const viewer = useMemo(() => parseViewerResult(block), [block])
      const [open, setOpen] = useState(false)
      const [startPage, setStartPage] = useState(0)
      /**
       * The set this card and its floating shell render.
       *
       * The floating shell renders from THIS component, not from the session slot, so a
       * filmstrip reorder in full screen has to move local state as well as publish —
       * otherwise the gesture is silently dropped.
       */
      const [shown, setShown] = useState(null)
      const resolve = useMemo(
        () => createImageResolver(loadImage, typeof loadImage?.peek === 'function' ? loadImage.peek : undefined),
        [loadImage],
      )
      const active = shown ?? viewer
      const pageSize = active?.pageSize ?? 2
      const pageCount = active === undefined ? 0 : Math.max(1, Math.ceil(active.items.length / pageSize))
      if (active === undefined) {
        return h(
          'div',
          { className: 'dshiv-card' },
          h('div', { className: 'dshiv-cardHead' }, h('span', { className: 'dshiv-cardTitle' }, '图片查看器')),
          h('div', { className: 'dshiv-note' }, '这次调用的图片结果无法解析。'),
        )
      }
      const openAt = (index) => {
        setStartPage(Math.floor(index / pageSize))
        setOpen(true)
      }
      /**
       * Show the set in the right column.
       *
       * The shared state is published first, then the column is opened through
       * `ctx.layout.openRightbar` — the one navigation seat the Client Service
       * catalog exposes (`sidebarRight`'s tab navigation is plugin-private). The
       * panel itself is a registered tab type, so a column already showing it just
       * comes forward; the first time, the user picks it once from the column's
       * add control and it stays resident afterwards.
       */
      const openInColumn = () => {
        // Published into THIS conversation's slot: a slot per session is what keeps
        // one conversation's images out of every other conversation's panel.
        setViewerState({ viewer: active, resolve }, block.sessionId ?? props.sessionId)
        if (layoutRef !== undefined) layoutRef.openRightbar(true, false)
      }

      /** Reorder the set from the full-screen shell: local first, then published. */
      const reorderHere = (from, to) => {
        if (from === to || from < 0 || to < 0 || from >= active.items.length || to >= active.items.length) return
        const next = [...active.items]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        const reordered = { ...active, items: next }
        setShown(reordered)
        setViewerState({ viewer: reordered, resolve }, block.sessionId ?? props.sessionId)
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dshiv-card' },
          h(
            'div',
            { className: 'dshiv-cardHead' },
            h('span', { className: 'dshiv-cardIcon' }, h(Icons.images, { size: 14 })),
            h(
              'span',
              { className: 'dshiv-cardTitle' },
              active.title ?? `已打开 ${active.items.length} 张图片`,
            ),
            h(
              'span',
              { className: 'dshiv-cardMeta' },
              `${active.layout === 'horizontal' ? '左右' : '上下'}翻页 · 每页 ${pageSize} 张 · ${pageCount} 页`,
            ),
            h(
              'button',
              { type: 'button', className: 'dshiv-open', onClick: openInColumn, title: '在右侧栏打开（可与文件树并排）' },
              h(Icons.images, { size: 13 }),
              '右侧栏',
            ),
            h(
              'button',
              { type: 'button', className: 'dshiv-open', onClick: () => openAt(0), title: '全屏查看' },
              h(Icons.expand, { size: 13 }),
              '全屏',
            ),
          ),
          h(
            'div',
            {
              className: 'dshiv-grid',
              style: { gridTemplateColumns: `repeat(${Math.min(THUMBNAIL_COLUMNS, active.items.length)}, minmax(0, 1fr))` },
            },
            active.items.map((item, index) =>
              h(Thumb, { key: `${item.ref.attachmentId}:${index}`, resolve, item, index, onOpen: openAt }),
            ),
          ),
          active.failures.length === 0
            ? null
            : h(
                'div',
                { className: 'dshiv-note' },
                `${active.failures.length} 个路径未能打开：${active.failures
                  .map((failure) => `${failure.path}（${failure.reason}）`)
                  .join('；')}`,
              ),
        ),
        open
          ? h(Viewer, {
              viewer: active,
              resolve,
              initialPage: startPage,
              onClose: () => setOpen(false),
              onReorder: reorderHere,
            })
          : null,
      )
    }

    //#endregion

    //#region full-screen viewer

    /**
     * The active pane's geometry, shared with the zoom row.
     *
     * A context rather than another prop on every pane: the caption that measures lives
     * deep in the tree, and only the row wants the number — and the caption's own copy
     * scrolls away with the image, which is exactly when it is needed most.
     */
    const GeometryContext = React.createContext({ geometry: null, report: () => {} })


    /**
     * Where one canvas is looking, as fractions of its scrollable range.
     * @returns `{ x, y }` in 0..1, or null when the node cannot scroll.
     */
    function relativeViewOf(node) {
      if (node === null || node === undefined) return null
      const rangeX = node.scrollWidth - node.clientWidth
      const rangeY = node.scrollHeight - node.clientHeight
      return {
        x: rangeX > 0 ? node.scrollLeft / rangeX : 0.5,
        y: rangeY > 0 ? node.scrollTop / rangeY : 0.5,
      }
    }

    /** The canvas of one pane index, as the DOM sees it. */
    function canvasForPane(index) {
      return document.querySelector(`.dshiv-canvas[data-pane-index="${index}"]`)
    }

    /**
     * What one displayed pixel currently costs, as a zoom factor.
     *
     * A pane's zoom is relative to the FITTED size, not to the image's own pixels, so
     * "100%" (one image pixel per screen pixel) is `naturalWidth / fittedWidth`. The fitted
     * width is the one the pane itself measured and published on its own style, so this
     * works BEFORE anything is magnified — the 100% button is usable from a fitted view.
     *
     * @returns the factor turning the current zoom into 1:1, or null when unmeasurable.
     */
    function scaleToActualPixels(index) {
      const pane = document.querySelector(`.dshiv-pane[data-index="${index}"]`)
      if (pane === null) return null
      const shown = pane.querySelector('.dshiv-canvas img') ?? pane.querySelector('.dshiv-fit img')
      if (shown === null || shown.naturalWidth <= 0) return null
      const fitWidth = Number.parseFloat(pane.style.getPropertyValue('--dshiv-fit-w'))
      if (!Number.isFinite(fitWidth) || fitWidth <= 0) return null
      return shown.naturalWidth / fitWidth
    }

    /**
     * Pull every magnified image onto the source image's relative view, then keep it there.
     *
     * Alignment cannot be a one-shot hand-off to each pane's own layout effect: panes
     * render, decode and re-measure at different moments, so whichever one misses that
     * single frame stays behind — which is exactly how three images end up parked at 0
     * while the first sits at the shared offset. The source is therefore re-read and
     * re-applied over a short window, so every canvas converges no matter when its size
     * settles. A brief poll rather than one deferred call, because "when the layout is
     * ready" is not a moment React can promise.
     *
     * Module-level on purpose: it closes over nothing, so it needs neither a hook nor a
     * position below its callers.
     */
    function alignViewsTo(sourceIndex) {
      /**
       * Cancellation is a FLAG, not just unscheduling.
       *
       * `clearInterval` and `cancelAnimationFrame` cannot retract a callback that is
       * already queued, so a cancelled window would still fire one last `apply()` — and
       * that write lands after whatever replaced it, which is exactly how a stale alignment
       * overwrites a fresh one (or a user's pan). The flag makes "cancelled" final.
       */
      let live = true
      const apply = () => {
        if (!live) return
        const source = canvasForPane(sourceIndex)
        if (source === null) return
        const view = relativeViewOf(source)
        if (view === null) return
        for (const node of document.querySelectorAll('.dshiv-canvas')) {
          if (node === source) continue
          const rangeX = node.scrollWidth - node.clientWidth
          const rangeY = node.scrollHeight - node.clientHeight
          if (rangeX > 0) node.scrollLeft = Math.round(rangeX * view.x)
          if (rangeY > 0) node.scrollTop = Math.round(rangeY * view.y)
        }
      }
      apply()
      const frame = requestAnimationFrame(apply)
      let ticks = 0
      const timer = setInterval(() => {
        apply()
        ticks += 1
        if (ticks >= 6) clearInterval(timer)
      }, 40)
      return () => {
        live = false
        cancelAnimationFrame(frame)
        clearInterval(timer)
      }
    }

    /**
     * The scroll offsets a pan gesture starts from, one entry per canvas.
     *
     * A drag must be applied as `origin + total travel`, not as repeated nudges: an
     * increment applies itself again if a move is ever delivered twice, and the image then
     * outruns the pointer. `all` captures every canvas, which is what Shift+drag needs.
     */
    function panBase(index) {
      const nodes =
        index === null
          ? document.querySelectorAll('.dshiv-canvas')
          : document.querySelectorAll(`.dshiv-canvas[data-pane-index="${index}"]`)
      return [...nodes].map((node) => ({ node, left: node.scrollLeft, top: node.scrollTop }))
    }

    /** Page holding one or more items, laid out on the paging axis. */
    function Page({ resolve, items, pageIndex, pageCount, offset, axis, zoomOf, activeIndex, panMode, anchors, onActivate, onZoomAt, onPanBegin, onPanBeginAll, onPanApply, onAnchorUsed }) {
      return h(
        'div',
        {
          className: 'dshiv-page',
          'data-page': pageIndex,
          'aria-label': `第 ${pageIndex + 1} 页，共 ${pageCount} 页`,
        },
        h(
          'div',
          { className: 'dshiv-pad', style: axis === 'horizontal' ? { flexDirection: 'row' } : { flexDirection: 'column' } },
          items.map((item, index) =>
            h(ImagePane, {
              key: `${item.ref.attachmentId}:${index}`,
              resolve,
              item,
              index: offset + index,
              total: items.length,
              scale: zoomOf(item),
              active: activeIndex === offset + index,
              panMode,
              anchor: anchors.get(offset + index) ?? null,
              onActivate,
              onZoomAt,
              onPanBegin,
              onPanBeginAll,
              onPanApply,
              onAnchorUsed,
            }),
          ),
        ),
      )
    }

    /**
     * One image: its own fitted preview or its own pannable canvas.
     *
     * Zoom lives per image (`scale` arrives from the viewer's per-key map), and the
     * outer box keeps a constant ANCHOR height, so enlarging one image never pushes
     * its neighbours around — the page geometry stays put and only this pane's inside
     * becomes scrollable.
     *
     * Gestures owned here:
     *   - Ctrl/Cmd + wheel zooms this image around the pointer;
     *   - Ctrl/Cmd + Shift + wheel zooms the whole set (handled by the viewer);
     *   - middle-button drag pans this image; with Shift it pans the whole set;
     *   - a plain wheel is left alone so the viewer keeps its one-gesture-one-page flip.
     * The `<img>` itself stays pointer-inert (a native image drag would advertise
     * `Files` and trip the attachment drop zone); the wrapper takes the events.
     */
    function ImagePane({ resolve, item, index, total, scale, active, panMode, anchor, onActivate, onZoomAt, onPanBegin, onPanBeginAll, onPanApply, onAnchorUsed }) {
      const { url, failed, retry } = useImageUrl(resolve, item.ref)
      const [intrinsic, setIntrinsic] = useState(null)
      const [panning, setPanning] = useState(false)
      /**
       * What the last layout pass actually measured, shown in the caption.
       *
       * The scrolling range IS the gesture: `scrollWidth` vs `clientWidth` decides how far
       * a pan can go, and those numbers are invisible in a screenshot otherwise. Reporting
       * them turns a "the drag barely moves" report into something diagnosable from a
       * picture instead of another round of guessing.
       */
      const [measured, setMeasured] = useState(null)
      const canvasRef = useRef(null)
      /** The zoom the previous placement centred for; the layout effect reads it. */
      const zoomRef = useRef(scale)
      /** Tears down an in-flight pan if the pane goes away before the mouse does. */
      const panCleanupRef = useRef(null)
      useEffect(
        () => () => {
          panCleanupRef.current?.()
        },
        [],
      )
      /**
       * The anchor and its acknowledgement, read through refs.
       *
       * The effect below must run on a ZOOM change only — depending on `anchor` or on
       * a freshly created callback would re-run it on unrelated renders, and clearing
       * the anchor re-renders by design.
       */
      const anchorRef = useRef(anchor)
      anchorRef.current = anchor
      const anchorUsedRef = useRef(onAnchorUsed)
      anchorUsedRef.current = onAnchorUsed
      /** The zoom row's geometry sink; a ref so the layout effect never re-subscribes. */
      const geometryRef = useRef(null)
      geometryRef.current = React.useContext(GeometryContext)

      const zoomed = scale > 1.001
      const natural = intrinsic ?? {
        width: item.ref.width ?? 1200,
        height: item.ref.height ?? 800,
      }
      /**
       * The size the image occupies when fitted, measured from the pane's own box.
       *
       * The zoom is relative to THIS, not to the image's natural pixels. Sizing the
       * magnified image as `natural * scale` made 1x mean "one image pixel per screen
       * pixel" while the fitted view was already scaled down to fit — so the first zoom
       * jumped straight to actual pixels instead of continuing from what was on screen.
       * Both branches below go through the same measurement, which is also what keeps the
       * fit → magnified switch visually continuous.
       */
      const fitSizeOf = () => {
        const node = paneRef.current
        if (node === null) return null
        const style = window.getComputedStyle(node)
        const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight)
        const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
        const boxW = node.clientWidth - (Number.isFinite(padX) ? padX : 0)
        const boxH = node.clientHeight - (Number.isFinite(padY) ? padY : 0)
        if (!(boxW > 0) || !(boxH > 0)) return null
        const ratio = natural.width > 0 && natural.height > 0 ? natural.height / natural.width : 0.75
        // Contain, so whichever axis runs out first decides the fitted size.
        const shownW = Math.min(boxW, boxH / ratio)
        return { width: shownW, height: shownW * ratio }
      }
      const [fitSize, setFitSize] = useState(null)
      useEffect(() => {
        const node = paneRef.current
        if (node === null) return undefined
        const measure = () => setFitSize(fitSizeOf())
        measure()
        // A pane's box changes when the window, the split, or the page size changes, and
        // the zoom reference has to follow it — a stale fitted width makes every later
        // zoom land at the wrong size. The window listener also covers the case where the
        // observer is unavailable, since the pane's size is driven by the window here.
        window.addEventListener('resize', measure)
        // Guarded because the observer is an addition, not the measurement itself: without
        // it the pane still measures on mount and on every resize, and it must never be the
        // reason a viewer fails to render at all.
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        observer?.observe(node)
        return () => {
          window.removeEventListener('resize', measure)
          observer?.disconnect()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [natural.width, natural.height])
      /**
       * The magnified size, in CSS pixels on screen, as `fitted * scale`.
       *
       * Falls back to the natural size only until the first measurement lands; that is one
       * frame at most, and it keeps a zoom the user asked for from being dropped on the
       * floor if the pane has not been laid out yet.
       */
      const width = zoomed
        ? Math.max(1, Math.round((fitSize?.width ?? natural.width) * scale))
        : undefined
      const height = zoomed
        ? Math.max(1, Math.round((fitSize?.height ?? natural.height) * scale))
        : undefined
      // Published for `scaleToActualPixels`, which needs the same reference point.
      const paneStyle = fitSize === null ? undefined : { '--dshiv-fit-w': `${fitSize.width}px` }

      /**
       * Place the scroll box for the new zoom.
       *
       * A pointer anchor wins (Ctrl+wheel zooms into the pixel under the cursor); with
       * no anchor the visible centre is preserved, so a button zoom keeps looking at
       * the same detail instead of jumping to a corner. Nothing here runs for a pan:
       * panning writes `scrollLeft/Top` directly and never changes this zoom value.
       */
      useLayoutEffect(() => {
        const previous = zoomRef.current
        zoomRef.current = scale
        if (!zoomed) {
          setMeasured(null)
          return undefined
        }
        const node = canvasRef.current
        if (node === null) return undefined
        const pointer = anchorRef.current
        const record = () => {
          const image = node.querySelector('img')
          const next = {
            box: node.clientWidth,
            wide: node.scrollWidth,
            tall: node.scrollHeight,
            high: node.clientHeight,
            image: image === null ? 0 : Math.round(image.getBoundingClientRect().width),
          }
          setMeasured((current) =>
            current !== null &&
            current.box === next.box &&
            current.wide === next.wide &&
            current.image === next.image
              ? current
              : next,
          )
          geometryRef.current?.report(index, next)
        }
        const frame = requestAnimationFrame(() => {
          record()
          if (pointer !== null && pointer !== undefined) {
            const ratio = previous > 1.001 ? scale / previous : 1
            node.scrollLeft = Math.max(0, previous <= 1.001
              ? (node.scrollWidth - node.clientWidth) * pointer.x
              : (node.scrollLeft + pointer.x * node.clientWidth) * ratio - pointer.x * node.clientWidth)
            node.scrollTop = Math.max(0, previous <= 1.001
              ? (node.scrollHeight - node.clientHeight) * pointer.y
              : (node.scrollTop + pointer.y * node.clientHeight) * ratio - pointer.y * node.clientHeight)
            anchorUsedRef.current?.(index)
            return
          }
          if (previous === scale) return
          if (previous <= 1.001) {
            node.scrollLeft = Math.max(0, (node.scrollWidth - node.clientWidth) / 2)
            node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) / 2)
            return
          }
          const ratio = scale / previous
          node.scrollLeft = Math.max(0, node.scrollLeft * ratio)
          node.scrollTop = Math.max(0, node.scrollTop * ratio)
        })
        return () => cancelAnimationFrame(frame)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [zoomed, scale, url])

      /** Wheel deltas arrive in three units; normalise before judging magnitude. */
      const wheelPixels = (event) => {
        const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight || 400 : 1
        return { x: event.deltaX * factor, y: event.deltaY * factor }
      }

      /**
       * Ctrl/Cmd + wheel zooms this image; +Shift zooms the whole set.
       *
       * Registered natively with `passive: false`, NOT through the `onWheel` prop: React
       * attaches `wheel` passively, so `preventDefault` inside a synthetic handler is
       * ignored (the console says so out loud) and the browser goes on to zoom the whole
       * page and hand the event to the pager. The effect below is what actually installs
       * this, and the ref keeps it on the latest render's props.
       */
      const handleWheel = (event) => {
        if (event.ctrlKey !== true && event.metaKey !== true) return
        const { y } = wheelPixels(event)
        if (y === 0) return
        event.preventDefault()
        event.stopPropagation()
        onActivate(index)
        const factor = y < 0 ? ZOOM_RATIO : 1 / ZOOM_RATIO
        if (event.shiftKey === true) onZoomAt(index, factor, null, true)
        else {
          const rect = event.currentTarget.getBoundingClientRect()
          onZoomAt(index, factor, {
            x: rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5,
            y: rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5,
          })
        }
      }

      /**
       * Middle-button drag pans; with Shift it pans every image at once.
       *
       * The frame's scroll position is recomputed from the PRESS ORIGIN on every move —
       * never nudged by an incremental delta. Increments accumulate: if anything causes a
       * move to be delivered twice (a duplicated listener, a second press, a replayed
       * frame) the image travels further than the pointer and the drag feels like it is
       * accelerating away. Recomputing from a fixed origin is idempotent, so a repeated
       * call is harmless and the image can only ever be where the pointer says.
       *
       * `preventDefault` on every move is what suppresses the browser's own middle-click
       * auto-scroll: once that starts, the view glides on its own after the pointer stops.
       * The wheel is stopped in the capture phase for the duration of the gesture, because
       * an un-zoomed pager turns a wheel event into a whole page flip.
       */
      const handleMouseDown = (event) => {
        // Only the middle button takes part in the pan gesture — including the reset.
        // Clearing it on a LEFT press would re-admit the click that ends a drag, which is
        // exactly the click that must be ignored.
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        onActivate(index)
        const startX = event.clientX
        const startY = event.clientY
        const all = event.shiftKey === true
        const stopWheel = (wheel) => {
          wheel.preventDefault()
          wheel.stopPropagation()
        }
        setPanning(true)
        lastDragRef.current = false
        // The offsets this gesture starts from; every move re-applies them, so the image
        // can only ever sit at (origin + travel) however many events arrive.
        const base = all ? onPanBeginAll() : onPanBegin(index)
        const onMove = (move) => {
          move.preventDefault()
          const dx = move.clientX - startX
          const dy = move.clientY - startY
          // Per-axis travel, so sub-pixel jitter during a "click" is not a drag.
          if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) lastDragRef.current = true
          onPanApply(base, dx, dy)
        }
        const stop = () => {
          setPanning(false)
          if (canvasRef.current !== null) canvasRef.current.removeEventListener('wheel', stopWheel, true)
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', stop)
          window.removeEventListener('blur', stop)
          if (panCleanupRef.current === stop) panCleanupRef.current = null
        }
        // A previous gesture must never survive into this one: a stray listener would keep
        // panning the image after the button is released.
        panCleanupRef.current?.()
        // Remembered so an unmount mid-gesture drops the capture listener: left behind,
        // it would swallow every later wheel over this canvas and kill wheel paging.
        panCleanupRef.current = stop
        // Capture phase: this runs before the pager's own non-passive wheel listener,
        // so stopping here really does keep the drag from paging.
        if (canvasRef.current !== null) canvasRef.current.addEventListener('wheel', stopWheel, true)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', stop)
        window.addEventListener('blur', stop)
      }


      /**
       * A plain left click selects this image (so the zoom row drives it).
       *
       * A middle drag ends with a `click` too. Which click that is, is decided by the
       * POINTER TRAVEL recorded at the last press/release rather than by a flag on this
       * component: a pane can be re-created mid-gesture (React keys its panes by
       * attachment AND position), and a ref would then be handed over as "not dragged".
       */
      const handleClick = () => {
        if (lastDragRef.current) {
          lastDragRef.current = false
          return
        }
        onActivate(index)
      }

      /**
       * Install the wheel listener non-passively, on the PANE.
       *
       * Two reasons it is a native listener here rather than the `onWheel` prop: React
       * attaches `wheel` passively, so `preventDefault` inside a synthetic handler is
       * ignored (the console complains out loud), leaving the browser to zoom the page
       * and the pager to page on the same gesture. And it has to sit on the pane, which
       * always exists — the canvas only exists once the image is ALREADY zoomed, so a
       * listener bound there could never receive the very first zoom wheel.
       */
      const wheelHandlerRef = useRef(handleWheel)
      wheelHandlerRef.current = handleWheel
      const paneRef = useRef(null)
      useEffect(() => {
        const node = paneRef.current
        if (node === null) return undefined
        const listener = (event) => wheelHandlerRef.current(event)
        node.addEventListener('wheel', listener, { passive: false })
        return () => node.removeEventListener('wheel', listener)
      }, [])

      const title = (base) =>
        `${base} · 中键拖动平移${panMode ? '（移动模式）' : ''} · Ctrl+滚轮缩放这张 · Ctrl+Shift+滚轮缩放全部`

      return h(
        'div',
        {
          className: 'dshiv-pane',
          ref: paneRef,
          'data-index': index,
          'data-active': active ? 'true' : 'false',
          'data-zoomed': zoomed ? 'true' : 'false',
          style: paneStyle,
          onMouseDown: handleMouseDown,
          onClick: handleClick,
          onDoubleClick: () => onZoomAt(index, zoomed ? 1 / scale : 1.6, null),
        },
        // Only a zoomed pane has a scroll box: rendering one for every fitted image
        // would create idle scroll containers and make `.dshiv-canvas` stop meaning
        // "this image is zoomed".
        zoomed
          ? h(
              'div',
              {
                className: 'dshiv-canvas',
                ref: canvasRef,
                'data-pane-index': index,
                'data-panning': panning ? 'true' : 'false',
                title: title('中键拖动平移 · 双击回到适应窗口'),
                // Inline, not stylesheet: the frame has to stay the size of its SLOT for
                // anything to scroll inside it. As a flex item its automatic minimum size
                // is the image's, so a nested chain of flex ancestors can hand the content
                // size all the way up and leave the frame exactly as big as the image — no
                // overflow, nothing to pan. Both axes need pinning: capping only the width
                // leaves the frame growing to the image's HEIGHT, which is why a drag moved
                // sideways but not up and down. An inline declaration outranks every
                // selector, which is what makes this independent of that chain.
                style: { width: '100%', maxWidth: '100%', minWidth: 0, height: '100%', maxHeight: '100%', minHeight: 0 },
              },
              h(
                'div',
                { className: 'dshiv-canvasInner' },
                url === null
                  ? h('span', { className: 'dshiv-fitStatus' }, failed ? '图片加载失败' : '加载中…')
                  : h('img', {
                      src: url,
                      alt: item.name,
                      style: {
                        width: `${width}px`,
                        height: height === undefined ? 'auto' : `${height}px`,
                        maxWidth: 'none',
                        maxHeight: 'none',
                      },
                      onLoad: (event) => {
                        const image = event.currentTarget
                        if (image.naturalWidth > 0) setIntrinsic({ width: image.naturalWidth, height: image.naturalHeight })
                      },
                    }),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dshiv-fit', title: title('双击放大') },
          url === null
            ? h(
                'div',
                { className: `dshiv-fitStatus${failed ? ' dshiv-fitError' : ''}` },
                failed ? '图片加载失败' : '加载中…',
                failed ? h('button', { type: 'button', className: 'dshiv-btn', onClick: retry }, '重试') : null,
              )
            : h('img', {
                src: url,
                alt: item.name,
                decoding: 'async',
                style: { maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' },
                onLoad: (event) => {
                  const image = event.currentTarget
                  if (image.naturalWidth > 0) setIntrinsic({ width: image.naturalWidth, height: image.naturalHeight })
                },
              }),
        ),
        h(
          'span',
          {
            className: 'dshiv-fitName dshiv-fitNameOverlay',
            // Live geometry in the tooltip: the frame it renders in versus what it can
            // scroll. A pan can only travel (scrollable - frame) pixels, so hovering the
            // caption explains a short drag without another round of guessing.
            title:
              measured === null
                ? ''
                : `框宽 ${measured.box} · 可滚宽 ${measured.wide} · 图片宽 ${measured.image} · 框高 ${measured.high} · 可滚高 ${measured.tall}`,
          },
          `${index + 1}/${total} · ${item.name}${item.ref.width === undefined ? '' : ` · ${item.ref.width}×${item.ref.height}`}${
            zoomed ? ` · ${Math.round(scale * 100)}%` : ''
          }${
            measured === null ? '' : ` · 框${measured.box}/滚${measured.wide}/图${measured.image}`
          }`,
        ),
      )
    }

    /**
     * This plugin's own preferences, shown inline under the zoom row.
     *
     * Deliberately NOT a DSH settings row: the General section's rows are declared by
     * another package and expect its store/actions contract, and the global font size
     * already has an owner there (`ui-theme`'s 字号 row drives
     * `--dsh-content-font-size`). What this panel owns is viewer-local: the initial
     * zoom, the group size, whether the filmstrip starts open, and the viewer's own
     * text size.
     */
    function SettingsPanel({ settings, onChange, showGeometry }) {
      /** One labelled row; the control is the caller's. */
      const row = (label, hint, control) =>
        h(
          'label',
          { className: 'dshiv-setRow' },
          h('span', { className: 'dshiv-setLabel', title: hint ?? '' }, label),
          control,
        )
      return h(
        'div',
        { className: 'dshiv-settings', role: 'group', 'aria-label': '图片查看器设置' },
        row(
          '默认缩放',
          '打开一组图片时的初始缩放；1 = 适应窗口',
          h('input', {
            type: 'number',
            className: 'dshiv-setNum',
            min: MIN_SCALE,
            max: MAX_SCALE,
            step: 0.25,
            value: settings.defaultScale,
            onChange: (event) => {
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed)) onChange({ defaultScale: parsed })
            },
          }),
        ),
        row(
          '每页张数',
          '与工具栏上的分段按钮同步',
          h(
            'select',
            {
              className: 'dshiv-setNum',
              value: settings.pageSize,
              onChange: (event) => onChange({ pageSize: Number(event.target.value) }),
            },
            PAGE_SIZES.map((count) => h('option', { key: count, value: count }, `${count} 张`)),
          ),
        ),
        row(
          '默认显示缩略图条',
          '打开查看器时是否展开缩略图条（F 键随时切换）',
          h('input', {
            type: 'checkbox',
            checked: settings.showFilmstrip,
            onChange: (event) => onChange({ showFilmstrip: event.target.checked }),
          }),
        ),
        row(
          '查看器字号',
          '只影响图片查看器自身；DSH 设置里的「字号」管的是全局界面文字',
          h('input', {
            type: 'number',
            className: 'dshiv-setNum',
            min: 10,
            max: 20,
            step: 1,
            value: settings.viewerFontSize,
            onChange: (event) => {
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed)) onChange({ viewerFontSize: parsed })
            },
          }),
        ),
        row(
          '单张图片最小高度',
          '每张图至少占窗口的比例（%）。同一页的图片平分剩余空间，空间不足时收缩到不超过这个下限，因此不会互相压叠',
          h('input', {
            type: 'number',
            className: 'dshiv-setNum',
            min: 8,
            max: 40,
            step: 1,
            value: settings.paneHeightVh,
            onChange: (event) => {
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed)) onChange({ paneHeightVh: parsed })
            },
          }),
        ),
        showGeometry ? h(LayoutDiagnostics) : null,
      )
    }

    /**
     * A live dump of the layout numbers behind a pan that "barely moves".
     *
     * Read straight from the DOM on every render, because the whole point is to report
     * what the BROWSER computed — a cached value would be worse than none. It exists so a
     * report can be a screenshot instead of a console paste: pasting into DevTools needs
     * the "allow pasting" dance, and this avoids that friction entirely.
     */
    function LayoutDiagnostics() {
      const canvas = document.querySelector('.dshiv-canvas')
      if (canvas === null) {
        return h('div', { className: 'dshiv-setRow' }, '诊断：当前没有放大的图片（先放大一张再看）')
      }
      const inner = canvas.querySelector('.dshiv-canvasInner')
      const image = canvas.querySelector('img')
      const rect = (node) => (node === null ? '—' : String(Math.round(node.getBoundingClientRect().width)))
      const style = window.getComputedStyle(canvas)
      const pane = canvas.closest('.dshiv-pane')
      const pager = canvas.closest('.dshiv-pager')
      const panel = canvas.closest('.dshiv-panel, .dshiv-root')
      const line = (label, value) => h('div', { className: 'dshiv-setRow dshiv-diagLine' }, `${label}：${value}`)
      // Every magnified image, one row each. A "zoom all" is meant to leave them all at the
      // same RELATIVE position, so listing the actual offsets is what shows whether one of
      // them failed to take the shared view.
      const rows = [...document.querySelectorAll('.dshiv-canvas')].map((node, index) => {
        const rangeX = node.scrollWidth - node.clientWidth
        const rangeY = node.scrollHeight - node.clientHeight
        const at = `${Math.round(node.scrollLeft)},${Math.round(node.scrollTop)}`
        const range = `${rangeX}x${rangeY}`
        const share = `${rangeX > 0 ? Math.round((node.scrollLeft / rangeX) * 100) : 50}%`
        return line(`图${index + 1} 滚动/范围/占比`, `${at} / ${range} / ${share}`)
      })
      return h(
        'div',
        { className: 'dshiv-diag', role: 'note' },
        line('画布 可视/可滚', `${canvas.clientWidth} / ${canvas.scrollWidth}`),
        line('画布 计算宽度', `${style.width} · max ${style.maxWidth} · min ${style.minWidth}`),
        // The gutter, as the browser actually resolved it. This is the number that separates
        // "the value is too small" from "the page is still running the previous bundle" —
        // a client-only change needs a hard refresh, and a stale one shows the old value.
        line('画布 内边距', `padding ${style.padding} · box-sizing ${style.boxSizing}`),
        line('画布 内联样式', canvas.getAttribute('style') ?? '（无）'),
        line('画布 渲染宽', rect(canvas)),
        line('内层 渲染宽', rect(inner)),
        line('图片 渲染宽', rect(image)),
        line('图片 声明宽', image === null ? '—' : image.style.width || '（无）'),
        line('外壳 渲染宽', `pane ${rect(pane)} · pager ${rect(pager)} · panel ${rect(panel)}`),
        line('垂直 可视/可滚', `${canvas.clientHeight} / ${canvas.scrollHeight}`),
        ...pagerLines(),
        ...rows,
      )
    }

    /**
     * The paging container's own numbers, and where each pane sits inside it.
     *
     * Paging assumes one page is exactly one container height, so these are the values
     * that tell whether an image can be pushed out of view: a page whose content is
     * taller than the container, or a scroll offset that is not a whole multiple of it.
     * A pane's `top` relative to the container is what shows WHO moved.
     */
    function pagerLines() {
      const pager = document.querySelector('.dshiv-pager')
      if (pager === null) return []
      const offset = pager.scrollTop
      const line = (label, value) => h('div', { className: 'dshiv-setRow dshiv-diagLine' }, `${label}：${value}`)
      const panes = [...document.querySelectorAll('.dshiv-pane')]
      const page = document.querySelector('.dshiv-page')
      const bounds = pager.getBoundingClientRect()
      return [
        line('分页 高/内容高/滚动', `${pager.clientHeight} / ${pager.scrollHeight} / ${Math.round(offset)}`),
        line('分页 一步 =', pager.clientHeight === 0 ? '—' : `${Math.round(offset / pager.clientHeight) * 100}% 于第 ${Math.round(offset / pager.clientHeight) + 1} 页`),
        line('每页 高度/内容高', page === null ? '—' : `${page.clientHeight} / ${page.scrollHeight}`),
        line(
          '各图 相对顶部的偏移',
          panes.map((node, index) => `${index + 1}:${Math.round(node.getBoundingClientRect().top - bounds.top)}`).join('  '),
        ),
        line(
          '各图 高度',
          panes.map((node, index) => `${index + 1}:${Math.round(node.getBoundingClientRect().height)}`).join('  '),
        ),
      ]
    }

    /**
     * The paginated viewer.
     *
     * One implementation, two shells: `embedded` fills the right column (its
     * parent owns the geometry), and the default renders as the floating
     * full-window layer that the Tool card can still open.
     */
    function Viewer({ viewer, resolve, initialPage, onClose, embedded = false, onReorder }) {
      const items = viewer.items
      const settings = useSettings()
      const [axis, setAxis] = useState(viewer.layout)
      const [pageSize, setPageSize] = useState(viewer.pageSize)
      const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
      const [page, setPage] = useState(() => Math.min(initialPage ?? 0, Math.max(0, Math.ceil(items.length / viewer.pageSize) - 1)))
      /**
       * Zoom, per image and for the set.
       *
       * `zoomByKey` holds PER-IMAGE overrides keyed by the durable attachment id — not
       * by index, which a filmstrip reorder would shuffle under it. `globalScale` is
       * the fallback every image without an override uses, which is what makes
       * "zoom all" a single write. Panning is deliberately NOT state here: it lives in
       * each canvas's own `scrollLeft/scrollTop`, so dragging never re-renders React.
       */
      const [zoomByKey, setZoomByKey] = useState(() => new Map())
      const [globalScale, setGlobalScale] = useState(settings.defaultScale)
      const [activeIndex, setActiveIndex] = useState(0)
      const [panMode, setPanMode] = useState(false)
      const [settingsOpen, setSettingsOpen] = useState(false)
      /**
       * Shift + the gear opens the panel WITH a live geometry dump.
       *
       * A readout rather than a control: it exists so the numbers behind a "the drag
       * barely moves" report can be read off a screenshot, without anyone pasting script
       * into a console. It costs no button and no state of its own.
       */
      const [showGeometry, setShowGeometry] = useState(false)
      /** Cancels the previous view-alignment window; a stale one would fight the new one. */
      const alignStopRef = useRef(null)
      /** Pointer anchor for the NEXT zoom of one image; the pane consumes and clears it. */
      const [anchors, setAnchors] = useState(() => new Map())
      /**
       * The view a set-wide zoom hands to the other images, plus the token that hands it
       * down. State, because a pane's layout effect only re-runs when something it depends
       * on changes — a second zoom-all to the SAME magnification would never reach it
       * through a ref. The ref holds the value being published.
       */
      /**
       * The ACTIVE pane's live geometry, surfaced in the zoom row.
       *
       * The row sits outside the scrolling canvas, so this is the copy that stays visible
       * while the image is panned — which is precisely when its scroll range matters.
       */
      const [activeGeometry, setActiveGeometry] = useState(null)
      const reportGeometry = useCallback((index, next) => {
        if (activeIndexRef.current !== index) return
        setActiveGeometry(next)
      }, [])
      const geometrySink = useMemo(
        () => ({ geometry: activeGeometry, report: reportGeometry }),
        [activeGeometry, reportGeometry],
      )
      const [film, setFilm] = useState(settings.showFilmstrip)

      /** The settings panel's group size drives the viewer's own. */
      useEffect(() => {
        setPageSize(settings.pageSize)
      }, [settings.pageSize])
      /**
       * The live drag, in refs as well as state.
       *
       * `dragstart` re-renders, but a handler that settles the drop during the same
       * gesture would still close over the PREVIOUS state values. The refs are what
       * the settle reads; the state only drives the visual markers.
       */
      const [dragIndex, setDragIndex] = useState(-1)
      const dragFromRef = useRef(-1)
      const dragToRef = useRef({ index: -1, after: false })

      /** Begin dragging one thumbnail. */
      const beginDrag = (index, event) => {
        const transfer = event?.dataTransfer
        if (transfer !== null && transfer !== undefined) {
          // A dragged thumbnail would otherwise advertise `Files` (the browser
          // autofills it for images), which the attachment drop zone accepts — clear
          // every advertised type and keep only our own marker.
          try {
            for (const type of [...(transfer.types ?? [])]) transfer.clearData(type)
          } catch {
            // `types` is not iterable in some engines; setData below is enough.
          }
          transfer.setData('text/plain', String(index))
          transfer.effectAllowed = 'move'
        }
        dragFromRef.current = index
        setDragIndex(index)
      }

      /** Track which slot, and which half of it, the pointer would insert into. */
      const overSlot = (index, event) => {
        const rect = event?.currentTarget?.getBoundingClientRect?.()
        const after = rect !== undefined && rect.width > 0 && event.clientX > rect.left + rect.width / 2
        dragToRef.current = { index, after }
      }

      /** Cancel a gesture without reordering (dragend after an Escape, say). */
      const cancelDrag = () => {
        dragFromRef.current = -1
        dragToRef.current = { index: -1, after: false }
        setDragIndex(-1)
      }

      /**
       * Finish a thumbnail drag: the strip is the only order control there is.
       *
       * The drop position is the slot the pointer is over plus which half of it —
       * "insert before" or "insert after" — so dragging E between A and C yields
       * A, E, C whichever direction the gesture moved.
       */
      const settleDrag = () => {
        const from = dragFromRef.current
        const { index: over, after } = dragToRef.current
        cancelDrag()
        if (from < 0 || over < 0 || typeof onReorder !== 'function') return
        const to = after ? over + 1 : over
        // Removing the dragged item first shifts every later slot down by one.
        onReorder(from, to > from ? to - 1 : to)
      }
      const pagerRef = useRef(null)
      const panelRef = useRef(null)
      const lockRef = useRef(0)
      const closedRef = useRef(onClose)
      closedRef.current = onClose

      const clampedPage = Math.min(page, pageCount - 1)

      const goToPage = useCallback(
        (next) => {
          const bounded = Math.max(0, Math.min(pageCount - 1, next))
          setPage(bounded)
          const node = pagerRef.current
          if (node !== null) {
            const step = axis === 'horizontal' ? node.clientWidth : node.clientHeight
            if (step > 0) {
              const left = axis === 'horizontal' ? bounded * step : 0
              const top = axis === 'horizontal' ? 0 : bounded * step
              if (typeof node.scrollTo === 'function') node.scrollTo({ left, top, behavior: 'smooth' })
              else {
                node.scrollLeft = left
                node.scrollTop = top
              }
            }
          }
        },
        [axis, pageCount],
      )

      /** The zoom one image currently uses: its own override, else the set default. */
      const zoomOf = useCallback(
        (item) => {
          const key = item.ref?.attachmentId
          if (key !== undefined) {
            const own = zoomByKey.get(key)
            if (own !== undefined) return own
          }
          return globalScale
        },
        [zoomByKey, globalScale],
      )

      /** Clamp one zoom value into the configured range, snapping to fit. */
      const clampScale = useCallback((value) => {
        const bounded = Math.max(MIN_SCALE, Math.min(MAX_SCALE, value))
        return bounded <= 1.001 ? 1 : bounded
      }, [])

      /**
       * Zoom one image, optionally around a pointer anchor and/or across the set.
       *
       * The anchor travels WITH the zoom: the pane applies it when it re-renders (its
       * own layout effect owns the scroll box), so no DOM node is reached across
       * components.
       */
      const zoomAt = useCallback(
        (index, factor, anchor, all) => {
          const target = items[index]
          const current = all ? globalScale : (target === undefined ? globalScale : zoomOf(target))
          const next = clampScale(current * factor)
          setActiveIndex(index)
          if (all) {
            // A set-wide zoom is also a set-wide VIEW: every image is pulled onto this
            // one's relative position, and kept there while the new sizes settle. Any older
            // window is stopped first, or two of them would write different references.
            alignStopRef.current?.()
            alignStopRef.current = alignViewsTo(index) ?? null
            setGlobalScale(next)
            setZoomByKey(new Map())
            return
          }
          const key = target?.ref?.attachmentId
          if (key === undefined) return
          setAnchors((map) => {
            const copy = new Map(map)
            if (anchor === null || anchor === undefined) copy.delete(index)
            else copy.set(index, anchor)
            return copy
          })
          setZoomByKey((map) => {
            const copy = new Map(map)
            if (next === globalScale) copy.delete(key)
            else copy.set(key, next)
            return copy
          })
        },
        [items, globalScale, zoomOf, clampScale],
      )

      /** Reset every image back to the configured default zoom. */
      const resetZoom = useCallback(() => {
        setZoomByKey(new Map())
        setAnchors(new Map())
        setGlobalScale(settings.defaultScale)
      }, [settings.defaultScale])

      /**
       * Copy the active image's zoom AND its place onto every other image.
       *
       * This is what "the same view" means for a comparison: the others must end up
       * looking at the same RELATIVE position, not merely at the same magnification. The
       * alignment is driven from HERE rather than handed to each pane, because each
       * canvas's scroll offset depends on its own rendered size and those sizes do not
       * settle at the same moment — a pane that missed its one chance stayed behind.
       *
       * WHICH image is the reference is read from the DOM, not from the index state. A
       * selection is what the user last clicked, and `data-active` is the committed result
       * of that click — the state variable can still be a render behind when this runs, so
       * the button would sync from the previously selected image.
       */
      const syncAllToActive = useCallback(() => {
        const selected = document.querySelector('.dshiv-pane[data-active="true"]')
        const fromDom = selected === null ? Number.NaN : Number(selected.getAttribute('data-index'))
        const index = Number.isInteger(fromDom) && items[fromDom] !== undefined ? fromDom : activeIndexRef.current
        const target = items[index]
        const key = target?.ref?.attachmentId
        if (key === undefined) return
        const source = zoomOf(target)
        if (source <= 1.001) {
          // Nothing is magnified to share yet; just clear any per-image overrides.
          setZoomByKey(new Map())
          return
        }
        // The previous convergence window is stopped first: it would otherwise keep writing
        // an older reference position over this one.
        alignStopRef.current?.()
        alignStopRef.current = alignViewsTo(index) ?? null
        setGlobalScale(source)
        setZoomByKey(new Map())
      }, [items, zoomOf])

      /** Forget one image's pending anchor once its pane has applied it. */
      const useAnchor = useCallback((index) => {
        setAnchors((map) => {
          if (!map.has(index)) return map
          const copy = new Map(map)
          copy.delete(index)
          return copy
        })
      }, [])

      /**
       * Pan one image, or every image, by the pointer's TOTAL travel since the press.
       *
       * Implemented over the DOM scroll boxes rather than React state: a drag writes
       * `scrollLeft/scrollTop` directly, so panning costs no render at all. `index === null`
       * means "all images" (Shift + middle drag).
       *
       * Direction: this is a HAND drag, not a scrollbar. Moving the pointer right carries
       * the image right, which means revealing its LEFT side — `scrollLeft` going UP.
       * Subtracting the delta (what a scroll wheel does) moves the image against the
       * pointer and reads as inverted.
       *
       * Applied against the offsets captured when the gesture began, so the image lands at
       * `origin + dx` no matter how many times a move is delivered. Nudging by an increment
       * would double-apply under any duplicate event and the drag would run away from the
       * pointer.
       *
       * An axis that does not overflow is left alone — otherwise the untouched pager would
       * take the scroll and the image would appear to jump a page.
       */
      const pan = useCallback((base, dx, dy) => {
        for (const { node, left, top } of base) {
          if (node.scrollWidth > node.clientWidth) node.scrollLeft = left + dx
          if (node.scrollHeight > node.clientHeight) node.scrollTop = top + dy
        }
      }, [])

      /** Capture the origin for one image (a plain middle drag). */
      const beginPan = useCallback((index) => panBase(index), [])
      /** Capture the origin for every image (Shift + middle drag). */
      const beginPanAll = useCallback(() => panBase(null), [])
      /** Apply the pointer's total travel against an origin captured by the two above. */
      const panTo = useCallback((base, dx, dy) => pan(base, dx, dy), [pan])


      /** True while ANY image is zoomed: the pager then stops snapping to pages. */
      const anyZoomed = items.some((item) => zoomOf(item) > 1.001)
      /** The image the zoom row reads and acts on; clamped as the set changes. */
      const activeItem = items[Math.min(activeIndex, Math.max(0, items.length - 1))]
      const activeScale = activeItem === undefined ? 1 : zoomOf(activeItem)
      /** Latest active index / pan mode for the window key handler (no re-subscribe). */
      const activeIndexRef = useRef(activeIndex)
      activeIndexRef.current = activeIndex
      const panModeRef = useRef(panMode)
      panModeRef.current = panMode

      // A layout or group-size change renumbers the pages under the pointer, so the
      // viewer returns to the first page. NOT on mount: `initialPage` is how the card
      // opens at the image the user clicked, and resetting here would discard it.
      const layoutSeen = useRef(false)
      useEffect(() => {
        if (!layoutSeen.current) {
          layoutSeen.current = true
          return
        }
        goToPage(0)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [axis, pageSize])

      // Escape closes the floating layer; the axis keys page; +/- zoom; f toggles
      // the filmstrip. Embedded in a column, the viewer only claims the keyboard
      // while focus is inside it — otherwise it would steal the shell's own keys
      // from every other panel.
      useEffect(() => {
        const ownsKeyboard = () => {
          if (!embedded) return true
          const node = panelRef.current
          if (node === null) return false
          const active = document.activeElement
          return active !== null && (node === active || node.contains(active))
        }
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return
          if (!ownsKeyboard()) return
          const key = event.key
          if (key === 'Escape') {
            if (embedded) return
            event.stopPropagation()
            closedRef.current()
            return
          }
          if (key === 'ArrowLeft' || key === 'PageUp') {
            event.preventDefault()
            goToPage(clampedPage - 1)
            return
          }
          if (key === 'ArrowRight' || key === 'PageDown') {
            event.preventDefault()
            goToPage(clampedPage + 1)
            return
          }
          if (key === 'ArrowUp') {
            event.preventDefault()
            if (axis === 'vertical') goToPage(clampedPage - 1)
            return
          }
          if (key === 'ArrowDown') {
            event.preventDefault()
            if (axis === 'vertical') goToPage(clampedPage + 1)
            return
          }
          if (key === 'Home') {
            event.preventDefault()
            goToPage(0)
            return
          }
          if (key === 'End') {
            event.preventDefault()
            goToPage(pageCount - 1)
            return
          }
          // `[移动]` mode makes the keyboard zoom the whole SET, matching the
          // Shift + middle-drag gesture that also moves every image at once.
          const zoomTarget = () => (panMode ? null : activeIndexRef.current)
          if (key === '+' || key === '=') {
            event.preventDefault()
            if (panMode) zoomAt(activeIndexRef.current, ZOOM_RATIO, null, true)
            else zoomAt(zoomTarget(), ZOOM_RATIO, null)
            return
          }
          if (key === '-' || key === '_') {
            event.preventDefault()
            if (panMode) zoomAt(activeIndexRef.current, 1 / ZOOM_RATIO, null, true)
            else zoomAt(zoomTarget(), 1 / ZOOM_RATIO, null)
            return
          }
          if (key === '0') {
            event.preventDefault()
            resetZoom()
            return
          }
          if (key === 'f' || key === 'F') {
            event.preventDefault()
            setFilm((value) => !value)
            return
          }
          if (key === 'v' || key === 'V') {
            event.preventDefault()
            setAxis((value) => (value === 'vertical' ? 'horizontal' : 'vertical'))
            return
          }
          // 2..6 map onto PAGE_SIZES, so the digit IS the index+2 — a wider range would
          // match keys that have no page size behind them and swallow them for nothing.
          if (/^[2-6]$/.test(key)) {
            const next = PAGE_SIZES[Number(key) - 2]
            if (next !== undefined) {
              event.preventDefault()
              setPageSize(next)
            }
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [zoomAt, zoomOf, items, axis, clampedPage, goToPage, pageCount])

      // Native scroll (wheel over the pager, scrollbar, trackpad) keeps the page state in sync.
      const onScroll = useCallback(() => {
        const node = pagerRef.current
        if (node === null) return
        const step = axis === 'horizontal' ? node.clientWidth : node.clientHeight
        if (step <= 0) return
        const offset = axis === 'horizontal' ? node.scrollLeft : node.scrollTop
        const next = Math.max(0, Math.min(pageCount - 1, Math.round(offset / step)))
        setPage((current) => (current === next ? current : next))
      }, [axis, pageCount])

      // One wheel gesture = one page while fitted; a zoomed image keeps native
      // panning. A NATIVE listener (not React's delegated one) is required: only a
      // non-passive listener registered before the event is dispatched can suppress
      // the browser's own scroll, and React attaches its wheel listener at the root.
      const wheelState = useRef({ page: clampedPage, pageCount, zoomed: anyZoomed })
      wheelState.current = { page: clampedPage, pageCount, zoomed: anyZoomed }
      useEffect(() => {
        const node = pagerRef.current
        if (node === null) return undefined
        const onWheelNative = (event) => {
          const { page: current, zoomed: isZoomed } = wheelState.current
          if (isZoomed) return
          // Deltas arrive in three units; Firefox's line mode reports ±3 for one
          // notch, which would fall under the threshold and disable wheel paging.
          const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight || 400 : 1
          const vertical = event.deltaY * unit
          const horizontal = event.deltaX * unit
          const dominant = Math.abs(vertical) >= Math.abs(horizontal) ? vertical : horizontal
          if (Math.abs(dominant) < WHEEL_THRESHOLD) return
          event.preventDefault()
          const now = Date.now()
          if (now - lockRef.current < WHEEL_LOCK_MS) return
          lockRef.current = now
          goToPage(current + (dominant > 0 ? 1 : -1))
        }
        node.addEventListener('wheel', onWheelNative, { passive: false })
        return () => node.removeEventListener('wheel', onWheelNative)
      }, [goToPage])

      const pages = useMemo(() => {
        const result = []
        for (let start = 0; start < items.length; start += pageSize) {
          result.push(items.slice(start, start + pageSize))
        }
        return result.length === 0 ? [[]] : result
      }, [items, pageSize])

      /**
       * The per-instance knobs the CSS reads: the viewer's own text size and the floor
       * under one image's box. The panes share whatever space is left, so a page of two
       * images always fits instead of overlapping.
       */
      useEffect(
        () => () => {
          alignStopRef.current?.()
          alignStopRef.current = null
        },
        [],
      )

      const viewerStyle = {
        '--dshiv-font-size': `${settings.viewerFontSize}px`,
        '--dshiv-pane-min': `${settings.paneHeightVh}vh`,
        // How many images share one page: the floor above is capped by an even share of
        // the container, so this is what keeps a crowded page from overflowing it.
        '--dshiv-pane-n': String(pageSize),
      }

      return h(
        GeometryContext.Provider,
        { value: geometrySink },
        h(
          'div',
          embedded
            ? { className: 'dshiv-panel', ref: panelRef, role: 'region', 'aria-label': viewer.title ?? '图片查看器', style: viewerStyle }
            : { className: 'dshiv-root', ref: panelRef, role: 'dialog', 'aria-modal': 'true', 'aria-label': viewer.title ?? '图片查看器', style: viewerStyle },
        h(
          'div',
          { className: 'dshiv-bar' },
          h('span', { className: 'dshiv-barTitle' }, viewer.title ?? `${items.length} 张图片`),
          h(
            'span',
            { className: 'dshiv-cardMeta' },
            `第 ${clampedPage + 1}/${pageCount} 页 · 图片 ${clampedPage * pageSize + 1}-${Math.min(
              items.length,
              (clampedPage + 1) * pageSize,
            )}/${items.length}`,
          ),
          h('span', { className: 'dshiv-spacer' }),
          h(
            'span',
            { className: 'dshiv-seg', role: 'group', 'aria-label': '翻页方向' },
            h(
              'button',
              {
                type: 'button',
                'data-active': axis === 'vertical' ? 'true' : 'false',
                onClick: () => setAxis('vertical'),
                title: '上下翻页 (V)',
              },
              h(Icons.upDown, { size: 13 }),
              '上下',
            ),
            h(
              'button',
              {
                type: 'button',
                'data-active': axis === 'horizontal' ? 'true' : 'false',
                onClick: () => setAxis('horizontal'),
                title: '左右翻页 (V)',
              },
              h(Icons.leftRight, { size: 13 }),
              '左右',
            ),
          ),
          h(
            'span',
            { className: 'dshiv-seg', role: 'group', 'aria-label': '每页图片数' },
            // The loop variable is `count`, NOT `size`: `size` is the icon-size
            // parameter several Icons.* calls in this same function pass as a
            // positional argument, and a shadowing `size` turns those icons into
            // `width="[object Object]"` giants.
            ...[1, 2, 3, 4, 6].map((count) =>
              h(
                'button',
                {
                  key: count,
                  type: 'button',
                  'data-active': pageSize === count ? 'true' : 'false',
                  onClick: () => setPageSize(count),
                  title: `每页 ${count} 张`,
                },
                String(count),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn dshiv-btnIcon',
              disabled: clampedPage <= 0,
              onClick: () => goToPage(clampedPage - 1),
              title: axis === 'vertical' ? '上一页 (↑)' : '上一页 (←)',
              'aria-label': '上一页',
            },
            h(Icons.chevronLeft, { size: 15 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn dshiv-btnIcon',
              disabled: clampedPage >= pageCount - 1,
              onClick: () => goToPage(clampedPage + 1),
              title: axis === 'vertical' ? '下一页 (↓)' : '下一页 (→)',
              'aria-label': '下一页',
            },
            h(Icons.chevronRight, { size: 15 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              onClick: () => setFilm((value) => !value),
              title: '缩略图条 (F)',
            },
            '缩略图',
          ),
          // Only the floating shell has something to close: embedded in the column,
          // the tab itself is the way out and `onClose` is undefined (the Escape
          // branch already guards on this, the button must too).
          embedded
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dshiv-btn',
                  onClick: () => closedRef.current?.(),
                  title: '关闭 (Esc)',
                },
                h(Icons.close, { size: 13 }),
                '关闭',
              ),
        ),
        /**
         * The zoom row: everything that acts on ONE image, with the active image's
         * own percentage as the readout. It sits under the title bar because it is a
         * different scope from paging (which is about the set).
         */
        h(
          'div',
          { className: 'dshiv-zoombar', role: 'toolbar', 'aria-label': '图片缩放' },
          h(
            'span',
            {
              className: 'dshiv-zoom',
              title:
                activeItem === undefined
                  ? ''
                  : [
                      activeItem.name ?? '',
                      activeGeometry === null
                        ? ''
                        : `框宽 ${activeGeometry.box} · 可滚宽 ${activeGeometry.wide} · 图片宽 ${activeGeometry.image} · 可拖 ${Math.max(0, activeGeometry.wide - activeGeometry.box)}px`,
                    ]
                      .filter((part) => part !== '')
                      .join(' — '),
            },
            activeItem === undefined ? '—' : `${Math.round(activeScale * 100)}%`,
          ),
          activeGeometry === null
            ? null
            : h(
                'span',
                {
                  className: 'dshiv-cardMeta',
                  title: '框宽 = 画布可视宽 · 滚宽 = 内容总宽 · 图宽 = 图片渲染宽；可拖动距离 = 滚宽 − 框宽',
                },
                `框${activeGeometry.box} 滚${activeGeometry.wide} 图${activeGeometry.image}`,
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn dshiv-btnIcon',
              disabled: activeItem === undefined,
              onClick: () => zoomAt(activeIndex, 1 / ZOOM_RATIO, null),
              title: '缩小这张 (-)',
              'aria-label': '缩小这张',
            },
            h(Icons.chevronDown, { size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn dshiv-btnIcon',
              disabled: activeItem === undefined,
              onClick: () => zoomAt(activeIndex, ZOOM_RATIO, null),
              title: '放大这张 (+)',
              'aria-label': '放大这张',
            },
            h(Icons.chevronUp, { size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              'data-active': activeScale <= 1.001 ? 'true' : 'false',
              disabled: activeItem === undefined,
              onClick: () => zoomAt(activeIndex, 1 / activeScale, null),
              title: '适应窗口 (0)',
            },
            '适应',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              disabled: activeItem === undefined,
              // 1:1 pixels, which is NOT the same as 适应 (and not "reset to 1x"): the zoom
              // a pane holds is relative to its fitted size, so reaching actual pixels means
              // multiplying by the inverse of that fit.
              onClick: () => {
                const factor = scaleToActualPixels(activeIndex)
                if (factor !== null) zoomAt(activeIndex, factor, null)
              },
              title: '回到 100%（一个图片像素对应一个屏幕像素）',
            },
            '100%',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              'data-active': panMode ? 'true' : 'false',
              onClick: () => setPanMode((value) => !value),
              title: '移动模式：中键拖动平移这张；按住 Shift 则整组一起移动',
            },
            Icons.leftRight === undefined ? '移动' : h(Icons.leftRight, { size: 13 }),
            '移动',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              onClick: syncAllToActive,
              title: '把这张的缩放与显示位置应用到全部图片（等同 Ctrl+Shift+滚轮）',
            },
            '同步全部',
          ),
          h(
            'button',
            { type: 'button', className: 'dshiv-btn', onClick: resetZoom, title: '全部回到默认缩放' },
            '重置',
          ),
          h('span', { className: 'dshiv-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              'data-active': settingsOpen ? 'true' : 'false',
              onClick: (event) => {
                // Shift carries the geometry dump, so the diagnostic needs no button.
                setShowGeometry(event.shiftKey === true)
                setSettingsOpen((value) => (event.shiftKey === true ? true : !value))
              },
              title: '图片查看器设置（按住 Shift 点击可显示尺寸诊断）',
              'aria-label': '图片查看器设置',
            },
            '⚙',
          ),
        ),
        settingsOpen ? h(SettingsPanel, { settings, onChange: updateSettings, showGeometry }) : null,
        h(
          'div',
          {
            className: 'dshiv-pager',
            'data-axis': axis,
            'data-zoomed': anyZoomed ? 'true' : 'false',
            ref: pagerRef,
            onScroll,
          },
          pages.map((pageItems, pageIndex) =>
            h(Page, {
              key: pageIndex,
              resolve,
              items: pageItems,
              pageIndex,
              pageCount,
              offset: pageIndex * pageSize,
              axis,
              zoomOf,
              activeIndex,
              panMode,
              anchors,
              onActivate: setActiveIndex,
              onZoomAt: zoomAt,
              onPanBegin: beginPan,
              onPanBeginAll: beginPanAll,
              onPanApply: panTo,
              onAnchorUsed: useAnchor,
            }),
          ),
        ),
        items.length === 0
          ? h('div', { className: 'dshiv-empty' }, '没有可显示的图片。')
          : null,
        film
          ? h(
              'div',
              { className: 'dshiv-film', onDrop: settleDrag, onDragOver: (event) => event.preventDefault() },
              items.map((item, index) =>
                h(FilmThumb, {
                  key: `${item.ref.attachmentId}:${index}`,
                  resolve,
                  item,
                  index,
                  active: Math.floor(index / pageSize) === clampedPage,
                  selected: index === activeIndex,
                  dragging: dragIndex === index,
                  onDragStart: (event) => beginDrag(index, event),
                  onDragEnd: cancelDrag,
                  onDragOver: (event) => overSlot(index, event),
                  onClick: () => goToPage(Math.floor(index / pageSize)),
                }),
              ),
            )
          : null,
        ),
      )
    }

    /**
     * One filmstrip entry: click jumps to its page, drag reorders the set.
     *
     * This strip is the ONLY place the order can change — the viewer reads the
     * published `items` array and has no order of its own, so a drop republishes the
     * set and every layout renders the new order. For a future grid layout the same
     * statement holds, which is why reordering is expressed as "move item at index
     * `from` to index `to`" rather than as anything axis-specific.
     */
    function FilmThumb({ resolve, item, index, active, selected, dragging, onDragStart, onDragEnd, onDragOver, onClick }) {
      const { url } = useImageUrl(resolve, item.ref)
      return h(
        'button',
        {
          type: 'button',
          className: 'dshiv-filmItem',
          draggable: true,
          'data-active': active ? 'true' : 'false',
          'data-selected': selected ? 'true' : 'false',
          'data-dragging': dragging ? 'true' : 'false',
          title: `${item.name} — 拖动可调整顺序`,
          'aria-label': `第 ${index + 1} 张：${item.name}（可拖动调整顺序）`,
          onDragStart,
          onDragEnd,
          onDragOver,
          onClick,
        },
        url === null ? null : h('img', { src: url, alt: item.name, decoding: 'async' }),
        h('span', { className: 'dshiv-filmIndex' }, String(index + 1)),
      )
    }

    //#endregion

    /** Style tag id; one tag per page, reused across plugin reloads. */
    const STYLE_TAG_ID = 'dsh-image-compare'

    /** The head tag this module inserted, once it has. */
    let styleTag = null

    /**
     * Insert the viewer stylesheet into the document head.
     *
     * A STATIC client plugin owns its own `<style>` tag rather than calling the
     * `styles.insert` closure: that closure belongs to the dynamic-package
     * runner, and a Cordis client context rejects `ctx.styles` unless the plugin
     * declares `styles` in its `inject` — which parks the whole package. An
     * idempotent head tag has no service dependency at all.
     *
     * The tag follows the MODULE, not one activation: a reload reuses it instead
     * of stacking duplicates, and teardown removes it exactly once. That is the
     * same guarantee the framework's own `styles.insert` gives.
     */
    function insertStylesheet() {
      if (typeof document === 'undefined') return () => {}
      if (styleTag === null) {
        const existing = document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)
        if (existing !== null) {
          styleTag = existing
        } else {
          styleTag = document.createElement('style')
          styleTag.dataset.pluginCss = STYLE_TAG_ID
          styleTag.dataset.plugin = STYLE_TAG_ID
          styleTag.textContent = CSS
          document.head.appendChild(styleTag)
        }
      }
      return removeStylesheet
    }

    /** Remove the module's head tag once; later activations find nothing to do. */
    function removeStylesheet() {
      if (styleTag !== null && styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag)
      styleTag = null
    }

    //#region right-column panel

    /** Tab-type id registered under `sidebar.right.pane.tab`. */
    const PANEL_ID = 'dsh-image-compare'
    /** Tab kind recorded for this type's addresses; mirrors the id. */
    const PANEL_KIND = 'dsh-image-compare'

    /**
     * The tab type's definition.
     *
     * Registering the type (not just the body) is what makes the viewer a
     * first-class column tab: `guide[]` is the entry the column's start page
     * lists, so the user can open it from there like 工作区文件 or 新建终端.
     */
    function viewerTabDefinition() {
      return {
        id: PANEL_ID,
        kind: PANEL_KIND,
        priority: 'builtin',
        title: () => '图片查看器',
        guide: [
          {
            id: PANEL_ID,
            order: 40,
            title: () => '图片查看器',
            description: () => '分页对比查看多张图片',
          },
        ],
      }
    }

    /**
     * The layout service captured at activation, used to bring the right column
     * forward when the viewer publishes a set. Module-scoped because the Tool
     * card — not the plugin — is what calls it, and a Tool view receives no
     * plugin context of its own.
     */
    let layoutRef

    /** Capture the optional layout service. */
    function setLayoutService(layout) {
      layoutRef = layout
    }

    /** True for the image suffixes the host tool accepts. */
    function isImageName(name) {
      const lower = String(name).toLowerCase()
      return ['.png', '.jpg', '.jpeg', '.webp', '.gif'].some((suffix) => lower.endsWith(suffix))
    }

    /** Media type of an image path, used to build the browser URL. */
    function imageMediaTypeOf(path) {
      const lower = String(path).toLowerCase()
      if (lower.endsWith('.png')) return 'image/png'
      if (lower.endsWith('.webp')) return 'image/webp'
      if (lower.endsWith('.gif')) return 'image/gif'
      return 'image/jpeg'
    }

    /**


    /**
     * List one directory for the panel, through the host's read-only browse route.
     *
     * The panel cannot list a directory on its own: the Client's
     * `remote.workspaceFiles` namespace answers `gateway/bad-request` for a
     * plugin-scoped caller (the built-in file tab reaches it through a
     * session-scoped carrier a third-party plugin does not share), and the composed
     * picker serves the `native` capability only. The host half therefore serves
     * `/dsh-image-compare/browse` and the panel fetches it — which also means a
     * session whose workspace lives on a remote host lists THAT host's directory,
     * because the listing happens on the host side.
     *
     * An omitted path means the workspace root (`cwd`).
     *
     * @returns `{ entries, path }` on success, or `{ error }` for the user.
     */
    async function listWorkspaceDir(path, sessionId, cwd, signal) {
      const query = new URLSearchParams()
      if (path !== '') query.set('path', path)
      // The session is what makes the host resolve the RIGHT filesystem and root:
      // a session routed to a remote host lists that host's directory.
      if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId)
      if (typeof cwd === 'string' && cwd !== '') query.set('cwd', cwd)
      const suffix = query.toString()
      try {
        const response = await fetch(`/dsh-image-compare/browse${suffix === '' ? '' : `?${suffix}`}`, {
          signal,
          headers: { accept: 'application/json' },
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          // A typeless 404 is the shell's fallback answering, which means the HOST half
          // serving this route is not the one on disk. A JSON 404 is this plugin's own
          // "missing" answer — a normal outcome that must not be dressed up as a
          // "reactivate the plugin" instruction.
          if (response.status === 404 && body.missing !== true) {
            return { error: '宿主的目录路由还没装载：请在插件面板里把 dsh-image-compare 关掉再打开（或重启应用），然后重试。' }
          }
          return { error: `读取目录失败：${body.error ?? `HTTP ${response.status}`}` }
        }
        return { entries: Array.isArray(body.entries) ? body.entries : [], path: body.path }
      } catch (error) {
        return { error: `读取目录失败：${error instanceof Error ? error.message : String(error)}` }
      }
    }

    /** True for a directory listing entry. */
    function isDirectoryEntry(entry) {
      return entry?.type === 'directory' || entry?.kind === 'directory' || entry?.isDirectory === true
    }

    /**
     * The parent of one workspace path, or `''` for the workspace root.
     *
     * Listings are workspace-relative, so "up" is simply the path without its last
     * segment; a path that is already single-segment (or empty) is the root, which
     * has no parent inside the workspace.
     */
    function parentWorkspacePath(path) {
      const trimmed = String(path).replace(/[/\\]+$/, '')
      if (trimmed === '' || trimmed === '.') return ''
      const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return cut <= 0 ? '' : trimmed.slice(0, cut)
    }

    /** Display name of one listing entry. */
    function entryName(entry) {
      return String(entry?.name ?? entry?.path ?? entry?.relativePath ?? '')
    }

    /**
     * The project browser: a directory/file strip under the image area.
     *
     * Subdirectories descend on click; image files tick on click and that tick IS
     * the queue edit. The component is controlled — the panel owns the queue — so
     * the queue keeps its order while the user browses.
     *
     * The listing comes from the host's read-only browse route, which resolves the
     * SESSION's filesystem and workspace root.
     */
    function ImagePicker({ sessionId, cwd, queue, onToggle }) {
      const [path, setPath] = useState('')
      const [entries, setEntries] = useState([])
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      /**
       * The newest request's ticket.
       *
       * Clicking through directories quickly leaves several listings in flight; only
       * the latest may write `entries`/`busy`, or a slow answer for directory A would
       * replace the listing of directory B the user is actually looking at.
       */
      const requestRef = useRef(0)
      const mountedRef = useRef(true)
      useEffect(() => () => {
        mountedRef.current = false
      }, [])

      const load = useCallback(
        async (next) => {
          const ticket = (requestRef.current += 1)
          const valid = () => mountedRef.current && requestRef.current === ticket
          setBusy(true)
          setError('')
          const abort = new AbortController()
          // An empty path is the workspace root — the panel's default. The session
          // decides which root that is: local, or a routed remote host.
          const result = await listWorkspaceDir(next, sessionId, cwd, abort.signal)
          if (!valid()) return
          setBusy(false)
          if (result.error !== undefined) {
            setError(result.error)
            setEntries([])
            return
          }
          const seen = new Set()
          const rows = []
          for (const entry of result.entries) {
            const name = entryName(entry)
            if (name === '' || name === '.' || name === '..' || seen.has(name)) continue
            seen.add(name)
            const entryPath = String(entry?.path ?? entry?.target?.displayPath ?? '')
            if (isDirectoryEntry(entry)) rows.push({ kind: 'dir', name, path: entryPath })
            else if (isImageName(name)) rows.push({ kind: 'file', name, path: entryPath === '' ? name : entryPath })
          }
          rows.sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'dir' ? -1 : 1))
          setEntries(rows)
        },
        [sessionId, cwd],
      )

      // Reload whenever the SESSION changes: the panel is a resident tab, so it stays
      // mounted across a conversation switch and would otherwise keep listing the
      // previous conversation's directory.
      useEffect(() => {
        setPath('')
        load('')
      }, [load])

      const isChosen = (file) => queue.some((item) => item.path === file.path)
      // The workspace root has no parent INSIDE the workspace, so "up" only makes
      // sense once the user has descended at least one level.
      const up = parentWorkspacePath(path)
      const atRoot = up === '' && path === ''

      return h(
        'div',
        { className: 'dshiv-picker' },
        h(
          'div',
          { className: 'dshiv-pickerBar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              disabled: busy || atRoot || path === '',
              title: atRoot ? '已在工作区根目录' : `返回 ${up === '' ? '工作区根目录' : up}`,
              onClick: () => {
                setPath(up)
                load(up)
              },
            },
            '↑ 上一级',
          ),
          h('input', {
            className: 'dshiv-pickerPath',
            value: path,
            placeholder: '目录路径（留空 = 工作区根目录）',
            title: '可直接编辑路径后回车',
            onChange: (event) => setPath(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') load(path)
            },
          }),
          h('button', { type: 'button', className: 'dshiv-btn', onClick: () => load(path), disabled: busy }, busy ? '读取中…' : '刷新'),
          h('button', { type: 'button', className: 'dshiv-btn', onClick: () => { setPath(''); load('') }, disabled: busy }, '工作区'),
        ),
        error === '' ? null : h('div', { className: 'dshiv-note' }, error),
        entries.length === 0 && error === '' && !busy
          ? h(
              'div',
              { className: 'dshiv-panelEmpty' },
              '这个目录里没有子目录或图片（支持 PNG/JPEG/WebP/GIF）。',
              path === ''
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshiv-btn',
                      onClick: () => {
                        setPath(up)
                        load(up)
                      },
                    },
                    up === '' ? '回到工作区根目录' : '返回上一级',
                  ),
            )
          : null,
        h(
          'div',
          { className: 'dshiv-pickerList' },
          entries.map((entry) =>
            h(
              'button',
              {
                key: `${entry.kind}:${entry.path}:${entry.name}`,
                type: 'button',
                className: 'dshiv-pickerItem',
                'data-chosen': entry.kind === 'file' && isChosen(entry) ? 'true' : 'false',
                'data-kind': entry.kind,
                title: entry.path,
                onClick: () => {
                  if (entry.kind === 'dir') {
                    setPath(entry.path)
                    load(entry.path)
                    return
                  }
                  onToggle(entry)
                },
              },
              h(
                'span',
                { className: 'dshiv-pickerCheck' },
                entry.kind === 'dir' ? '▸' : isChosen(entry) ? '✓' : '',
              ),
              h('span', { className: 'dshiv-pickerName' }, entry.name),
            ),
          ),
        ),
      )
    }

    /**
     * Resolve a workspace file path to a browser URL.
     *
     * The Tool path resolves durable attachments through the session loader; a
     * picked workspace file is not an attachment, so the URL points at the host's
     * read-only raw route instead: the browser fetches the bytes directly, which
     * keeps this side free of any file-reading capability and covers a remote
     * workspace because the host resolves it through the session.
     *
     * @returns a resolved promise carrying the URL — the viewer contract is async,
     *   and going through it keeps one code path for both image sources.
     */
    function createPathResolver(sessionId, cwd) {
      const cache = new Map()
      const resolve = (ref) => {
        const path = String(ref.path ?? ref.name ?? '')
        const cached = cache.get(path)
        if (cached !== undefined) return cached
        const query = new URLSearchParams({ path })
        if (typeof sessionId === 'string' && sessionId !== '') query.set('session', sessionId)
        if (typeof cwd === 'string' && cwd !== '') query.set('cwd', cwd)
        const url = `/dsh-image-compare/raw?${query.toString()}`
        const settled = Promise.resolve(url)
        cache.set(path, settled)
        return settled
      }
      return resolve
    }

    /**
     * Probe one image URL the way the browser will use it.
     *
     * A broken `<img>` reports nothing by itself, so the panel asks the route and
     * turns the answer into one actionable line. The ABSENCE of a content type is
     * itself the diagnosis: this plugin's own 404s are JSON, so a typeless 404 means
     * the request never reached the plugin — the running host half predates the
     * route and the plugin needs reactivating.
     *
     * @returns a report line, or null when the route answered with a real image.
     */
    async function probeImageUrl(url) {
      try {
        const response = await fetch(url, { headers: { accept: 'image/*' } })
        const type = response.headers.get('content-type')
        if (response.ok && type !== null && type.startsWith('image/')) return null
        if (response.status === 404 && type === null) {
          return '图片路由还没装载：请在插件面板里把 dsh-image-compare 关掉再打开，然后刷新页面。'
        }
        if (response.ok) return `图片路由返回的不是图片（${type ?? '无类型'}）。`
        const body = await response.text().catch(() => '')
        return `读取图片失败：HTTP ${response.status} ${body.slice(0, 120)}`
      } catch (error) {
        return `读取图片失败：${error instanceof Error ? error.message : String(error)}`
      }
    }

    /**
     * Build the viewer model for a hand-picked file selection.
     *
     * Entries carry the picked path, which the resolver turns into the host's raw
     * route; the title doubles as the viewer's React key, so opening a different
     * selection resets paging instead of reusing the previous page.
     */
    function viewerOfSelection(files) {
      return {
        title: files.length === 1 ? files[0].name : `${files.length} 张图片`,
        layout: 'vertical',
        pageSize: files.length >= 2 ? 2 : 1,
        failures: [],
        items: files.map((file) => ({
          path: file.path,
          name: file.name,
          ref: {
            attachmentId: `path:${file.path}`,
            mediaType: imageMediaTypeOf(file.path),
            path: file.path,
            name: file.name,
          },
        })),
      }
    }

    /**
     * The viewer as a right-column tab.
     *
     * Three segments, in this order: the open queue (what will be — or is — shown),
     * the image area, and the project browser at the bottom.
     *
     * The queue is the panel's own state, and it is EDITED BY SELECTION: ticking a
     * file in the browser adds it, unticking or the row's × removes it. Only the
     * 「打开」 button publishes the queue to the viewer, so browsing never disturbs
     * the comparison already on screen. Order is changed on the viewer's filmstrip,
     * which writes the new order back into the queue when the queue is what is shown.
     */
    function ImageViewerPanel(props) {
      const sessionId = props.sessionId
      // ONE key for both reading and writing this panel's slot. A Tab that carries no
      // session (`undefined`) must not read the shared empty slot while writing to
      // its own: that mismatch made a reorder invisible and let another publisher's
      // set appear in a conversation whose own slot was empty.
      const viewerKey = sessionId ?? DEFAULT_SESSION_KEY
      const { viewer, resolve } = useViewerState(viewerKey)
      /** Tears down an in-flight divider drag if the panel goes away first. */
      const resizeCleanupRef = useRef(null)
      useEffect(() => () => {
        resizeCleanupRef.current?.()
      }, [])
      /** Always-current set and loader, for handlers that outlive one render. */
      const viewerRef = useRef(viewer)
      const resolveRef = useRef(resolve)
      viewerRef.current = viewer
      resolveRef.current = resolve
      const [browsing, setBrowsing] = useState(true)
      const [queue, setQueue] = useState([])
      /**
       * The queue, always current.
       *
       * Handlers created by an earlier render keep their captured `queue`; a delayed
       * click (or a republish) firing one of them would push the OLD order back into
       * the viewer. Everything that publishes reads the ref instead.
       */
      const queueRef = useRef(queue)
      queueRef.current = queue
      const [queueOpen, setQueueOpen] = useState(true)
      /** Height of the browser strip, in px; the divider below drags it. */
      const [browserHeight, setBrowserHeight] = useState(280)
      const [diagnostics, setDiagnostics] = useState([])
      const sessionCwd = props.useSession?.((state) => state?.cwd)
      const cwd = typeof sessionCwd === 'string' && sessionCwd !== '' ? sessionCwd : undefined

      /** Tick or untick one file: this IS the queue edit. */
      const toggleQueued = (file) => {
        setQueue((current) =>
          current.some((item) => item.path === file.path)
            ? current.filter((item) => item.path !== file.path)
            : [...current, file],
        )
      }

      /** Remove one row from the queue. */
      const removeQueued = (path) => {
        setQueue((current) => current.filter((item) => item.path !== path))
      }

      /**
       * Publish the queue to the viewer.
       *
       * The bytes come from the host's raw route, so opening is just publishing a
       * viewer whose resolver points at that route — no client-side file access, and
       * the same path covers a remote workspace.
       *
       * A queue identical to what is already shown publishes NOTHING: the shown set
       * may already carry a reorder, and pushing the queue back in would undo it.
       */
      const openQueue = () => {
        const currentQueue = queueRef.current
        if (currentQueue.length === 0) return
        const shown = viewerRef.current
        const sameAsShown =
          shown !== undefined &&
          shown.items.length === currentQueue.length &&
          shown.items.every((item, index) => item.ref?.path === currentQueue[index].path)
        if (sameAsShown) return
        setViewerState({ viewer: viewerOfSelection(currentQueue), resolve: createPathResolver(sessionId, cwd) }, viewerKey)
        setQueueOpen(true)
        // Ask the route what it will answer, so a broken image explains itself.
        const resolver = createPathResolver(sessionId, cwd)
        Promise.all(currentQueue.slice(0, 4).map((file) => resolver({ path: file.path }).then(probeImageUrl)))
          .then((lines) => setDiagnostics(lines.filter((line) => line !== null)))
          .catch(() => setDiagnostics([]))
      }

      /**
       * Move one image to another position.
       *
       * The QUEUE is the order: it is the only thing the user edits here, so a
       * reorder updates the queue first and the viewer is republished from it. If
       * the shown set came from a Tool card instead (no workspace paths to address),
       * only the viewer is republished — the queue owns nothing to reorder.
       */
      const reorderViewer = (from, to) => {
        const current = viewerRef.current
        const currentResolve = resolveRef.current
        if (current === undefined || currentResolve === undefined) return

        // Only a set this panel built from the queue carries `path:` refs; a Tool
        // card's refs are attachment ids. Reordering the latter against the queue
        // would publish refs the current resolver cannot load, so the queue edits
        // the shown set only when the shown set IS the queue's.
        const isQueueSet =
          current.items.length > 0 &&
          current.items.every((item) => typeof item.ref?.attachmentId === 'string' && item.ref.attachmentId.startsWith('path:'))
        const source = isQueueSet
          ? current.items.map((item) => ({ path: item.ref.path, name: item.ref.name ?? item.name, ref: item.ref }))
          : current.items
        if (from === to || from < 0 || to < 0 || from >= source.length || to >= source.length) return

        const next = [...source]
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)

        if (isQueueSet) setQueue(next.map((item) => ({ path: item.path, name: item.name })))
        setViewerState({ viewer: { ...current, items: next }, resolve: currentResolve }, viewerKey)
      }

      /**
       * Drag the divider to give the browser as much height as the user wants.
       *
       * The height is applied to the browser strip only, so the image area takes
       * whatever is left; clamping keeps both segments usable whatever the pointer
       * does. Window listeners carry the gesture past the panel's own edges.
       */
      const startResize = (event) => {
        event.preventDefault()
        const startY = event.clientY
        const startHeight = browserHeight
        const onMove = (moveEvent) => {
          const next = startHeight - (moveEvent.clientY - startY)
          setBrowserHeight(Math.max(MIN_BROWSER_HEIGHT, Math.min(MAX_BROWSER_HEIGHT, next)))
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          if (resizeCleanupRef.current === onUp) resizeCleanupRef.current = null
        }
        // Remembered so an unmount mid-gesture (a tab switch, a collapsed column)
        // can drop the listeners: otherwise every later mouse move keeps resizing.
        resizeCleanupRef.current = onUp
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      /**
       * Swallow every drag event that reaches the panel itself.
       *
       * The attachment drop zone listens on `document` (bubbling) and reacts to any
       * transfer advertising `Files`; without this, dragging an image inside the
       * viewer raises its "drop files here" overlay. Handling the events here stops
       * them before the document, and a drag that starts inside this element can only
       * be the viewer's own reorder gesture.
       */
      const swallowDrag = {
        onDragEnter: (event) => event.stopPropagation(),
        onDragOver: (event) => {
          event.stopPropagation()
          event.preventDefault()
        },
        onDragLeave: (event) => event.stopPropagation(),
        onDrop: (event) => {
          event.stopPropagation()
          event.preventDefault()
        },
      }

      return h(
        'div',
        { className: 'dshiv-panelWrap', ...swallowDrag },
        h(
          'div',
          { className: 'dshiv-panelTools' },
          h('span', { className: 'dshiv-cardMeta' }, `队列 ${queue.length} 张`),
          h('span', { className: 'dshiv-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              disabled: queue.length === 0,
              onClick: openQueue,
              title: '按队列顺序打开这些图片',
            },
            '打开',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              disabled: queue.length === 0,
              onClick: () => setQueue([]),
              title: '清空队列',
            },
            '清空',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              onClick: () => setQueueOpen((value) => !value),
              title: '显示/隐藏队列清单',
            },
            queueOpen ? '隐藏清单' : '显示清单',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshiv-btn',
              onClick: () => setBrowsing((value) => !value),
              title: browsing ? '收起目录，把整列留给图片' : '展开目录',
            },
            browsing ? '收起目录' : '浏览目录',
          ),
        ),
        h(
          'div',
          { className: 'dshiv-queue', 'data-open': queueOpen ? 'true' : 'false' },
          queue.length === 0
            ? h('div', { className: 'dshiv-queueEmpty' }, '队列为空：在下面的目录里点选图片即入队。')
            : queue.map((file, index) =>
                h(
                  'div',
                  { key: file.path, className: 'dshiv-queueRow' },
                  h('span', { className: 'dshiv-queueIndex' }, `${index + 1}`),
                  h('span', { className: 'dshiv-queueName', title: file.path }, file.name),
                  h('span', { className: 'dshiv-queuePath', title: file.path }, file.path),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshiv-queueRemove',
                      title: '移出队列',
                      onClick: () => removeQueued(file.path),
                    },
                    '×',
                  ),
                ),
              ),
        ),
        diagnostics.length === 0
          ? null
          : h('div', { className: 'dshiv-diag' }, ...diagnostics.map((line, index) => h('div', { key: index }, line))),
        h(
          'div',
          { className: 'dshiv-panelImage' },
          viewer === undefined || resolve === undefined
            ? h(
                'div',
                { className: 'dshiv-panelEmpty' },
                h(
                  'div',
                  null,
                  h('p', null, '还没有打开的图片。'),
                  h('p', null, '在上面的队列里排好顺序，然后点「打开」。'),
                ),
              )
            : h(Viewer, { viewer, resolve, embedded: true, key: viewer.title ?? 'viewer', onReorder: reorderViewer }),
        ),
        browsing
          ? h(
              'div',
              { className: 'dshiv-pickerHost', style: { height: `${browserHeight}px` } },
              h(
                'div',
                {
                  className: 'dshiv-resizer',
                  title: '上下拖动可调整文件浏览器的高度',
                  onMouseDown: startResize,
                },
                h('span', { className: 'dshiv-resizerGrip' }),
              ),
              h(ImagePicker, {
                sessionId,
                cwd,
                queue,
                onToggle: toggleQueued,
              }),
            )
          : null,
      )
    }

    /** The tab chip's label — this session's set, like the panel body. */
    function ImageViewerPanelTitle(props) {
      const { viewer } = useViewerState(props.sessionId ?? DEFAULT_SESSION_KEY)
      return h('span', null, viewer === undefined ? '图片查看器' : (viewer.title ?? `图片 ${viewer.items.length} 张`))
    }

    //#endregion

    /**
     * The plugin's hard requirements.
     *
     * Only what the plugin truly needs: `slots` for the Tool card and the column
     * tab, `uiConversation` for the scope the Tool view lives in, and `layout` for
     * the column navigation the card performs. Nothing else may be named here that
     * the plugin does not actually need — a missing provider parks the package, and
     * access without a declaration throws.
     *
     * The workspace file namespaces are deliberately NOT declared: the panel reaches
     * directories and image bytes through the HOST's read-only routes, so declaring
     * the Client carrier here would only add a dependency that answers
     * `gateway/bad-request` for a plugin-scoped caller.
     */
    const inject = ['slots', 'uiConversation', 'layout']

    /**
     * Register the viewer: its Tool card and its right-column tab type.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => insertStylesheet(), 'dsh-image-compare: stylesheet')
      // `layout` is a DECLARED dependency, so it is read as a property instead of
      // through a lookup helper: the card's 「右侧栏」 button then degrades to
      // "publish only" wherever a shell does not provide it.
      setLayoutService(ctx.layout)
      ctx.slots.inject('tool.call.toolview', () =>
        ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: TOOL_NAME,
            locale: CONVERSATION_NS,
          },
          ImagesCard,
        ),
      )
      // The right-column tab: the TYPE goes into the tabs registry (that is what
      // lists it on the column's start page through its `guide` entries), and the
      // body/title into the two keyed slots.
      //
      // The registry is reached through `ctx.inject` rather than the plugin's own
      // `inject` list: an absent registry then costs the start-page listing only,
      // instead of parking the whole package (`ctx.inject` waits, it does not fail).
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], (tabsCtx) => {
          tabsCtx.effect(() => tabsCtx.sidebarRightTabs.register(viewerTabDefinition()), 'dsh-image-compare: tab type')
        })
      }
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, ImageViewerPanel),
      )
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PANEL_ID }, ImageViewerPanelTitle),
      )
    }

    exports.apply = apply
    exports.inject = inject
    // Test seam only: lets a check simulate preferences written by another page.
    exports.clearSettingsCache = clearSettingsCache
    /**
     * Test seam only: forget that a drag is in flight.
     *
     * `lastDragRef` is module-scoped by design — it has to survive a pane being re-created
     * mid-gesture, which a per-component ref cannot do — so it also outlives one check and
     * the next one's first click. Production never needs this: a real pointer always ends
     * its gesture with a click (which consumes the flag) or a mouseup, whereas a check can
     * simply stop dispatching. Resetting here keeps each check independent without
     * weakening the rule the flag exists for.
     */
    exports.resetDragFlag = () => {
      lastDragRef.current = false
    }
    return module.exports
  },
})
