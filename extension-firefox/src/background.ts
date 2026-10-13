/**
 * OpenCLI — Firefox Browser Bridge (background event page).
 *
 * Connects to the opencli daemon via WebSocket, receives commands, dispatches
 * them to Firefox WebExtension APIs, and returns results. This is the Firefox
 * sibling of extension/src/background.ts; it speaks the same wire protocol so a
 * Firefox profile and a Chrome profile can share one daemon.
 *
 * What is intentionally different:
 *   - No `chrome.debugger` / CDP. `exec` runs page JS through
 *     `browser.scripting.executeScript({ world: "MAIN" })`; CDP-only actions
 *     (`cdp`, `frames`, network capture, set-file-input, full-page screenshots)
 *     return a typed `unsupported_on_firefox` failure.
 *   - No `chrome.tabGroups`. Sessions lease tabs inside one owned window per
 *     surface; there is no visible automation tab group.
 *   - Background is a Firefox MV3 event page (`background.scripts`), not a
 *     service worker, but it can still be unloaded — so durable state lives in
 *     `browser.storage.session` and recovery runs on every wake.
 */

declare const __OPENCLI_COMPAT_RANGE__: string;

import type { Command, Result } from './protocol';
import { DAEMON_HOST, DAEMON_PORT, DAEMON_WS_URL, DAEMON_PING_URL } from './protocol';
import { getExt, type BrowserTab, type StorageArea } from './browser-api';
import { CommandFailure, errorResult, unsupportedOnFirefox } from './errors';
import { createPageIdentity } from './identity';
import { createJournal } from './journal';
import * as executor from './executor';
import { waitForDownload } from './downloads';

// ─── Storage-backed collaborators ─────────────────────────────────────

function sessionStorage(): StorageArea | null {
  try {
    return getExt().storage?.session ?? null;
  } catch {
    return null;
  }
}

function localStorageArea(): StorageArea | null {
  try {
    return getExt().storage?.local ?? null;
  } catch {
    return null;
  }
}

const identity = createPageIdentity(sessionStorage());
const { executeWithJournal } = createJournal(sessionStorage());

// ─── Context id (browser profile identity) ────────────────────────────

const CONTEXT_ID_KEY = 'opencli_context_id_v1';
let currentContextId = 'default';
let contextIdPromise: Promise<string> | null = null;

async function getCurrentContextId(): Promise<string> {
  if (contextIdPromise) return contextIdPromise;
  contextIdPromise = (async () => {
    try {
      const local = localStorageArea();
      if (!local) return currentContextId;
      const raw = await local.get(CONTEXT_ID_KEY);
      const existing = raw[CONTEXT_ID_KEY];
      if (typeof existing === 'string' && existing.trim()) {
        currentContextId = existing.trim();
        return currentContextId;
      }
      const generated = generateContextId();
      await local.set({ [CONTEXT_ID_KEY]: generated });
      currentContextId = generated;
      return currentContextId;
    } catch {
      return currentContextId;
    }
  })();
  return contextIdPromise;
}

function generateContextId(): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const maxUnbiasedByte = Math.floor(256 / alphabet.length) * alphabet.length;
  let id = '';
  while (id.length < 8) {
    const bytes = new Uint8Array(8);
    try {
      crypto.getRandomValues(bytes);
    } catch {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    for (const byte of bytes) {
      if (byte >= maxUnbiasedByte) continue;
      id += alphabet[byte % alphabet.length];
      if (id.length === 8) break;
    }
  }
  return id;
}

// ─── Console log forwarding ──────────────────────────────────────────

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

function forwardLog(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  try {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    safeSend(ws, { type: 'log', level, msg, ts: Date.now() });
  } catch {
    /* don't recurse */
  }
}

function safeSend(socket: WebSocket | null | undefined, payload: unknown): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

console.log = (...args: unknown[]) => {
  _origLog(...args);
  forwardLog('info', args);
};
console.warn = (...args: unknown[]) => {
  _origWarn(...args);
  forwardLog('warn', args);
};
console.error = (...args: unknown[]) => {
  _origError(...args);
  forwardLog('error', args);
};

// ─── WebSocket connection ────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let connectInFlight: Promise<void> | null = null;
let workerReady: Promise<void> = Promise.resolve();
let workerRecovered = true;

function isDaemonSocketActive(socket: WebSocket | null | undefined = ws): boolean {
  return socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING;
}

/**
 * Probe the daemon via /ping before opening a WebSocket. A refused WebSocket
 * logs an uncatchable connection error; a failed fetch is silent. Keeping the
 * probe inside connect() means every call site inherits the guard.
 */
function connect(): Promise<void> {
  if (isDaemonSocketActive()) return Promise.resolve();
  if (connectInFlight) return connectInFlight;
  const attempt = workerRecovered ? connectAttempt() : workerReady.then(() => connectAttempt());
  connectInFlight = attempt.finally(() => {
    connectInFlight = null;
  });
  return connectInFlight;
}

async function connectAttempt(): Promise<void> {
  if (isDaemonSocketActive()) return;

  try {
    const res = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(1000),
      credentials: 'omit',
    });
    if (!res.ok) {
      console.warn(`[opencli] daemon ping failed: HTTP ${res.status}`);
      scheduleReconnect();
      return;
    }
    reconnectAttempts = 0;
  } catch {
    scheduleReconnect();
    return;
  }
  if (isDaemonSocketActive()) return;

  let thisWs: WebSocket;
  try {
    const contextId = await getCurrentContextId();
    if (isDaemonSocketActive()) return;
    thisWs = new WebSocket(DAEMON_WS_URL);
    ws = thisWs;
    currentContextId = contextId;
  } catch {
    scheduleReconnect();
    return;
  }

  thisWs.onopen = () => {
    if (ws !== thisWs) return;
    console.log('[opencli] Connected to daemon');
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    safeSend(thisWs, {
      type: 'hello',
      contextId: currentContextId,
      version: getExt().runtime.getManifest().version,
      compatRange: __OPENCLI_COMPAT_RANGE__,
    });
    startWsKeepalive(thisWs);
  };

  thisWs.onmessage = async (event) => {
    if (ws !== thisWs) return;
    try {
      const command = JSON.parse(event.data as string) as Command;
      const result = await executeWithJournal(command, handleCommand);
      const target = ws && ws.readyState === WebSocket.OPEN ? ws : thisWs;
      safeSend(target, result);
    } catch (err) {
      console.error('[opencli] Message handling error:', err);
    }
  };

  thisWs.onclose = () => {
    stopWsKeepalive(thisWs);
    if (ws !== thisWs) return;
    console.log('[opencli] Disconnected from daemon');
    ws = null;
    scheduleReconnect();
  };

  thisWs.onerror = () => {
    thisWs.close();
  };
}

