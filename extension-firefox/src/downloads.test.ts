import { describe, expect, it } from 'vitest';

import { downloadResult, matchesDownloadPattern, type DownloadWaitResult } from './downloads';
import type { DownloadItem } from './browser-api';

function item(partial: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 1,
    filename: '/tmp/receipt.pdf',
    url: 'https://example.com/receipt.pdf',
    state: 'complete',
    ...partial,
  };
}

describe('matchesDownloadPattern', () => {
  it('matches everything when the pattern is empty', () => {
    expect(matchesDownloadPattern(item(), '')).toBe(true);
  });

  it('matches filename, url, final url, or mime, case-insensitively', () => {
    expect(matchesDownloadPattern(item(), 'RECEIPT')).toBe(true);
    expect(matchesDownloadPattern(item({ filename: '/tmp/x.bin', url: 'https://cdn.example.com/a' }), 'cdn.example')).toBe(true);
    expect(matchesDownloadPattern(item({ finalUrl: 'https://dl.example.com/f' }), 'dl.example')).toBe(true);
    expect(matchesDownloadPattern(item({ mime: 'application/zip' }), 'zip')).toBe(true);
  });

  it('does not match unrelated patterns', () => {
    expect(matchesDownloadPattern(item(), 'invoice')).toBe(false);
  });
});

describe('downloadResult', () => {
  it('marks a completed item as downloaded and carries the fields the CLI reports', () => {
    const result: DownloadWaitResult = downloadResult(item({ totalBytes: 10 }), Date.now() - 5);
    expect(result).toMatchObject({
      downloaded: true,
      id: 1,
      filename: '/tmp/receipt.pdf',
      url: 'https://example.com/receipt.pdf',
      state: 'complete',
      totalBytes: 10,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(5);
  });

  it('marks an interrupted item as not downloaded', () => {
    expect(downloadResult(item({ state: 'interrupted', error: 'NETWORK_FAILED' }), Date.now()))
      .toMatchObject({ downloaded: false, state: 'interrupted', error: 'NETWORK_FAILED' });
  });
});
