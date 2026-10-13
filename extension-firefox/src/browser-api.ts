/**
 * The slice of the Firefox WebExtension `browser.*` API this extension uses,
 * declared locally.
 *
 * We keep the surface local instead of depending on an external `@types`
 * package so (a) the project type-checks with no global type side effects and
 * (b) tests can stub `globalThis.browser` freely. Everything the bridge needs
 * is promise-based (Firefox semantics), never the Chrome `chrome.*` callback
 * form.
 */

export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

export interface WebExtEvent<T extends (...args: never[]) => unknown> {
  addListener(listener: T): void;
  removeListener?(listener: T): void;
  hasListener?(listener: T): boolean;
}

export interface BrowserTab {
  id?: number;
  windowId: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
}

export interface BrowserWindow {
  id?: number;
  focused?: boolean;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
}

export interface DownloadItem {
  id: number;
  filename: string;
  url: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state: 'in_progress' | 'complete' | 'interrupted';
  danger?: string;
  error?: string;
}

export interface DownloadDelta {
  id: number;
  filename?: { current?: string };
  url?: { current?: string };
  state?: { current?: DownloadItem['state'] };
}

export interface InjectionResult {
  result?: unknown;
  error?: unknown;
}

export interface WebExtensionApi {
  runtime: {
    getManifest(): { version: string };
    sendMessage(message: unknown): Promise<unknown>;
    onInstalled: WebExtEvent<() => void>;
    onStartup: WebExtEvent<() => void>;
    /**
     * Firefox delivers the listener's return value (including a Promise) back
     * to `runtime.sendMessage`, so this bridge answers status queries by
     * returning a Promise instead of the Chrome `sendResponse` callback.
     */
    onMessage: WebExtEvent<(message: unknown, sender: unknown) => unknown>;
  };
  tabs: {
    get(tabId: number): Promise<BrowserTab>;
    query(info?: Record<string, unknown>): Promise<BrowserTab[]>;
    create(props: Record<string, unknown>): Promise<BrowserTab>;
    update(tabId: number, props: Record<string, unknown>): Promise<BrowserTab>;
    remove(tabIds: number | number[]): Promise<void>;
    /** Firefox-only API used for viewport screenshots. */
    captureTab?(tabId?: number, options?: Record<string, unknown>): Promise<string>;
    onUpdated: WebExtEvent<(tabId: number, info: { status?: string; url?: string }, tab: BrowserTab) => void>;
    onRemoved: WebExtEvent<(tabId: number, info: unknown) => void>;
  };
  windows: {
    get(windowId: number, info?: Record<string, unknown>): Promise<BrowserWindow>;
    create(props: Record<string, unknown>): Promise<BrowserWindow>;
    update(windowId: number, props: Record<string, unknown>): Promise<BrowserWindow>;
    remove(windowId: number): Promise<void>;
    onRemoved: WebExtEvent<(windowId: number) => void>;
  };
  storage: {
    local: StorageArea;
    session?: StorageArea;
  };
  cookies: {
    getAll(details: Record<string, unknown>): Promise<BrowserCookie[]>;
  };
  downloads: {
    search(query: Record<string, unknown>): Promise<DownloadItem[]>;
    onCreated: WebExtEvent<(item: DownloadItem) => void>;
    onChanged: WebExtEvent<(delta: DownloadDelta) => void>;
  };
  alarms: {
    create(name: string, info: Record<string, unknown>): void | Promise<void>;
    clear(name: string): void | Promise<boolean>;
    onAlarm: WebExtEvent<(alarm: { name: string }) => void>;
  };
  scripting?: {
    executeScript(injection: Record<string, unknown>): Promise<InjectionResult[]>;
  };
}

/** Read the `browser.*` global, failing loudly when the code runs outside Firefox. */
export function getExt(): WebExtensionApi {
  const api = (globalThis as { browser?: WebExtensionApi }).browser;
  if (!api) {
    throw new Error('browser.* API is unavailable — this extension must run in Firefox');
  }
  return api;
}

export function hasExt(): boolean {
  return Boolean((globalThis as { browser?: WebExtensionApi }).browser);
}
