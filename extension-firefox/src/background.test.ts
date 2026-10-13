import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener<T extends (...args: any[]) => void> = {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

type MockTab = {
  id: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
};

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

const leaseKey = (surface: 'browser' | 'adapter', session: string): string =>
  `${surface}\u0000${encodeURIComponent(session)}`;

function createBrowserMock() {
  const localState: Record<string, unknown> = {};
  const sessionState: Record<string, unknown> = {};
  let nextTabId = 10;
  let nextWindowId = 100;
  let lastFocusedWindowId = 2;
  const onUpdatedListeners: Array<(tabId: number, info: { status?: string; url?: string }, tab: MockTab) => void> = [];

  const tabs: MockTab[] = [
    { id: 1, windowId: 1, url: 'https://automation.example', title: 'automation', active: true, status: 'complete' },
    { id: 2, windowId: 2, url: 'https://user.example', title: 'user', active: true, status: 'complete' },
  ];

  const byId = (tabId: number): MockTab => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  };

  const listenable = <T extends (...args: any[]) => void>(): Listener<T> => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });

  const onUpdated = listenable<(tabId: number, info: { status?: string; url?: string }, tab: MockTab) => void>();
  onUpdated.addListener.mockImplementation((listener) => {
    onUpdatedListeners.push(listener);
  });
  onUpdated.removeListener.mockImplementation((listener) => {
    const idx = onUpdatedListeners.indexOf(listener);
    if (idx >= 0) onUpdatedListeners.splice(idx, 1);
  });

  const browser = {
    runtime: {
      getManifest: vi.fn(() => ({ version: '1.0.24' })),
      sendMessage: vi.fn(),
      onInstalled: listenable(),
      onStartup: listenable(),
      onMessage: listenable(),
    },
    tabs: {
      query: vi.fn(async (info: Record<string, unknown> = {}) =>
        tabs.filter((tab) => {
          if (info.windowId !== undefined && tab.windowId !== info.windowId) return false;
          if (info.lastFocusedWindow && tab.windowId !== lastFocusedWindowId) return false;
          if (info.active !== undefined && !!tab.active !== info.active) return false;
          return true;
        }),
      ),
      get: vi.fn(async (tabId: number) => byId(tabId)),
      create: vi.fn(async ({ windowId, url, active }: { windowId?: number; url?: string; active?: boolean }) => {
        const tab: MockTab = {
          id: nextTabId++,
          windowId: windowId ?? nextWindowId++,
          url,
          title: url ?? 'blank',
          active: !!active,
          status: 'complete',
        };
        tabs.push(tab);
        return tab;
      }),
      update: vi.fn(async (tabId: number, updates: { active?: boolean; url?: string }) => {
        const tab = byId(tabId);
        if (typeof updates.url === 'string') {
          tab.url = updates.url;
          tab.status = 'complete';
          for (const listener of [...onUpdatedListeners]) {
            listener(tabId, { status: 'complete', url: tab.url }, tab);
          }
        }
        if (updates.active !== undefined) tab.active = !!updates.active;
        return tab;
      }),
      remove: vi.fn(async (tabId: number) => {
        const idx = tabs.findIndex((entry) => entry.id === tabId);
        if (idx >= 0) tabs.splice(idx, 1);
      }),
      captureTab: vi.fn(async () => 'data:image/png;base64,QUJD'),
      onUpdated,
      onRemoved: listenable(),
    },
    windows: {
      get: vi.fn(async (windowId: number) => ({ id: windowId, focused: windowId === lastFocusedWindowId })),
      create: vi.fn(async ({ url, focused }: { url?: string; focused?: boolean }) => {
        const windowId = nextWindowId++;
        tabs.push({
          id: nextTabId++,
          windowId,
          url: typeof url === 'string' ? url : 'about:blank',
          title: 'blank',
          active: true,
          status: 'complete',
        });
        return { id: windowId, focused: !!focused };
      }),
      update: vi.fn(async (windowId: number, props: Record<string, unknown>) => ({ id: windowId, ...props })),
      remove: vi.fn(async () => {}),
      onRemoved: listenable(),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: localState[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localState, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete localState[key];
        }),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionState[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionState, items);
        }),
      },
    },
    cookies: {
      getAll: vi.fn(async () => [
        { name: 'sid', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true },
      ]),
    },
    downloads: {
      search: vi.fn(async () => []),
      onCreated: listenable(),
      onChanged: listenable(),
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: listenable(),
    },
    scripting: {
      executeScript: vi.fn(async () => [{ result: { title: 'evaluated' } }]),
    },
  };

  return {
    browser,
    tabs,
    setLastFocusedWindowId: (windowId: number) => {
      lastFocusedWindowId = windowId;
    },
  };
}

