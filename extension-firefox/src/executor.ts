/**
 * Firefox page execution.
 *
 * The Chrome bridge evaluates page JS through CDP `Runtime.evaluate`. Firefox
 * extensions have no CDP, so this uses `browser.scripting.executeScript` with
 * `world: "MAIN"` (Firefox 128+), which runs in the page's main world and
 * awaits a returned Promise — matching CDP's `awaitPromise: true` semantics
 * closely enough for `browser eval` / adapter code.
 *
 * Screenshots use `browser.tabs.captureTab` (visible viewport only). Anything
 * that needs CDP-specific page control — full-page capture, viewport overrides,
 * file inputs, network capture, frame targets — is honestly unsupported.
 */

import { getExt } from './browser-api';
import { unsupportedOnFirefox } from './errors';

export type ScreenshotOptions = {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
  width?: number;
  height?: number;
};

/**
 * Function injected into the page. It must be self-contained: Firefox
 * serializes it, so it cannot reference module state. Indirect eval runs the
 * caller's expression in the page's global scope.
 */
function evaluateInPage(code: string): unknown {
  return (0, eval)(code);
}

export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const ext = getExt();
  if (!ext.scripting) {
    throw unsupportedOnFirefox('Page script evaluation', 'the scripting API is unavailable');
  }
  const results = await ext.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: evaluateInPage,
    args: [expression],
  });
  const first = results[0];
  if (first && first.error !== undefined && first.error !== null) {
    const error = first.error;
    throw new Error(
      typeof error === 'string'
        ? error
        : ((error as { message?: string })?.message ?? String(error)),
    );
  }
  return first?.result;
}

function stripDataUrl(dataUrl: string): string {
  if (dataUrl.startsWith('data:')) {
    const comma = dataUrl.indexOf(',');
    if (comma !== -1) return dataUrl.slice(comma + 1);
  }
  return dataUrl;
}

export async function screenshot(tabId: number, options: ScreenshotOptions = {}): Promise<string> {
  const ext = getExt();
  if (options.fullPage) {
    throw unsupportedOnFirefox('Full-page screenshots', 'Firefox has no Page.captureScreenshot');
  }
  if ((options.width && options.width > 0) || (options.height && options.height > 0)) {
    throw unsupportedOnFirefox('Screenshot viewport overrides');
  }
  if (!ext.tabs.captureTab) {
    throw unsupportedOnFirefox('Screenshots', 'tabs.captureTab is unavailable');
  }
  const params: Record<string, unknown> = { format: options.format ?? 'png' };
  if (options.format === 'jpeg' && options.quality !== undefined) {
    params.quality = Math.max(0, Math.min(100, options.quality));
  }
  const dataUrl = await ext.tabs.captureTab(tabId, params);
  return stripDataUrl(dataUrl);
}

/**
 * Best-effort replacement for CDP `Input.insertText`: insert at the caret of
 * the focused element and dispatch the events frameworks listen for.
 */
export function buildInsertTextExpression(text: string): string {
  return `(() => {
    const text = ${JSON.stringify(text)};
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const proto = tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = descriptor && descriptor.set;
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
      const next = el.value.slice(0, start) + text + el.value.slice(end);
      if (setter) setter.call(el, next); else el.value = next;
      if (typeof el.setSelectionRange === 'function') el.setSelectionRange(start + text.length, start + text.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      return document.execCommand('insertText', false, text);
    }
    return false;
  })()`;
}

export async function insertText(tabId: number, text: string): Promise<void> {
  const inserted = await evaluate(tabId, buildInsertTextExpression(text));
  if (inserted === false) {
    throw new Error('No editable element is focused on the page');
  }
}
