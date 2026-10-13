/**
 * Page identity mapping for the Firefox bridge — `page` (targetId) ↔ tabId.
 *
 * Chrome gets target ids from `chrome.debugger.getTargets()` (stable CDP UUIDs
 * owned by the browser). Firefox has no CDP, so the bridge mints its own stable
 * id per tab and persists the mapping in `storage.session`. That survives the
 * event page being unloaded (the case identity recovery exists for) and is
 * cleared exactly when the tab ids die (browser restart, extension reload).
 *
 * A miss is a hard error — never guess, matching the Chrome bridge contract the
 * CLI relies on (`isStalePageIdentityError`).
 */

import type { StorageArea } from './browser-api';

export const IDENTITY_KEY = 'opencli_firefox_page_identity_v1';

export interface PageIdentity {
  /** Get (or mint and persist) the stable page id for a tab. */
  resolvePage(tabId: number): Promise<string>;
  /** Resolve a page id back to its tab; throws when stale. */
  resolveTabId(page: string): Promise<number>;
  /** Read the page id for a tab without minting one (for close reporting). */
  peekPage(tabId: number): Promise<string | undefined>;
  /** Drop a closed tab's mapping. */
  evictTab(tabId: number): void;
  /** Test-only: forget in-memory state (persisted state is untouched). */
  reset(): void;
}

function mintPageId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function createPageIdentity(area: StorageArea | null): PageIdentity {
  let pageToTab = new Map<string, number>();
  let tabToPage = new Map<number, string>();
  let loaded = false;
  let loadPromise: Promise<void> | null = null;

  async function load(): Promise<void> {
    if (loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        if (area) {
          const raw = await area.get(IDENTITY_KEY);
          const stored = raw[IDENTITY_KEY] as Record<string, unknown> | undefined;
          if (stored && typeof stored === 'object') {
            for (const [page, tabId] of Object.entries(stored)) {
              if (typeof tabId === 'number') {
                pageToTab.set(page, tabId);
                tabToPage.set(tabId, page);
              }
            }
          }
        }
      } catch {
        // Storage unavailable — degrade to a memory-only identity map.
      } finally {
        loaded = true;
      }
    })();
    return loadPromise;
  }

  function persist(): void {
    if (!area) return;
    const snapshot: Record<string, number> = {};
    for (const [page, tabId] of pageToTab.entries()) snapshot[page] = tabId;
    void area.set({ [IDENTITY_KEY]: snapshot }).catch(() => {});
  }

  return {
    async resolvePage(tabId: number): Promise<string> {
      await load();
      const existing = tabToPage.get(tabId);
      if (existing) return existing;
      const page = mintPageId();
      tabToPage.set(tabId, page);
      pageToTab.set(page, tabId);
      persist();
      return page;
    },

    async resolveTabId(page: string): Promise<number> {
      await load();
      const tabId = pageToTab.get(page);
      if (tabId === undefined) {
        throw new Error(`Page not found: ${page} — stale page identity`);
      }
      return tabId;
    },

    async peekPage(tabId: number): Promise<string | undefined> {
      await load();
      return tabToPage.get(tabId);
    },

    evictTab(tabId: number): void {
      const page = tabToPage.get(tabId);
      if (page) pageToTab.delete(page);
      if (tabToPage.delete(tabId)) persist();
    },

    reset(): void {
      loaded = false;
      loadPromise = null;
      pageToTab = new Map();
      tabToPage = new Map();
    },
  };
}
