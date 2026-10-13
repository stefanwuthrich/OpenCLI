/**
 * Popup: query the background event page for bridge status. Firefox's
 * `runtime.sendMessage` returns a Promise from the listener, so this is plain
 * async/await — no `sendResponse` callback and no `runtime.lastError` (that is
 * Chrome-only).
 */

import { getExt } from '../browser-api';

type BridgeStatus = {
  connected?: boolean;
  reconnecting?: boolean;
  contextId?: string;
  extensionVersion?: string;
  daemonVersion?: string | null;
};

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setState(card: HTMLElement, dot: HTMLElement, state: 'connected' | 'disconnected' | 'connecting'): void {
  card.classList.remove('connected', 'disconnected', 'connecting');
  card.classList.add(state);
  dot.classList.remove('connected', 'disconnected', 'connecting');
  dot.classList.add(state);
}

function copyToClipboard(text: string, button: HTMLButtonElement): void {
  navigator.clipboard.writeText(text).then(
    () => {
      const original = button.textContent ?? 'Copy';
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = original;
        button.classList.remove('copied');
      }, 1200);
    },
    () => {
      button.textContent = 'Failed';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    },
  );
}

async function render(): Promise<void> {
  const card = byId<HTMLElement>('card');
  const dot = byId<HTMLElement>('dot');
  const status = byId<HTMLElement>('status');
  const daemonVersion = byId<HTMLElement>('daemonVersion');
  const profileRow = byId<HTMLElement>('profileRow');
  const contextId = byId<HTMLElement>('contextId');
  const copyBtn = byId<HTMLButtonElement>('copyBtn');
  const hint = byId<HTMLElement>('hint');
  const extVersion = byId<HTMLElement>('extVersion');

  let resp: BridgeStatus | undefined;
  try {
    resp = (await getExt().runtime.sendMessage({ type: 'getStatus' })) as BridgeStatus | undefined;
  } catch {
    resp = undefined;
  }

  if (!resp) {
    setState(card, dot, 'disconnected');
    status.textContent = 'No daemon connected';
    daemonVersion.textContent = '';
    profileRow.style.display = 'none';
    hint.style.display = 'block';
    return;
  }

  if (typeof resp.extensionVersion === 'string') {
    extVersion.textContent = `v${resp.extensionVersion}`;
  }

  if (typeof resp.contextId === 'string' && resp.contextId.length > 0) {
    contextId.textContent = resp.contextId;
    profileRow.style.display = 'flex';
    copyBtn.addEventListener('click', () => copyToClipboard(resp!.contextId!, copyBtn));
  } else {
    profileRow.style.display = 'none';
  }

  if (resp.connected) {
    setState(card, dot, 'connected');
    status.textContent = 'Connected to daemon';
    if (typeof resp.daemonVersion === 'string') {
      daemonVersion.textContent = `daemon v${resp.daemonVersion}`;
    }
    hint.style.display = 'none';
  } else if (resp.reconnecting) {
    setState(card, dot, 'connecting');
    status.textContent = 'Reconnecting...';
    daemonVersion.textContent = '';
    hint.style.display = 'none';
  } else {
    setState(card, dot, 'disconnected');
    status.textContent = 'No daemon connected';
    daemonVersion.textContent = '';
    hint.style.display = 'block';
  }
}

void render();