// ─── WebSocket keepalive ─────────────────────────────────────────────

const WS_KEEPALIVE_INTERVAL_MS = 20_000;
let wsKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
let wsKeepaliveSocket: WebSocket | null = null;

function startWsKeepalive(socket: WebSocket): void {
  if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
  wsKeepaliveSocket = socket;
  wsKeepaliveTimer = setInterval(() => {
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) {
      stopWsKeepalive(socket);
      return;
    }
    safeSend(socket, { type: 'ping', ts: Date.now() });
  }, WS_KEEPALIVE_INTERVAL_MS);
}

function stopWsKeepalive(socket: WebSocket): void {
  if (wsKeepaliveSocket !== socket) return;
  if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
  wsKeepaliveTimer = null;
  wsKeepaliveSocket = null;
}

/**
 * Reconnect cadence: exponential backoff with jitter, capped at 15s. The
 * durable wake path is `browser.alarms` (Firefox clamps `periodInMinutes` up to
 * 1 minute); setTimeout provides the faster path while the event page is alive.
 */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;

function nextReconnectDelayMs(): number {
  const exp = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * 2 ** Math.min(reconnectAttempts, 6),
  );
  return exp + Math.floor(Math.random() * 500);
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = nextReconnectDelayMs();
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

// ─── Browser target leases ────────────────────────────────────────────

type BrowserSurface = 'browser' | 'adapter';
type LeaseOwnership = 'owned' | 'borrowed';
type LeaseLifecycle = 'ephemeral' | 'persistent' | 'pinned';
type WindowRole = 'interactive' | 'automation';
type WindowMode = 'foreground' | 'background';
type LeaseKind = 'owned' | 'bound';

type TargetLease = {
  session: string;
  surface: BrowserSurface;
  kind: LeaseKind;
  windowId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
  owned: boolean;
  preferredTabId: number | null;
  contextId: string;
  ownership: LeaseOwnership;
  lifecycle: LeaseLifecycle;
  windowRole: WindowRole;
};

const automationSessions = new Map<string, TargetLease>();
const IDLE_TIMEOUT_DEFAULT = 30_000;
const IDLE_TIMEOUT_INTERACTIVE = 600_000;
const IDLE_TIMEOUT_NONE = -1;
const REGISTRY_KEY = 'opencli_firefox_lease_registry_v1';
const LEASE_IDLE_ALARM_PREFIX = 'opencli:lease-idle:';
const LEASE_KEY_SEPARATOR = '\u0000';

let leaseMutationQueue: Promise<void> = Promise.resolve();

const ownedContainers: Record<
  WindowRole,
  { windowId: number | null; promise: Promise<{ windowId: number; initialTabId?: number }> | null }
> = {
  interactive: { windowId: null, promise: null },
  automation: { windowId: null, promise: null },
};

type StoredLease = Omit<TargetLease, 'idleTimer' | 'idleDeadlineAt'> & {
  idleDeadlineAt: number;
  updatedAt: number;
};

type StoredRegistry = {
  version: 1;
  contextId: string;
  ownedWindows: { interactive: number | null; automation: number | null };
  leases: Record<string, StoredLease>;
};

type SessionOverrides = {
  idleTimeoutMs?: number;
  windowMode?: WindowMode;
  lifecycle?: LeaseLifecycle;
};
const sessionOverrides = new Map<string, SessionOverrides>();

function setSessionOverride(key: string, patch: SessionOverrides): void {
  sessionOverrides.set(key, { ...sessionOverrides.get(key), ...patch });
}

const activeCommandCounts = new Map<string, number>();

function getLeaseKey(session: string, surface: BrowserSurface): string {
  return `${surface}${LEASE_KEY_SEPARATOR}${encodeURIComponent(session)}`;
}

function getSessionName(session?: string): string {
  const raw = session?.trim();
  if (!raw) {
    throw new CommandFailure(
      'session_required',
      'Browser session is required.',
      'Pass a browser session name, e.g. opencli browser <session> <command>.',
    );
  }
  return raw;
}

function getCommandSurface(cmd: Pick<Command, 'surface' | 'session'>): BrowserSurface {
  return cmd.surface === 'adapter' ? 'adapter' : 'browser';
}

function getSurfaceFromKey(key: string): BrowserSurface {
  return key.split(LEASE_KEY_SEPARATOR, 1)[0] === 'adapter' ? 'adapter' : 'browser';
}

function getSessionFromKey(key: string): string {
  const idx = key.indexOf(LEASE_KEY_SEPARATOR);
  if (idx === -1) return key;
  try {
    return decodeURIComponent(key.slice(idx + 1));
  } catch {
    return key.slice(idx + 1);
  }
}

function getIdleTimeout(key: string): number {
  const session = automationSessions.get(key);
  if (session?.kind === 'bound') return IDLE_TIMEOUT_NONE;
  const overrides = sessionOverrides.get(key);
  const adapterPersistent =
    getSurfaceFromKey(key) === 'adapter' &&
    (session?.lifecycle === 'persistent' || overrides?.lifecycle === 'persistent');
  if (adapterPersistent) return IDLE_TIMEOUT_NONE;
  if (overrides?.idleTimeoutMs !== undefined) return overrides.idleTimeoutMs;
  return getSurfaceFromKey(key) === 'browser' ? IDLE_TIMEOUT_INTERACTIVE : IDLE_TIMEOUT_DEFAULT;
}

function getLeaseLifecycle(key: string, kind: LeaseKind): LeaseLifecycle {
  if (kind === 'bound') return 'pinned';
  const override = sessionOverrides.get(key)?.lifecycle;
  if (override) return override;
  return getSurfaceFromKey(key) === 'browser' ? 'persistent' : 'ephemeral';
}

function getOwnedWindowRole(key: string): WindowRole {
  return getSurfaceFromKey(key) === 'browser' ? 'interactive' : 'automation';
}

function getWindowRole(key: string, ownership: LeaseOwnership): WindowRole {
  return ownership === 'borrowed' ? 'interactive' : getOwnedWindowRole(key);
}

function getWindowMode(key: string): WindowMode {
  return (
    sessionOverrides.get(key)?.windowMode ??
    (getOwnedWindowRole(key) === 'interactive' ? 'foreground' : 'background')
  );
}

