import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildInsertTextExpression, evaluate, screenshot } from './executor';
import type { WebExtensionApi } from './browser-api';

function stubBrowser(partial: unknown): void {
  (globalThis as { browser?: unknown }).browser = partial;
}

afterEach(() => {
  delete (globalThis as { browser?: unknown }).browser;
});

describe('evaluate', () => {
  it('returns the injected script result', async () => {
    const executeScript = vi.fn(async () => [{ result: 42 }]);
    stubBrowser({ scripting: { executeScript } } as unknown as WebExtensionApi);

    expect(await evaluate(7, '21 * 2')).toBe(42);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7 },
        world: 'MAIN',
        args: ['21 * 2'],
      }),
    );
  });

  it('surfaces an error attached to the injection result', async () => {
    stubBrowser({
      scripting: { executeScript: async () => [{ error: 'boom from page' }] },
    } as unknown as WebExtensionApi);

    await expect(evaluate(7, 'throw new Error("x")')).rejects.toThrow('boom from page');
  });

  it('fails typed when the scripting API is missing', async () => {
    stubBrowser({} as unknown as WebExtensionApi);
    await expect(evaluate(7, '1')).rejects.toThrow(/not supported on Firefox/);
  });
});

describe('screenshot', () => {
  it('strips the data URL prefix so the CLI receives bare base64', async () => {
    const captureTab = vi.fn(async () => 'data:image/png;base64,QUJD');
    stubBrowser({ tabs: { captureTab } } as unknown as WebExtensionApi);

    expect(await screenshot(3)).toBe('QUJD');
    expect(captureTab).toHaveBeenCalledWith(3, { format: 'png' });
  });

  it('passes jpeg quality through, clamped', async () => {
    const captureTab = vi.fn(async () => 'data:image/jpeg;base64,QUJD');
    stubBrowser({ tabs: { captureTab } } as unknown as WebExtensionApi);

    await screenshot(3, { format: 'jpeg', quality: 250 });
    expect(captureTab).toHaveBeenCalledWith(3, { format: 'jpeg', quality: 100 });
  });

  it('rejects full-page capture as unsupported on Firefox', async () => {
    stubBrowser({ tabs: { captureTab: vi.fn() } } as unknown as WebExtensionApi);
    await expect(screenshot(3, { fullPage: true })).rejects.toThrow(/not supported on Firefox/);
  });

  it('rejects viewport overrides as unsupported on Firefox', async () => {
    stubBrowser({ tabs: { captureTab: vi.fn() } } as unknown as WebExtensionApi);
    await expect(screenshot(3, { width: 800 })).rejects.toThrow(/not supported on Firefox/);
  });
});

describe('buildInsertTextExpression', () => {
  it('JSON-encodes the payload so text cannot break out of the injected script', () => {
    const expression = buildInsertTextExpression('a"b\\c');
    expect(expression).toContain(JSON.stringify('a"b\\c'));
    expect(expression).toContain('document.activeElement');
  });
});
