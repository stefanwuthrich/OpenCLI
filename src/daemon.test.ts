import { describe, expect, it } from 'vitest';

import {
  COMMAND_RESULT_UNKNOWN_CODE,
  COMMAND_RESULT_UNKNOWN_HINT,
  buildCommandDispatchFailure,
  buildCommandTimeoutFailure,
  buildExtensionDisconnectFailure,
  commandResultUnknownMessage,
  getResponseCorsHeaders,
  isAllowedExtensionOrigin,
  resolveProfileRoute,
} from './daemon-utils.js';

describe('isAllowedExtensionOrigin', () => {
  it('allows Chromium extension origins', () => {
    expect(isAllowedExtensionOrigin('chrome-extension://abc123')).toBe(true);
  });

  it('allows Firefox extension origins', () => {
    expect(isAllowedExtensionOrigin('moz-extension://2b1f0f0a-1111-2222-3333-444455556666')).toBe(true);
  });

  it('allows a missing Origin header (CLI/curl, no browser)', () => {
    expect(isAllowedExtensionOrigin(undefined)).toBe(true);
  });

  it('rejects ordinary web origins', () => {
    expect(isAllowedExtensionOrigin('https://example.com')).toBe(false);
    expect(isAllowedExtensionOrigin('http://localhost:19825')).toBe(false);
  });

  it('rejects lookalike prefixes that are not extension origins', () => {
    expect(isAllowedExtensionOrigin('chrome-extension.evil.com')).toBe(false);
    expect(isAllowedExtensionOrigin('moz-extension.evil.com')).toBe(false);
  });
});

describe('getResponseCorsHeaders', () => {
  it('allows the Browser Bridge extension origin to read /ping', () => {
    expect(getResponseCorsHeaders('/ping', 'chrome-extension://abc123')).toEqual({
      'Access-Control-Allow-Origin': 'chrome-extension://abc123',
      Vary: 'Origin',
    });
  });

  it('allows the Firefox Browser Bridge extension origin to read /ping', () => {
    expect(getResponseCorsHeaders('/ping', 'moz-extension://2b1f0f0a-1111-2222-3333-444455556666')).toEqual({
      'Access-Control-Allow-Origin': 'moz-extension://2b1f0f0a-1111-2222-3333-444455556666',
      Vary: 'Origin',
    });
  });

  it('does not add CORS headers for ordinary web origins', () => {
    expect(getResponseCorsHeaders('/ping', 'https://example.com')).toBeUndefined();
  });

  it('does not add CORS headers when origin is absent', () => {
    expect(getResponseCorsHeaders('/ping')).toBeUndefined();
  });

  it('does not add CORS headers for command endpoints even from the extension origin', () => {
    expect(getResponseCorsHeaders('/command', 'chrome-extension://abc123')).toBeUndefined();
  });
});

describe('daemon command dispatch', () => {
  it('uses a distinct command_result_unknown contract for ambiguous dispatched commands', () => {
    expect(COMMAND_RESULT_UNKNOWN_CODE).toBe('command_result_unknown');
    expect(commandResultUnknownMessage('navigate')).toContain('navigate command was dispatched');
    expect(COMMAND_RESULT_UNKNOWN_HINT).toContain('Inspect the browser/session state');
    expect(COMMAND_RESULT_UNKNOWN_HINT).toContain('Do not blindly retry write commands');
  });

  it('classifies dispatched extension disconnects as command_result_unknown', () => {
    expect(buildExtensionDisconnectFailure({
      contextId: 'work',
      action: 'navigate',
      dispatched: true,
    })).toEqual({
      message: 'Browser connection dropped after the navigate command was dispatched; it may have completed.',
      errorCode: 'command_result_unknown',
      errorHint: COMMAND_RESULT_UNKNOWN_HINT,
      status: 503,
      countAsCommandResultUnknown: true,
    });
  });

  it('classifies pre-dispatch extension disconnects as profile_disconnected', () => {
    expect(buildExtensionDisconnectFailure({
      contextId: 'work',
      action: 'navigate',
      dispatched: false,
    })).toMatchObject({
      message: 'Browser profile "work" disconnected before command dispatch',
      errorCode: 'profile_disconnected',
      status: 503,
      countAsCommandResultUnknown: false,
    });
  });

  it('classifies ws.send dispatch failures as profile_disconnected', () => {
    expect(buildCommandDispatchFailure('work')).toMatchObject({
      message: 'Browser profile "work" disconnected before command dispatch',
      errorCode: 'profile_disconnected',
      status: 503,
      countAsCommandResultUnknown: false,
    });
  });

  it('routes a REQUESTED profile strictly — fails loud when offline, even with one live profile', () => {
    expect(resolveProfileRoute({ requestedContextId: 'zvypsyje', connectedContextIds: ['pavmrekj'] })).toMatchObject({
      ok: false,
      errorCode: 'profile_disconnected',
    });
    expect(resolveProfileRoute({ requestedContextId: 'pavmrekj', connectedContextIds: ['pavmrekj'] })).toEqual({
      ok: true,
      contextId: 'pavmrekj',
    });
  });

  it('uses a PREFERRED profile when connected', () => {
    expect(resolveProfileRoute({ preferredContextId: 'zvypsyje', connectedContextIds: ['zvypsyje', 'other'] })).toEqual({
      ok: true,
      contextId: 'zvypsyje',
    });
  });

  it('falls back to the only connected profile when the preferred one is stale', () => {
    expect(resolveProfileRoute({ preferredContextId: 'zvypsyje', connectedContextIds: ['pavmrekj'] })).toEqual({
      ok: true,
      contextId: 'pavmrekj',
      fallbackFrom: 'zvypsyje',
    });
  });

  it('asks the user to choose when the preferred profile is stale and multiple are connected', () => {
    const route = resolveProfileRoute({ preferredContextId: 'zvypsyje', connectedContextIds: ['a', 'b'] });
    expect(route).toMatchObject({ ok: false, errorCode: 'profile_required' });
    if (!route.ok) {
      expect(route.error).toContain('zvypsyje');
      expect(route.errorHint).toContain('opencli profile use');
    }
  });

  it('keeps the legacy no-selection behavior: single auto-use, multiple ask, none error', () => {
    expect(resolveProfileRoute({ connectedContextIds: ['only'] })).toEqual({ ok: true, contextId: 'only' });
    expect(resolveProfileRoute({ connectedContextIds: ['a', 'b'] })).toMatchObject({ ok: false, errorCode: 'profile_required' });
    expect(resolveProfileRoute({ connectedContextIds: [] })).toMatchObject({ ok: false, errorCode: 'extension_not_connected' });
    expect(resolveProfileRoute({ preferredContextId: 'gone', connectedContextIds: [] })).toMatchObject({ ok: false, errorCode: 'extension_not_connected' });
  });

  it('classifies daemon-side command timeouts as command_result_unknown with a 408', () => {
    expect(buildCommandTimeoutFailure('navigate', 120_000)).toEqual({
      message: 'Browser navigate command timed out after 120s; it may still complete in the browser.',
      errorCode: 'command_result_unknown',
      errorHint: COMMAND_RESULT_UNKNOWN_HINT,
      status: 408,
      countAsCommandResultUnknown: true,
    });
  });
});