async function loadBackground(browser: unknown) {
  (globalThis as { browser?: unknown }).browser = browser;
  const mod = await import('./background');
  // Let startup recovery + the (pending) connect() settle before the test sets state.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return mod;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('firefox background bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    // Keep the daemon ping pending unless a test explicitly controls it.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });

  afterEach(async () => {
    await flush();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses a Firefox-safe 1-minute keepalive alarm', async () => {
    const { browser } = createBrowserMock();
    await loadBackground(browser);

    expect(browser.alarms.create).toHaveBeenCalledWith('keepalive', { periodInMinutes: 1 });
  });

  it('evaluates exec through the page-script executor and returns a page id', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);
    const key = leaseKey('adapter', 'twitter');
    mod.__test__.setSession(key, { windowId: 1, owned: true, preferredTabId: 1 });

    const result = await mod.__test__.handleCommand({
      id: 'exec-1',
      action: 'exec',
      code: 'document.title',
      session: 'twitter',
      surface: 'adapter',
    });

    expect(result.ok).toBe(true);
    expect(result.page).toEqual(expect.any(String));
    expect(result.data).toEqual({ title: 'evaluated' });
    expect(browser.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 1 }, world: 'MAIN', args: ['document.title'] }),
    );
  });

  it('lists only automation-window web tabs with stable page ids', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);
    const key = leaseKey('adapter', 'twitter');
    mod.__test__.setSession(key, { windowId: 1, owned: true, preferredTabId: 1 });

    const result = await mod.__test__.handleCommand({
      id: 'list-1',
      action: 'tabs',
      op: 'list',
      session: 'twitter',
      surface: 'adapter',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({
        index: 0,
        page: expect.any(String),
        url: 'https://automation.example',
        title: 'automation',
      }),
    ]);
  });

  it('opens the first tab-new lease in a fresh owned window on the target URL', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);

    const result = await mod.__test__.handleCommand({
      id: 'new-1',
      action: 'tabs',
      op: 'new',
      url: 'https://first.example',
      session: 'default',
      surface: 'browser',
    });

    expect(result.ok).toBe(true);
    expect(browser.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://first.example' }),
    );
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it('treats a normalized same-URL navigate as already complete', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);
    browser.tabs.get.mockResolvedValueOnce({
      id: 1,
      windowId: 1,
      url: 'https://www.bilibili.com/',
      title: 'bilibili',
      active: true,
      status: 'complete',
    });
    const key = leaseKey('adapter', 'twitter');
    mod.__test__.setSession(key, { windowId: 1, owned: true, preferredTabId: 1 });

    const result = await mod.__test__.handleCommand({
      id: 'nav-same',
      action: 'navigate',
      url: 'https://www.bilibili.com',
      session: 'twitter',
      surface: 'adapter',
    });

    expect(result).toEqual({
      id: 'nav-same',
      ok: true,
      page: expect.any(String),
      data: { title: 'bilibili', url: 'https://www.bilibili.com/', timedOut: false },
    });
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it('resolves cookies through the Firefox cookies API', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);

    const result = await mod.__test__.handleCommand({
      id: 'cookies-1',
      action: 'cookies',
      domain: 'example.com',
      session: 'any',
    });

    expect(result).toEqual({
      id: 'cookies-1',
      ok: true,
      data: [
        {
          name: 'sid',
          value: 'abc',
          domain: 'example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          expirationDate: undefined,
        },
      ],
    });
  });

  it('returns a typed unsupported failure for CDP passthrough', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);

    const result = await mod.__test__.handleCommand({
      id: 'cdp-1',
      action: 'cdp',
      cdpMethod: 'Accessibility.getFullAXTree',
      session: 'twitter',
      surface: 'adapter',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_on_firefox' });
    expect(result.error).toMatch(/not supported on Firefox/i);
  });

  it.each(['network-capture-start', 'network-capture-read'])(
    'returns the CLI-degradable network-capture signature for %s',
    async (action) => {
      const { browser } = createBrowserMock();
      const mod = await loadBackground(browser);

      const result = await mod.__test__.handleCommand({ id: action, action: action as never, session: 'twitter' });
      const message = (result.error ?? '').toLowerCase();
      expect(message).toContain('network capture');
      expect(message).toContain('not supported');
      expect(result.errorCode).toBe('unsupported_on_firefox');
    },
  );

  it('returns unsupported failures for frames and set-file-input', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);

    const frames = await mod.__test__.handleCommand({ id: 'frames', action: 'frames', session: 'twitter' });
    const fileInput = await mod.__test__.handleCommand({
      id: 'file',
      action: 'set-file-input',
      files: ['/tmp/a'],
      session: 'twitter',
    });

    expect(frames).toMatchObject({ ok: false, errorCode: 'unsupported_on_firefox' });
    expect(fileInput).toMatchObject({ ok: false, errorCode: 'unsupported_on_firefox' });
  });

  it('binds to the active tab in the last focused window', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);
    browser.tabs.query.mockImplementation(async (info: Record<string, unknown> = {}) => {
      if (info.active && info.lastFocusedWindow) {
        return [{ id: 2, windowId: 2, url: 'https://user.example', title: 'user', active: true, status: 'complete' }];
      }
      return [{ id: 2, windowId: 2, url: 'https://user.example', title: 'user', active: true, status: 'complete' }];
    });

    const result = await mod.__test__.handleCommand({
      id: 'bind-1',
      action: 'bind',
      session: 'work',
      surface: 'browser',
    });

    expect(result.ok).toBe(true);
    expect(mod.__test__.getSession(leaseKey('browser', 'work'))).toMatchObject({
      owned: false,
      preferredTabId: 2,
    });
  });

  it('closes a tab by page identity and reports the page that was closed', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);
    const key = leaseKey('adapter', 'twitter');
    mod.__test__.setSession(key, { windowId: 1, owned: true, preferredTabId: 1 });

    const list = await mod.__test__.handleCommand({
      id: 'list-before-close',
      action: 'tabs',
      op: 'list',
      session: 'twitter',
      surface: 'adapter',
    });
    const page = (list.data as Array<{ page: string }>)[0].page;

    const result = await mod.__test__.handleCommand({
      id: 'close-by-page',
      action: 'tabs',
      op: 'close',
      session: 'twitter',
      surface: 'adapter',
      page,
    });

    expect(result).toEqual({ id: 'close-by-page', ok: true, data: { closed: page } });
    // The preferred lease is released back to a reusable placeholder, not removed.
    expect(browser.tabs.update).toHaveBeenCalledWith(1, { url: 'about:blank', active: true });
    expect(mod.__test__.getSession(key)).toBeNull();
  });

  it('backs off reconnect delay exponentially with a 15s cap', async () => {
    const { browser } = createBrowserMock();
    const mod = await loadBackground(browser);
    mod.__test__.resetReconnectState();

    mod.__test__.setReconnectAttempts(0);
    const first = mod.__test__.nextReconnectDelayMs();
    expect(first).toBeGreaterThanOrEqual(1_000);
    expect(first).toBeLessThan(1_500);

    mod.__test__.setReconnectAttempts(10);
    const capped = mod.__test__.nextReconnectDelayMs();
    expect(capped).toBeGreaterThanOrEqual(15_000);
    expect(capped).toBeLessThan(15_500);
  });

  it('answers the popup status message with the persisted context id', async () => {
    const { browser } = createBrowserMock();
    browser.storage.local.get.mockResolvedValue({ opencli_context_id_v1: 'abc123xy' });
    const mod = await loadBackground(browser);

    const listener = browser.runtime.onMessage.addListener.mock.calls[0][0] as (msg: unknown) => Promise<unknown>;
    const response = (await listener({ type: 'getStatus' })) as {
      contextId?: string;
      extensionVersion?: string;
      connected?: boolean;
    };

    expect(response.contextId).toBe('abc123xy');
    expect(response.extensionVersion).toBe('1.0.24');
    expect(response.connected).toBe(false);
    expect(mod.__test__.getReconnectAttempts).toBeTypeOf('function');
  });
});
