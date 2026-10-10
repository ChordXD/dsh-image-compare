# dsh-image-compare

[简体中文](README.md)

A DeepSeek Harness plugin for **comparing several images at once**.

The built-in `read_image` puts **one** image into the conversation at a time — so "before vs after", or "the five screenshots of these five options", means flipping back and forth one image at a time. This plugin adds a `view_images` tool that **opens a whole set at once as a pageable comparison view**: several images side by side on a page, each one zoomable, in any order you want.

The important part: **the images are for a human to look at, and not one byte of them enters the model's context.** Open twenty 2 MB screenshots and the conversation grows by a single line.

## What it does

**Comparing several images** (the point of the plugin)

- **1/2/3/4/6 images side by side per page** (2 by default) — a real side-by-side comparison instead of scrolling back and forth.
- **Synchronise the whole set**: apply the current image's **zoom *and* the place it is looking at** to every other image, so each one shows *the same region*. That is what actually aligns a detail-by-detail comparison.
- **Any order**: drag the filmstrip at the bottom to reorder, so the two images you want to compare can sit next to each other.

**Looking at them**

- **Per-image zoom**: click an image to select it; the zoom row then acts on that one only, from 0.1x to 8x. Double-click toggles between magnified and fit.
- **Middle-button drag to pan**: one-to-one with the pointer, stops the moment you stop; hold `Shift` to pan the whole set together.
- **Page up/down or left/right**: wheel, arrow keys and prev/next buttons all page; one wheel gesture advances exactly one page.
- **Filmstrip**: click any thumbnail to jump to the page it is on.

**Getting the images in**

- **Browse the workspace inside the panel**: parent directory, path box, refresh, tick several files and press 打开 (Open). A local session lists local files, an SSH session lists remote ones.
- **A path that cannot be read says why**: outside the workspace, not an image, or not found — each is reported instead of showing a broken image.

## Install

The plugin is a standard DSH profile bundle and carries every declaration it needs, so **no configuration file has to be written by hand**.

### Plugins page (recommended)

1. Open the Web UI and click **插件** (Plugins) in the left sidebar;
2. Click **添加插件** (Add plugin) and paste either:
   - `github:ChordXD/dsh-image-compare`
   - the **absolute path** of this directory
   - the npm package name (once published)
3. Make sure it is **enabled**;
4. **Restart DeepSeek Harness**.

### Command line

```sh
dsh plugin --profile web add github:ChordXD/dsh-image-compare
```

Installing from GitHub runs its build scripts, which pnpm blocks by default; dsh prints the exact `allowBuilds` key to add to that profile's `pnpm-workspace.yaml` — add it and re-run. To pin a revision, append a commit: `github:ChordXD/dsh-image-compare#<sha>`.

### Uninstall

Remove it on the plugins page, or `dsh plugin --profile web remove dsh-image-compare`, then restart.

> Requirements: DeepSeek Harness 0.2.0-rc.2 or later (Web UI or desktop app). **No dependencies to install** — the host half uses services the profile already provides, and the client half only needs the `react` every shell preloads.

## Usage

Just ask the model to compare the images; it calls:

```
view_images(
  images    = [{ path: "shots/before.png", label: "before" },
               { path: "shots/after.png",  label: "after" }],
  layout    = "vertical",   # or "horizontal"; vertical by default
  page_size = 2,            # 1/2/3/4/6; 2 by default
  title     = "Home page redesign",
)
```

- `images`: an ordered list of paths, resolved against the session workspace when relative; each entry is `{ path, label? }`. At most 60 per call.
- The card in the conversation offers two entry points: **右侧栏** (right column) publishes the set to the panel — recommended — and **全屏** (full screen) opens the floating view.

When you do not know which images exist, have the model call `browse_images(path?, recursive?, max_depth?)` to list a directory; omit `path` to list the workspace root.

## Controls

Mouse (inside the image area):

| Gesture | Effect |
| --- | --- |
| Left click | Select that image |
| `Ctrl` / `Cmd` + wheel | Zoom the image under the pointer (anchored there) |
| `Ctrl` / `Cmd` + `Shift` + wheel | Apply that image's zoom **and position to the whole set** |
| Middle-button drag | Pan the magnified region of that image |
| `Shift` + middle-button drag | Pan the whole set together |
| Wheel (no modifier) | Page, one page per gesture |
| Double-click an image | Magnify ↔ fit |
| Drag a thumbnail | Reorder the images |

Zoom row (above the image area): percentage readout, `−`, `+`, `适应` (fit), `100%`, `移动` (move), `同步全部` (sync all), `重置` (reset), `⚙` (settings).

Keyboard:

| Key | Effect |
| --- | --- |
| `↑` `↓` | Previous / next page (when paging up/down) |
| `←` `→` / `PageUp` `PageDown` | Previous / next page (either paging axis) |
| `Home` / `End` | First / last page |
| `+` / `-` | Zoom in / out the selected image (the whole set in 移动 mode) |
| `0` | Reset every image to the default zoom |
| `V` | Switch between up/down and left/right paging |
| `2`–`6` | 1 / 2 / 3 / 4 / 6 images per page |
| `F` | Show / hide the filmstrip |
| `Esc` | Close the full-screen view |

The gear panel holds: default zoom, images per page, whether the filmstrip starts open, the viewer's own font size, and the minimum height of one image.

## How it differs from other image plugins

| | Who looks at the image | How many at once | Bytes in the model context |
| --- | --- | --- | --- |
| Built-in `read_image` | the model | 1 | yes |
| Plugins that enhance the built-in viewer | images already on screen | mostly 1 | no |
| Vision-bridge plugins | **the model** | several | **yes** (spends vision quota) |
| **This plugin** | **a human** | **a whole set, side by side, pageable** | **no** |

In one line: it is a tool for **a person comparing several images**, not a channel for feeding images to a model.

## License

MIT