function makeAlarmName(leaseKey: string): string {
  return `${LEASE_IDLE_ALARM_PREFIX}${encodeURIComponent(leaseKey)}`;
}

function leaseKeyFromAlarmName(name: string): string | null {
  if (!name.startsWith(LEASE_IDLE_ALARM_PREFIX)) return null;
  try {
    return decodeURIComponent(name.slice(LEASE_IDLE_ALARM_PREFIX.length));
  } catch {
    return null;
  }
}

function withLeaseMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = leaseMutationQueue.then(fn, fn);
  leaseMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function makeSession(
  key: string,
  session: Omit<
    TargetLease,
    'idleTimer' | 'idleDeadlineAt' | 'contextId' | 'ownership' | 'lifecycle' | 'windowRole'
  >,
): Omit<TargetLease, 'idleTimer' | 'idleDeadlineAt'> {
  const ownership: LeaseOwnership = session.owned ? 'owned' : 'borrowed';
  return {
    ...session,
    contextId: currentContextId,
    ownership,
    lifecycle: getLeaseLifecycle(key, session.kind),
    windowRole: getWindowRole(key, ownership),
  };
}

function emptyRegistry(): StoredRegistry {
  return {
    version: 1,
    contextId: currentContextId,
    ownedWindows: {
      interactive: ownedContainers.interactive.windowId,
      automation: ownedContainers.automation.windowId,
    },
    leases: {},
  };
}

async function readRegistry(): Promise<StoredRegistry> {
  try {
    const session = sessionStorage();
    if (!session) return emptyRegistry();
    const raw = await session.get(REGISTRY_KEY);
    const stored = raw[REGISTRY_KEY] as Partial<StoredRegistry> | undefined;
    if (!stored || stored.version !== 1 || typeof stored.leases !== 'object') {
      return emptyRegistry();
    }
    const storedWindows = stored.ownedWindows && typeof stored.ownedWindows === 'object'
      ? stored.ownedWindows
      : emptyRegistry().ownedWindows;
    return {
      version: 1,
      contextId: currentContextId,
      ownedWindows: {
        interactive: typeof storedWindows.interactive === 'number' ? storedWindows.interactive : null,
        automation: typeof storedWindows.automation === 'number' ? storedWindows.automation : null,
      },
      leases: stored.leases as Record<string, StoredLease>,
    };
  } catch {
    return emptyRegistry();
  }
}

async function writeRegistry(registry: StoredRegistry): Promise<void> {
  try {
    await sessionStorage()?.set({ [REGISTRY_KEY]: registry });
  } catch {
    // Registry persistence is a recovery aid; command execution should not fail on storage errors.
  }
}

async function persistRuntimeState(): Promise<void> {
  const leases: Record<string, StoredLease> = {};
  for (const [leaseKey, session] of automationSessions.entries()) {
    leases[leaseKey] = {
      session: session.session,
      surface: session.surface,
      kind: session.kind,
      windowId: session.windowId,
      owned: session.owned,
      preferredTabId: session.preferredTabId,
      contextId: session.contextId,
      ownership: session.ownership,
      lifecycle: session.lifecycle,
      windowRole: session.windowRole,
      idleDeadlineAt: session.idleDeadlineAt,
      updatedAt: Date.now(),
    };
  }
  await writeRegistry({
    version: 1,
    contextId: currentContextId,
    ownedWindows: {
      interactive: ownedContainers.interactive.windowId,
      automation: ownedContainers.automation.windowId,
    },
    leases,
  });
}

function scheduleIdleAlarm(leaseKey: string, timeout: number): void {
  const alarmName = makeAlarmName(leaseKey);
  try {
    const alarms = getExt().alarms;
    if (timeout > 0) {
      void alarms.create(alarmName, { when: Date.now() + timeout });
    } else {
      void alarms.clear(alarmName);
    }
  } catch {
    // setTimeout remains the in-process fast path; alarms are the wake recovery path.
  }
}

async function removeLeaseSession(leaseKey: string): Promise<void> {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  automationSessions.delete(leaseKey);
  sessionOverrides.delete(leaseKey);
  scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
  await persistRuntimeState();
}

function resetWindowIdleTimer(leaseKey: string, remainingMs?: number): void {
  const session = automationSessions.get(leaseKey);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  if (timeout <= 0) {
    scheduleIdleAlarm(leaseKey, timeout);
    session.idleTimer = null;
    session.idleDeadlineAt = 0;
    void persistRuntimeState();
    return;
  }
  const interval = remainingMs === undefined ? timeout : Math.max(0, Math.min(remainingMs, timeout));
  scheduleIdleAlarm(leaseKey, interval);
  session.idleDeadlineAt = Date.now() + interval;
  void persistRuntimeState();
  session.idleTimer = setTimeout(async () => {
    if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) return;
    await releaseLease(leaseKey, 'idle timeout');
  }, interval);
}

// ─── URL helpers ─────────────────────────────────────────────────────

/** Internal blank page used when no user URL is provided. */
const BLANK_PAGE = 'about:blank';

function isDebuggableUrl(url?: string): boolean {
  if (!url) return true;
  return url.startsWith('http://') || url.startsWith('https://') || url === BLANK_PAGE || url.startsWith('data:');
}

function isSafeNavigationUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function normalizeUrlForComparison(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')
    ) {
      parsed.port = '';
    }
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function isTargetUrl(currentUrl: string | undefined, targetUrl: string): boolean {
  return normalizeUrlForComparison(currentUrl) === normalizeUrlForComparison(targetUrl);
}

function isMissingWindowError(message: string): boolean {
  return /No window with id|Invalid window ID|Window \d+ not found|no longer exists/i.test(message);
}

// ─── Owned windows & tab leases ───────────────────────────────────────

async function focusOwnedWindowIfRequested(windowId: number, mode: WindowMode): Promise<void> {
  if (mode !== 'foreground') return;
  try {
    await getExt().windows.update(windowId, { focused: true });
  } catch {
    // Best effort.
  }
}

async function waitForTabComplete(tabId: number): Promise<void> {
  const ext = getExt();
  try {
    const tab = await ext.tabs.get(tabId);
    if (tab.status === 'complete') return;
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      ext.tabs.onUpdated.removeListener?.(listener);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    timeout = setTimeout(finish, 500);
    ext.tabs.onUpdated.addListener(listener);
  });
}

