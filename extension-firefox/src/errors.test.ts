import { describe, expect, it } from 'vitest';

import {
  CommandFailure,
  FIREFOX_UNSUPPORTED_CODE,
  classifyExtensionError,
  errorResult,
  unsupportedOnFirefox,
} from './errors';

describe('unsupportedOnFirefox', () => {
  it('phrases network capture so the CLI degrades quietly instead of failing', () => {
    const err = unsupportedOnFirefox('Network capture');
    const message = err.message.toLowerCase();
    expect(message).toContain('network capture');
    expect(message).toContain('not supported');
    expect(err.code).toBe(FIREFOX_UNSUPPORTED_CODE);
    expect(err.hint).toBeTruthy();
  });

  it('appends an optional detail clause', () => {
    expect(unsupportedOnFirefox('Full-page screenshots', 'no Page.captureScreenshot').message)
      .toBe('Full-page screenshots is not supported on Firefox (no Page.captureScreenshot).');
  });
});

describe('errorResult', () => {
  it('passes through a CommandFailure code and hint', () => {
    expect(errorResult('id', new CommandFailure('x_code', 'boom', 'try again'))).toEqual({
      id: 'id',
      ok: false,
      error: 'boom',
      errorCode: 'x_code',
      errorHint: 'try again',
    });
  });

  it('omits the hint when the CommandFailure has none', () => {
    expect(errorResult('id', new CommandFailure('x_code', 'boom'))).toEqual({
      id: 'id',
      ok: false,
      error: 'boom',
      errorCode: 'x_code',
    });
  });

  it('classifies a vanished tab', () => {
    expect(errorResult('id', new Error('No tab with id: 9'))).toMatchObject({ errorCode: 'tab_gone' });
  });

  it('classifies a stale page identity', () => {
    expect(
      errorResult('id', new Error('Page not found: abc — stale page identity')),
    ).toMatchObject({ errorCode: 'stale_page' });
  });

  it('leaves unknown errors uncoded', () => {
    expect(errorResult('id', new Error('something else'))).toEqual({
      id: 'id',
      ok: false,
      error: 'something else',
    });
    expect(classifyExtensionError('something else')).toBeUndefined();
  });
});
