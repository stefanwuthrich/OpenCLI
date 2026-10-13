# OpenCLI Browser Bridge — Firefox

A Firefox build of the OpenCLI Browser Bridge. It connects Firefox tabs to the
local OpenCLI daemon over the same WebSocket protocol as the Chrome extension,
so `opencli browser ...` works from your logged-in Firefox session.

This is a **separate project** from the Chrome extension (`../extension/`): it
has its own manifest, sources, tests, and build (via
[Extension.js](https://github.com/extension-js/extension.js)). The Chrome
extension and its build are untouched.

## What Firefox can and cannot do

Firefox WebExtensions have **no `chrome.debugger` / CDP API**, and no
`chrome.tabGroups`. That is a platform limit, not a missing feature here. This
build implements everything Firefox can do natively and returns a typed
`unsupported_on_firefox` failure for the rest.

| Command family | Firefox build | How |
| --- | --- | --- |
| `exec` / `eval` | ✅ | `browser.scripting.executeScript({ world: 'MAIN' })` (Firefox 128+) |
| `navigate`, `open` | ✅ | `browser.tabs.update` + `onUpdated` |
| `tab` (list / new / close / select) | ✅ | `browser.tabs` / `browser.windows` |
| `bind` | ✅ | active tab in the focused window |
| `cookie` | ✅ | `browser.cookies` |
| `screenshot` | ✅ viewport only | `browser.tabs.captureTab` |
| `screenshot --full-page` / `--width` / `--height` | ⛔ | no `Page.captureScreenshot` |
| `wait download` | ✅ | `browser.downloads` |
| `type` / `fill` / `insert-text` | ✅ best-effort | injected caret insertion |
| `upload` / `set-file-input` | ⛔ | no `DOM.setFileInputFiles`; Firefox has no extension API for this |
| `cdp` (AX snapshot, native click, etc.) | ⛔ | no CDP |
| network capture | ⛔ | no CDP `Network.*` |
| frame-target operations | ⛔ | no CDP targets |

The `cdp`/network-capture failures are phrased so the CLI degrades cleanly
(`isUnsupportedNetworkCaptureError`) instead of failing hard. Commands that only
use CDP as a fallback — e.g. `browser click`, which tries a DOM click first —
still work through the non-CDP path.

## Requirements

- Firefox **128 or newer** (for `scripting.executeScript` main-world injection
  and `storage.session`).
- Node.js 22.12+ to run the Extension.js build.

## Develop

```bash
cd extension-firefox
npm install
npm run dev      # extension dev --browser=firefox
```

Extension.js launches an isolated Firefox profile with the extension loaded and
reloads on save.

## Build

```bash
npm install
npm run build    # extension build --browser=firefox → dist/firefox/
```

Load the built extension in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** and pick `dist/firefox/manifest.json`.

For a store-ready archive, `npm run build` and then
`npx extension build --browser=firefox --zip`, or use
`npm run package:release -- --out ../extension-firefox-package` to copy the built
folder.

## Tests

Tests live next to the sources and run under the repo's Vitest `extension-firefox`
project:

```bash
cd ..
npx vitest run --project extension-firefox
```

## Daemon compatibility

The extension talks to the same daemon on `localhost:19825` and identifies itself
with a `contextId` (browser profile) exactly like the Chrome bridge. Because the
daemon historically accepted only `chrome-extension://` origins, it now also
accepts `moz-extension://` (see `src/daemon-utils.ts`). If both a Chrome and a
Firefox profile are connected, choose one with `opencli --profile <name>` (or
`opencli profile use <name>`), the same as any two Chrome profiles.

## Differences from the Chrome bridge

- No visible "OpenCLI Browser"/"OpenCLI Adapter" tab group. Sessions lease tabs
  inside one owned window per surface; Firefox has no tab-group API.
- Page identity (`targetId`) is minted per tab and persisted in
  `browser.storage.session` rather than read from CDP targets. It survives
  event-page unloads and resets on browser restart — the same recovery window
  the Chrome bridge promises.
- `screenshot` returns the visible viewport; the CLI still receives bare base64.
