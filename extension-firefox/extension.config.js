import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
const compatRange = pkg.opencli?.compatRange ?? '>=0.0.0';

/**
 * Extension.js config for the Firefox Browser Bridge.
 *
 * The project targets Firefox only, so every command defaults to the
 * `firefox` target. `__OPENCLI_COMPAT_RANGE__` is inlined into the bundle from
 * package.json (mirrors the Chrome extension's Vite `define`).
 *
 * @type {import('extension').FileConfig}
 */
export default {
  define: {
    __OPENCLI_COMPAT_RANGE__: compatRange,
  },
  commands: {
    dev: { browser: 'firefox' },
    start: { browser: 'firefox' },
    preview: { browser: 'firefox' },
    build: { browser: 'firefox' },
  },
};
