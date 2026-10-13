import { afterEach, describe, expect, it } from 'vitest';

import { createPageIdentity, IDENTITY_KEY } from './identity';
import type { StorageArea } from './browser-api';

function fakeArea(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { ...initial };
  const area: StorageArea = {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = state[k];
      return out;
    },
    async set(items) {
      Object.assign(state, items);
    },
    async remove(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const k of keys) delete state[k];
    },
  };
  return { area, state };
}

afterEach(() => {
  delete (globalThis as { browser?: unknown }).browser;
});

describe('createPageIdentity', () => {
  it('mints one stable page id per tab and persists it', async () => {
    const { area, state } = fakeArea();
    const identity = createPageIdentity(area);

    const page = await identity.resolvePage(7);
    expect(page.length).toBeGreaterThan(0);
    expect(await identity.resolvePage(7)).toBe(page);
    expect(await identity.resolveTabId(page)).toBe(7);
    expect((state[IDENTITY_KEY] as Record<string, number>)[page]).toBe(7);
  });

  it('reloads persisted mappings into a fresh instance (event-page unload recovery)', async () => {
    const { area } = fakeArea();
    const first = createPageIdentity(area);
    const page = await first.resolvePage(3);

    const second = createPageIdentity(area);
    expect(await second.resolveTabId(page)).toBe(3);
  });

  it('throws the exact CLI stale-identity signature for unknown pages', async () => {
    const { area } = fakeArea();
    const identity = createPageIdentity(area);
    await expect(identity.resolveTabId('missing')).rejects.toThrow(
      /Page not found: missing — stale page identity/,
    );
  });

  it('evicts a closed tab mapping', async () => {
    const { area } = fakeArea();
    const identity = createPageIdentity(area);
    const page = await identity.resolvePage(9);

    identity.evictTab(9);
    await expect(identity.resolveTabId(page)).rejects.toThrow(/stale page identity/);
  });

  it('peeks a page id without minting one', async () => {
    const { area } = fakeArea();
    const identity = createPageIdentity(area);
    expect(await identity.peekPage(4)).toBeUndefined();
    const page = await identity.resolvePage(4);
    expect(await identity.peekPage(4)).toBe(page);
  });

  it('degrades to a memory-only map without a storage area', async () => {
    const identity = createPageIdentity(null);
    const page = await identity.resolvePage(5);
    expect(await identity.resolveTabId(page)).toBe(5);
  });

  it('survives a storage read failure', async () => {
    const area: StorageArea = {
      async get() {
        throw new Error('storage disabled');
      },
      async set() {
        throw new Error('storage disabled');
      },
    };
    const identity = createPageIdentity(area);
    const page = await identity.resolvePage(2);
    expect(await identity.resolveTabId(page)).toBe(2);
  });
});