function initialTabIsAvailable(tabId: number | undefined): tabId is number {
  if (tabId === undefined) return false;
  for (const session of automationSessions.values()) {
    if (session.owned && session.preferredTabId === tabId) return false;
  }
  return true;
}

async function findReusableOwnedContainerTab(windowId: number): Promise<number | undefined> {
  const tabs = await getExt().tabs.query({ windowId });
  const placeholder = tabs.find(
    (tab) =>
      tab.id !== undefined &&
      initialTabIsAvailable(tab.id) &&
      isDebuggableUrl(tab.url) &&
      !isSafeNavigationUrl(tab.url ?? ''),
  );
  if (placeholder?.id !== undefined) return placeholder.id;
  const anyAvailable = tabs.find(
    (tab) => tab.id !== undefined && initialTabIsAvailable(tab.id) && isDebuggableUrl(tab.url),
  );
  return anyAvailable?.id;
}

async function ensureOwnedContainerWindow(
  role: WindowRole,
  initialUrl?: string,
  mode: WindowMode = 'background',
): Promise<{ windowId: number; initialTabId?: number }> {
  const container = ownedContainers[role];
  if (container.promise) return container.promise;
  container.promise = ensureOwnedContainerWindowUnlocked(role, initialUrl, mode).finally(() => {
    container.promise = null;
  });
  return container.promise;
}

async function ensureOwnedContainerWindowUnlocked(
  role: WindowRole,
  initialUrl?: string,
  mode: WindowMode = 'background',
): Promise<{ windowId: number; initialTabId?: number }> {
  const ext = getExt();
  const container = ownedContainers[role];

  if (container.windowId !== null) {
    const windowId = container.windowId;
    try {
      await ext.windows.get(windowId);
      await focusOwnedWindowIfRequested(windowId, mode);
      const initialTabId = await findReusableOwnedContainerTab(windowId);
      return { windowId, initialTabId };
    } catch (err) {
      if (!(err instanceof Error) || !isMissingWindowError(err.message)) throw err;
      console.warn(`[opencli] Owned ${role} window ${windowId} is unavailable: ${err.message}`);
      container.windowId = null;
    }
  }

  const startUrl = initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  const win = await ext.windows.create({
    url: startUrl,
    focused: mode === 'foreground',
    width: 1280,
    height: 900,
    type: 'normal',
  });
  if (win.id === undefined) throw new Error(`Failed to create owned ${role} window`);
  container.windowId = win.id;
  // Persist before further awaits so a crash cannot spawn a second owned window.
  await persistRuntimeState();
  console.log(`[opencli] Created owned ${role} window ${container.windowId} (start=${startUrl})`);

  const tabs = await ext.tabs.query({ windowId: win.id });
  const initialTabId = tabs[0]?.id;
  if (initialTabId !== undefined) await waitForTabComplete(initialTabId);
  return { windowId: win.id, initialTabId };
}

type ResolvedTab = { tabId: number; tab: BrowserTab | null };

async function createOwnedTabLease(leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  return withLeaseMutation(() => createOwnedTabLeaseUnlocked(leaseKey, initialUrl));
}

async function createOwnedTabLeaseUnlocked(leaseKey: string, initialUrl?: string): Promise<ResolvedTab> {
  const ext = getExt();
  const targetUrl = initialUrl && isSafeNavigationUrl(initialUrl) ? initialUrl : BLANK_PAGE;
  const role = getOwnedWindowRole(leaseKey);
  const { windowId, initialTabId } = await ensureOwnedContainerWindow(
    role,
    targetUrl,
    getWindowMode(leaseKey),
  );

  let tab: BrowserTab;
  if (initialTabIsAvailable(initialTabId)) {
    tab = await ext.tabs.get(initialTabId);
    if (!isTargetUrl(tab.url, targetUrl)) {
      tab = await ext.tabs.update(initialTabId, { url: targetUrl });
      await new Promise((resolve) => setTimeout(resolve, 300));
      tab = await ext.tabs.get(initialTabId);
    }
  } else {
    tab = await ext.tabs.create({ windowId, url: targetUrl, active: true });
  }

  const tabId = tab.id;
  if (!tabId) throw new Error('Failed to create tab lease in owned container');
  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: 'owned',
    windowId: tab.windowId,
    owned: true,
    preferredTabId: tabId,
  });
  resetWindowIdleTimer(leaseKey);
  return { tabId, tab };
}

function setLeaseSession(
  leaseKey: string,
  session: Omit<
    TargetLease,
    'idleTimer' | 'idleDeadlineAt' | 'contextId' | 'ownership' | 'lifecycle' | 'windowRole'
  >,
): void {
  const existing = automationSessions.get(leaseKey);
  if (existing?.idleTimer) clearTimeout(existing.idleTimer);
  const timeout = getIdleTimeout(leaseKey);
  automationSessions.set(leaseKey, {
    ...makeSession(leaseKey, session),
    idleTimer: null,
    idleDeadlineAt: timeout <= 0 ? 0 : Date.now() + timeout,
  });
  void persistRuntimeState();
}

async function resolveCommandTabId(cmd: Command): Promise<number | undefined> {
  if (cmd.page) return identity.resolveTabId(cmd.page);
  return undefined;
}

async function resolveTab(
  tabId: number | undefined,
  leaseKey: string,
  initialUrl?: string,
): Promise<ResolvedTab> {
  const ext = getExt();
  const existingSession = automationSessions.get(leaseKey);

  if (tabId !== undefined) {
    try {
      const tab = await ext.tabs.get(tabId);
      const matchesSession = existingSession ? existingSession.preferredTabId === tabId : false;
      if (isDebuggableUrl(tab.url) && matchesSession) return { tabId, tab };
      if (existingSession && !existingSession.owned) {
        throw new CommandFailure(
          matchesSession ? 'bound_tab_not_debuggable' : 'bound_tab_mismatch',
          matchesSession
            ? `Bound tab for session "${existingSession.session}" is not debuggable (${tab.url ?? 'unknown URL'}).`
            : `Target tab is not the tab bound to session "${existingSession.session}".`,
          'Run "opencli browser bind" again on a debuggable http(s) tab.',
        );
      }
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      if (existingSession && !existingSession.owned) {
        automationSessions.delete(leaseKey);
        throw new CommandFailure(
          'bound_tab_gone',
          `Bound tab for session "${existingSession.session}" no longer exists.`,
          'Run "opencli browser bind" again, then retry the command.',
        );
      }
      console.warn(`[opencli] Tab ${tabId} no longer exists, re-resolving`);
    }
  }

  const existingPreferredTabId = existingSession?.preferredTabId ?? null;
  if (existingSession && existingPreferredTabId !== null) {
    try {
      const preferredTab = await ext.tabs.get(existingPreferredTabId);
      if (isDebuggableUrl(preferredTab.url)) {
        return { tabId: preferredTab.id!, tab: preferredTab };
      }
      if (!existingSession.owned) {
        throw new CommandFailure(
          'bound_tab_not_debuggable',
          `Bound tab for session "${existingSession.session}" is not debuggable (${preferredTab.url ?? 'unknown URL'}).`,
          'Switch the tab to an http(s) page or run "opencli browser bind" on another tab.',
        );
      }
    } catch (err) {
      if (err instanceof CommandFailure) throw err;
      await removeLeaseSession(leaseKey);
      if (!existingSession.owned) {
        throw new CommandFailure(
          'bound_tab_gone',
          `Bound tab for session "${existingSession.session}" no longer exists.`,
          'Run "opencli browser bind" again, then retry the command.',
        );
      }
      return createOwnedTabLease(leaseKey, initialUrl);
    }
  }

  return createOwnedTabLease(leaseKey, initialUrl);
}

