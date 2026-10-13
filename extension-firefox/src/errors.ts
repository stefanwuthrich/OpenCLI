/**
 * Error contract for the Firefox Browser Bridge.
 *
 * Two kinds of failures matter to the CLI:
 *   - `CommandFailure` carries a stable errorCode (+ optional hint) that the
 *     daemon/CLI can branch on without regex-matching text.
 *   - Everything else is classified best-effort by message (tab_gone, stale
 *     page identity) so the CLI can decide retry safety.
 *
 * Firefox has no chrome.debugger/CDP, so whole feature families are genuinely
 * unsupported. Those return `unsupported_on_firefox`; the network-capture
 * message is phrased so `isUnsupportedNetworkCaptureError` in the CLI degrades
 * quietly instead of failing the command.
 */

import type { Result } from './protocol';

export class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CommandFailure';
  }
}

export const FIREFOX_UNSUPPORTED_CODE = 'unsupported_on_firefox';

export const FIREFOX_UNSUPPORTED_HINT =
  'This is the Firefox build, which has no chrome.debugger/CDP access. Install the Chrome build of the OpenCLI extension for CDP-backed commands.';

/**
 * Build the typed failure for a feature Firefox cannot provide. `feature` is
 * sentence-cased ("Network capture", "CDP passthrough") so it reads naturally
 * in agent output.
 */
export function unsupportedOnFirefox(feature: string, detail?: string): CommandFailure {
  const suffix = detail ? ` (${detail})` : '';
  return new CommandFailure(
    FIREFOX_UNSUPPORTED_CODE,
    `${feature} is not supported on Firefox${suffix}.`,
    FIREFOX_UNSUPPORTED_HINT,
  );
}

/**
 * Map an executor error to a machine-readable code so the CLI can decide retry
 * safety. Firefox has far fewer moving parts than CDP, so this is intentionally
 * small: a vanished tab/window, or a page identity that no longer maps.
 */
export function classifyExtensionError(message: string): string | undefined {
  if (/No tab with id|No window with id|Invalid tab ID/i.test(message)) return 'tab_gone';
  if (/stale page identity|^Page not found:/i.test(message)) return 'stale_page';
  return undefined;
}

export function errorResult(id: string, err: unknown): Result {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CommandFailure) {
    return {
      id,
      ok: false,
      error: message,
      errorCode: err.code,
      ...(err.hint ? { errorHint: err.hint } : {}),
    };
  }
  const errorCode = classifyExtensionError(message);
  return { id, ok: false, error: message, ...(errorCode ? { errorCode } : {}) };
}