async function resolveTabId(tabId: number | undefined, leaseKey: string, initialUrl?: string): Promise<number> {
  const resolved = await resolveTab(tabId, leaseKey, initialUrl);
  return resolved.tabId;
}

async function pageScopedResult(id: string, tabId: number, data?: unknown): Promise<Result> {
  const page = await identity.resolvePage(tabId);
  return { id, ok: true, data, page };
}

async function listAutomationTabs(leaseKey: string): Promise<BrowserTab[]> {
  const session = automationSessions.get(leaseKey);
  if (!session) return [];
  if (session.preferredTabId !== null) {
    try {
      return [await getExt().tabs.get(session.preferredTabId)];
    } catch {
      automationSessions.delete(leaseKey);
      return [];
    }
  }
  try {
    return await getExt().tabs.query({ windowId: session.windowId });
  } catch {
    automationSessions.delete(leaseKey);
    return [];
  }
}

async function listAutomationWebTabs(leaseKey: string): Promise<BrowserTab[]> {
  const tabs = await listAutomationTabs(leaseKey);
  return tabs.filter((tab) => isDebuggableUrl(tab.url));
}

// ─── Command dispatch ─────────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  const session = getSessionName(cmd.session);
  const surface = getCommandSurface(cmd);
  const leaseKey = getLeaseKey(session, surface);
  if (cmd.windowMode === 'foreground' || cmd.windowMode === 'background') {
    setSessionOverride(leaseKey, { windowMode: cmd.windowMode });
  }
  if (surface === 'adapter' && (cmd.siteSession === 'persistent' || cmd.siteSession === 'ephemeral')) {
    setSessionOverride(leaseKey, { lifecycle: cmd.siteSession });
  }
  if (cmd.idleTimeout != null && cmd.idleTimeout > 0) {
    setSessionOverride(leaseKey, { idleTimeoutMs: cmd.idleTimeout * 1000 });
  }
  resetWindowIdleTimer(leaseKey);
  activeCommandCounts.set(leaseKey, (activeCommandCounts.get(leaseKey) ?? 0) + 1);
  try {
    switch (cmd.action) {
      case 'exec':
        return await handleExec(cmd, leaseKey);
      case 'navigate':
        return await handleNavigate(cmd, leaseKey);
      case 'tabs':
        return await handleTabs(cmd, leaseKey);
      case 'cookies':
        return await handleCookies(cmd);
      case 'screenshot':
        return await handleScreenshot(cmd, leaseKey);
      case 'close-window':
        return await handleCloseWindow(cmd, leaseKey);
      case 'cdp':
        return await handleUnsupported(cmd, 'CDP passthrough');
      case 'frames':
        return await handleUnsupported(cmd, 'Frame enumeration');
      case 'set-file-input':
        return await handleUnsupported(cmd, 'Programmatic file input', 'Firefox has no DOM.setFileInputFiles');
      case 'insert-text':
        return await handleInsertText(cmd, leaseKey);
      case 'bind':
        return await handleBind(cmd, leaseKey);
      case 'network-capture-start':
        return await handleUnsupported(cmd, 'Network capture');
      case 'network-capture-read':
        return await handleUnsupported(cmd, 'Network capture');
      case 'wait-download':
        return await handleWaitDownload(cmd);
      case 'sessions':
      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return errorResult(cmd.id, err);
  } finally {
    const remaining = (activeCommandCounts.get(leaseKey) ?? 1) - 1;
    if (remaining <= 0) activeCommandCounts.delete(leaseKey);
    else activeCommandCounts.set(leaseKey, remaining);
    resetWindowIdleTimer(leaseKey);
  }
}

async function handleUnsupported(cmd: Command, feature: string, detail?: string): Promise<Result> {
  return errorResult(cmd.id, unsupportedOnFirefox(feature, detail));
}

async function handleExec(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.code) return { id: cmd.id, ok: false, error: 'Missing code' };
  if (cmd.frameIndex != null) {
    return errorResult(cmd.id, unsupportedOnFirefox('Cross-frame execution'));
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await executor.evaluate(tabId, cmd.code);
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleNavigate(cmd: Command, leaseKey: string): Promise<Result> {
  if (!cmd.url) return { id: cmd.id, ok: false, error: 'Missing url' };
  if (!isSafeNavigationUrl(cmd.url)) {
    return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
  }
  const ext = getExt();
  const cmdTabId = await resolveCommandTabId(cmd);
  const resolved = await resolveTab(cmdTabId, leaseKey, cmd.url);
  const tabId = resolved.tabId;

  const beforeTab = resolved.tab ?? (await ext.tabs.get(tabId));
  const beforeNormalized = normalizeUrlForComparison(beforeTab.url);
  const targetUrl = cmd.url;

  if (beforeTab.status === 'complete' && isTargetUrl(beforeTab.url, targetUrl)) {
    return pageScopedResult(cmd.id, tabId, { title: beforeTab.title, url: beforeTab.url, timedOut: false });
  }

  await ext.tabs.update(tabId, { url: targetUrl });

  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      ext.tabs.onUpdated.removeListener?.(listener);
      if (checkTimer) clearTimeout(checkTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    };
    const isNavigationDone = (url: string | undefined): boolean =>
      isTargetUrl(url, targetUrl) || normalizeUrlForComparison(url) !== beforeNormalized;
    const listener = (id: number, info: { status?: string; url?: string }, tab: BrowserTab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && isNavigationDone(tab.url ?? info.url)) finish();
    };
    ext.tabs.onUpdated.addListener(listener);

    checkTimer = setTimeout(async () => {
      try {
        const currentTab = await ext.tabs.get(tabId);
        if (currentTab.status === 'complete' && isNavigationDone(currentTab.url)) finish();
      } catch {
        /* tab gone */
      }
    }, 100);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.warn(`[opencli] Navigate to ${targetUrl} timed out after 15s`);
      finish();
    }, 15000);
  });

  const tab = await ext.tabs.get(tabId);
  return pageScopedResult(cmd.id, tabId, { title: tab.title, url: tab.url, timedOut });
}

function preferOwnedTab(leaseKey: string, tabId: number): void {
  const session = automationSessions.get(leaseKey);
  if (!session?.owned) return;
  setLeaseSession(leaseKey, {
    session: session.session,
    surface: session.surface,
    kind: session.kind,
    windowId: session.windowId,
    owned: true,
    preferredTabId: tabId,
  });
}

async function handleTabs(cmd: Command, leaseKey: string): Promise<Result> {
  const ext = getExt();
  const session = automationSessions.get(leaseKey);
  if (session && !session.owned && cmd.op !== 'list') {
    return {
      id: cmd.id,
      ok: false,
      errorCode: 'bound_tab_mutation_blocked',
      error: `Session "${session.session}" is bound to a user tab; tab new/select/close requires an owned OpenCLI session.`,
      errorHint: 'Unbind the session first, or use a different session for owned OpenCLI tabs.',
    };
  }
  switch (cmd.op) {
    case 'list': {
      const tabs = await listAutomationWebTabs(leaseKey);
      const data = await Promise.all(
        tabs.map(async (t, i) => {
          let page: string | undefined;
          try {
            page = t.id ? await identity.resolvePage(t.id) : undefined;
          } catch {
            /* skip */
          }
          return { index: i, page, url: t.url, title: t.title, active: t.active };
        }),
      );
      return { id: cmd.id, ok: true, data };
    }
    case 'new': {
      if (cmd.url && !isSafeNavigationUrl(cmd.url)) {
        return { id: cmd.id, ok: false, error: 'Blocked URL scheme -- only http:// and https:// are allowed' };
      }
      if (!automationSessions.has(leaseKey)) {
        const created = await createOwnedTabLease(leaseKey, cmd.url);
        return pageScopedResult(cmd.id, created.tabId, { url: created.tab?.url });
      }
      const windowId = await ensureOwnedContainerWindow(
        getOwnedWindowRole(leaseKey),
        undefined,
        getWindowMode(leaseKey),
      );
      const tab = await ext.tabs.create({ windowId: windowId.windowId, url: cmd.url ?? BLANK_PAGE, active: true });
      const tabId = tab.id;
      if (!tabId) return { id: cmd.id, ok: false, error: 'Failed to create tab' };
      setLeaseSession(leaseKey, {
        session: getSessionFromKey(leaseKey),
        surface: getSurfaceFromKey(leaseKey),
        kind: 'owned',
        windowId: tab.windowId,
        owned: true,
        preferredTabId: tabId,
      });
      resetWindowIdleTimer(leaseKey);
      return pageScopedResult(cmd.id, tabId, { url: tab.url });
    }
    case 'close': {
      if (cmd.index !== undefined) {
        const tabs = await listAutomationWebTabs(leaseKey);
        const target = tabs[cmd.index];
        if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
        const closedPage = await identity.peekPage(target.id);
        const currentSession = automationSessions.get(leaseKey);
        if (currentSession?.preferredTabId === target.id) {
          await releaseLease(leaseKey, 'tab close');
        } else {
          identity.evictTab(target.id);
          await ext.tabs.remove(target.id);
        }
        return { id: cmd.id, ok: true, data: { closed: closedPage } };
      }
      if (cmd.page !== undefined && session?.owned) {
        let tabId: number | undefined;
        try {
          tabId = await resolveCommandTabId(cmd);
        } catch {
          return { id: cmd.id, ok: false, error: 'Page no longer exists' };
        }
        if (tabId === undefined) return { id: cmd.id, ok: false, error: 'Page no longer exists' };
        let tab: BrowserTab;
        try {
          tab = await ext.tabs.get(tabId);
        } catch {
          return { id: cmd.id, ok: false, error: 'Page no longer exists' };
        }
        if (tab.windowId !== session.windowId) {
          return { id: cmd.id, ok: false, error: 'Page is not in the automation container' };
        }
        const closedPage = await identity.peekPage(tabId);
        if (session.preferredTabId === tabId) {
          await releaseLease(leaseKey, 'tab close');
        } else {
          identity.evictTab(tabId);
          await ext.tabs.remove(tabId);
        }
        return { id: cmd.id, ok: true, data: { closed: closedPage } };
      }
      const cmdTabId = await resolveCommandTabId(cmd);
      const tabId = await resolveTabId(cmdTabId, leaseKey);
      const closedPage = await identity.peekPage(tabId);
      const currentSession = automationSessions.get(leaseKey);
      if (currentSession?.preferredTabId === tabId) {
        await releaseLease(leaseKey, 'tab close');
      } else {
        identity.evictTab(tabId);
        await ext.tabs.remove(tabId);
      }
      return { id: cmd.id, ok: true, data: { closed: closedPage } };
    }
    case 'select': {
      if (cmd.index === undefined && cmd.page === undefined) {
        return { id: cmd.id, ok: false, error: 'Missing index or page' };
      }
      const cmdTabId = await resolveCommandTabId(cmd);
      if (cmdTabId !== undefined) {
        const currentSession = automationSessions.get(leaseKey);
        let tab: BrowserTab;
        try {
          tab = await ext.tabs.get(cmdTabId);
        } catch {
          return { id: cmd.id, ok: false, error: 'Page no longer exists' };
        }
        if (!currentSession || tab.windowId !== currentSession.windowId) {
          return { id: cmd.id, ok: false, error: 'Page is not in the automation container' };
        }
        await ext.tabs.update(cmdTabId, { active: true });
        preferOwnedTab(leaseKey, cmdTabId);
        return pageScopedResult(cmd.id, cmdTabId, { selected: true });
      }
      const tabs = await listAutomationWebTabs(leaseKey);
      const target = tabs[cmd.index!];
      if (!target?.id) return { id: cmd.id, ok: false, error: `Tab index ${cmd.index} not found` };
      await ext.tabs.update(target.id, { active: true });
      preferOwnedTab(leaseKey, target.id);
      return pageScopedResult(cmd.id, target.id, { selected: true });
    }
    default:
      return { id: cmd.id, ok: false, error: `Unknown tabs op: ${cmd.op}` };
  }
}

async function handleCookies(cmd: Command): Promise<Result> {
  if (!cmd.domain && !cmd.url) {
    return { id: cmd.id, ok: false, error: 'Cookie scope required: provide domain or url to avoid dumping all cookies' };
  }
  const details: Record<string, unknown> = {};
  if (cmd.domain) details.domain = cmd.domain;
  if (cmd.url) details.url = cmd.url;
  const cookies = await getExt().cookies.getAll(details);
  const data = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
  }));
  return { id: cmd.id, ok: true, data };
}

async function handleScreenshot(cmd: Command, leaseKey: string): Promise<Result> {
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    const data = await executor.screenshot(tabId, {
      format: cmd.format,
      quality: cmd.quality,
      fullPage: cmd.fullPage,
      width: cmd.width,
      height: cmd.height,
    });
    return pageScopedResult(cmd.id, tabId, data);
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleInsertText(cmd: Command, leaseKey: string): Promise<Result> {
  if (typeof cmd.text !== 'string') {
    return { id: cmd.id, ok: false, error: 'Missing text payload' };
  }
  const cmdTabId = await resolveCommandTabId(cmd);
  const tabId = await resolveTabId(cmdTabId, leaseKey);
  try {
    await executor.insertText(tabId, cmd.text);
    return pageScopedResult(cmd.id, tabId, { inserted: true });
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleWaitDownload(cmd: Command): Promise<Result> {
  try {
    const data = await waitForDownload(cmd.pattern ?? '', cmd.timeoutMs ?? 30_000);
    return { id: cmd.id, ok: true, data };
  } catch (err) {
    return errorResult(cmd.id, err);
  }
}

async function handleBind(cmd: Command, leaseKey: string): Promise<Result> {
  const ext = getExt();
  const existing = automationSessions.get(leaseKey);
  if (existing?.owned) await releaseLease(leaseKey, 'rebind');

  const activeTabs = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  const fallbackTabs = await ext.tabs.query({ lastFocusedWindow: true });
  const boundTab =
    activeTabs.find((tab) => isDebuggableUrl(tab.url)) ??
    fallbackTabs.find((tab) => isDebuggableUrl(tab.url));
  if (!boundTab?.id) {
    return {
      id: cmd.id,
      ok: false,
      errorCode: 'bound_tab_not_found',
      error: 'No debuggable tab found in the current window',
      errorHint: 'Focus the target Firefox tab/window, then retry bind.',
    };
  }

  setLeaseSession(leaseKey, {
    session: getSessionFromKey(leaseKey),
    surface: getSurfaceFromKey(leaseKey),
    kind: 'bound',
    windowId: boundTab.windowId,
    owned: false,
    preferredTabId: boundTab.id,
  });
  resetWindowIdleTimer(leaseKey);
  console.log(`[opencli] Session ${getSessionFromKey(leaseKey)} explicitly bound to tab ${boundTab.id} (${boundTab.url})`);
  return pageScopedResult(cmd.id, boundTab.id, {
    url: boundTab.url,
    title: boundTab.title,
    session: getSessionFromKey(leaseKey),
  });
}

async function handleCloseWindow(cmd: Command, leaseKey: string): Promise<Result> {
  const sessionName = automationSessions.get(leaseKey)?.session ?? getSessionFromKey(leaseKey);
  await releaseLease(leaseKey, 'explicit close');
  return { id: cmd.id, ok: true, data: { closed: true, session: sessionName } };
}

async function releaseLease(leaseKey: string, reason = 'released'): Promise<void> {
  const ext = getExt();
  const session = automationSessions.get(leaseKey);
  if (!session) {
    sessionOverrides.delete(leaseKey);
    scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
    await persistRuntimeState();
    return;
  }

  if (session.idleTimer) clearTimeout(session.idleTimer);
  scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);

  if (session.owned && session.preferredTabId !== null) {
    const tabId = session.preferredTabId;
    identity.evictTab(tabId);
    const hasOtherOwnedLease = [...automationSessions.entries()].some(
      ([otherLease, otherSession]) =>
        otherLease !== leaseKey &&
        otherSession.owned &&
        otherSession.windowId === session.windowId &&
        otherSession.preferredTabId !== null,
    );
    if (hasOtherOwnedLease) {
      await ext.tabs.remove(tabId).catch(() => {});
      console.log(`[opencli] Released owned tab lease ${tabId} (session=${session.session}, ${reason})`);
    } else {
      try {
        await ext.tabs.update(tabId, { url: BLANK_PAGE, active: true });
        console.log(`[opencli] Released owned tab lease ${tabId} as reusable placeholder (session=${session.session}, ${reason})`);
      } catch {
        await ext.tabs.remove(tabId).catch(() => {});
        console.log(`[opencli] Released owned tab lease ${tabId} (session=${session.session}, ${reason})`);
      }
    }
  }

  automationSessions.delete(leaseKey);
  sessionOverrides.delete(leaseKey);
  await persistRuntimeState();
}

async function reconcileTargetLeaseRegistry(): Promise<void> {
  const ext = getExt();
  const registry = await readRegistry();

  for (const role of Object.keys(ownedContainers) as WindowRole[]) {
    ownedContainers[role].windowId = registry.ownedWindows[role] ?? null;
    const windowId = ownedContainers[role].windowId;
    if (windowId !== null) {
      try {
        await ext.windows.get(windowId);
      } catch {
        ownedContainers[role].windowId = null;
      }
    }
  }

  automationSessions.clear();
  for (const [leaseKey, stored] of Object.entries(registry.leases)) {
    const tabId = stored.preferredTabId;
    if (tabId === null) continue;
    try {
      const tab = await ext.tabs.get(tabId);
      if (!isDebuggableUrl(tab.url)) continue;
      if (stored.lifecycle === 'ephemeral' || stored.lifecycle === 'persistent' || stored.lifecycle === 'pinned') {
        setSessionOverride(leaseKey, { lifecycle: stored.lifecycle });
      }
      const session = makeSession(leaseKey, {
        session: typeof stored.session === 'string' ? stored.session : getSessionFromKey(leaseKey),
        surface: stored.surface === 'adapter' ? 'adapter' : getSurfaceFromKey(leaseKey),
        kind: stored.kind === 'bound' || stored.owned === false ? 'bound' : 'owned',
        windowId: tab.windowId,
        owned: stored.owned,
        preferredTabId: tabId,
      });
      const timeout = getIdleTimeout(leaseKey);
      automationSessions.set(leaseKey, {
        ...session,
        idleTimer: null,
        idleDeadlineAt: stored.idleDeadlineAt,
      });

      const remaining = stored.idleDeadlineAt > 0 ? stored.idleDeadlineAt - Date.now() : timeout;
      if (timeout > 0) {
        if (remaining <= 0) {
          await releaseLease(leaseKey, 'reconciled idle expiry');
        } else {
          resetWindowIdleTimer(leaseKey, remaining);
        }
      }
    } catch {
      // Registry is semantic state, not truth. Drop a lease whose tab is gone.
    }
  }

  await persistRuntimeState();
}

// ─── Lifecycle events ─────────────────────────────────────────────────

let initialized = false;

function initialize(): void {
  if (initialized) return;
  initialized = true;
  const ext = getExt();
  // Firefox clamps alarm periods up to 1 minute; alarms are the durable wake path.
  try {
    void ext.alarms.create('keepalive', { periodInMinutes: 1 });
  } catch {
    // Alarms unavailable (dev/test) — the in-process timer still drives reconnects.
  }

  // Migration cleanup: drop any registry copy an earlier build wrote to
  // storage.local; only storage.session is trusted (session-scoped ids).
  try {
    void localStorageArea()?.remove?.(REGISTRY_KEY)?.catch?.(() => {});
  } catch {
    // Best-effort cleanup.
  }

  workerRecovered = false;
  workerReady = (async () => {
    await getCurrentContextId();
    await reconcileTargetLeaseRegistry();
  })()
    .catch((err) => {
      console.warn(`[opencli] Startup recovery failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      workerRecovered = true;
    });
  void workerReady.then(() => connect());
  console.log('[opencli] OpenCLI Firefox bridge initialized');
}

getExt().runtime.onInstalled.addListener(() => {
  initialize();
});

getExt().runtime.onStartup.addListener(() => {
  initialize();
});

getExt().alarms.onAlarm.addListener(async (alarm) => {
  await workerReady;
  if (alarm.name === 'keepalive') void connect();
  const leaseKey = leaseKeyFromAlarmName(alarm.name);
  if (!leaseKey) return;
  if ((activeCommandCounts.get(leaseKey) ?? 0) > 0) {
    resetWindowIdleTimer(leaseKey);
    return;
  }
  await releaseLease(leaseKey, 'idle alarm');
});

getExt().windows.onRemoved.addListener(async (windowId) => {
  await workerReady;
  for (const container of Object.values(ownedContainers)) {
    if (container.windowId === windowId) container.windowId = null;
  }
  for (const [leaseKey, session] of automationSessions.entries()) {
    if (session.windowId === windowId) {
      console.log(`[opencli] ${session.surface} container closed (session=${session.session})`);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(leaseKey);
      sessionOverrides.delete(leaseKey);
      scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
    }
  }
  await persistRuntimeState();
});

getExt().tabs.onRemoved.addListener(async (tabId) => {
  await workerReady;
  identity.evictTab(tabId);
  for (const [leaseKey, session] of automationSessions.entries()) {
    if (session.preferredTabId === tabId) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      automationSessions.delete(leaseKey);
      sessionOverrides.delete(leaseKey);
      scheduleIdleAlarm(leaseKey, IDLE_TIMEOUT_NONE);
      console.log(`[opencli] Session ${session.session} detached from tab ${tabId} (tab closed)`);
    }
  }
  await persistRuntimeState();
});

// ─── Popup status API ─────────────────────────────────────────────────

getExt().runtime.onMessage.addListener((msg: unknown) => {
  const message = msg as { type?: string } | null;
  if (message?.type !== 'getStatus') return undefined;
  return (async () => {
    const contextId = await getCurrentContextId();
    const connected = ws?.readyState === WebSocket.OPEN;
    const extensionVersion = getExt().runtime.getManifest().version;
    const daemonVersion = connected ? await fetchDaemonVersion() : null;
    return {
      connected,
      reconnecting: reconnectTimer !== null,
      contextId,
      extensionVersion,
      daemonVersion,
    };
  })();
});

async function fetchDaemonVersion(): Promise<string | null> {
  try {
    const res = await fetch(`http://${DAEMON_HOST}:${DAEMON_PORT}/status`, {
      method: 'GET',
      headers: { 'X-OpenCLI': '1' },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { daemonVersion?: unknown };
    return typeof body.daemonVersion === 'string' ? body.daemonVersion : null;
  } catch {
    return null;
  }
}

// Firefox MV3 event pages can be started by events other than install/startup
// (including unpacked-extension runs). Initialize on every load; initialize()
// is idempotent.
initialize();

export const __test__ = {
  handleCommand,
  handleExec,
  handleNavigate,
  handleTabs,
  handleBind,
  handleScreenshot,
  handleUnsupported,
  resolveTabId,
  resetWindowIdleTimer,
  releaseLease,
  reconcileTargetLeaseRegistry,
  isTargetUrl,
  getSessionName,
  getCommandSurface,
  getLeaseKey,
  getIdleTimeout,
  sessionOverrides,
  nextReconnectDelayMs,
  connectForTest: connect,
  resetReconnectState: () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    if (wsKeepaliveTimer) clearInterval(wsKeepaliveTimer);
    wsKeepaliveTimer = null;
    wsKeepaliveSocket = null;
    connectInFlight = null;
    ws = null;
  },
  getReconnectAttempts: () => reconnectAttempts,
  setReconnectAttempts: (value: number) => {
    reconnectAttempts = value;
  },
  getSession: (leaseKey: string = 'default') => automationSessions.get(leaseKey) ?? null,
  setSession: (leaseKey: string, session: { windowId: number; owned: boolean; preferredTabId: number | null }) => {
    setLeaseSession(leaseKey, {
      session: getSessionFromKey(leaseKey),
      surface: getSurfaceFromKey(leaseKey),
      kind: session.owned ? 'owned' : 'bound',
      ...session,
    });
  },
  getOwnedWindowId: (role: WindowRole) => ownedContainers[role].windowId,
};
