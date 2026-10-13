/**
 * Download observation via the Firefox `downloads` API.
 *
 * `browser.downloads` is available in Firefox with the `downloads` permission,
 * so `opencli browser wait download` works natively. The CLI filters by a
 * user-provided filename/URL pattern and timeout; we never modify, redirect, or
 * persist browser download history.
 */

import { getExt, type DownloadDelta, type DownloadItem } from './browser-api';

export type DownloadWaitResult = {
  downloaded: boolean;
  id?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mime?: string;
  totalBytes?: number;
  state?: string;
  danger?: string;
  error?: string;
  elapsedMs: number;
};

export function matchesDownloadPattern(item: DownloadItem, pattern: string): boolean {
  if (!pattern) return true;
  const haystack = [item.filename, item.url, item.finalUrl, item.mime]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return haystack.includes(pattern.toLowerCase());
}

export function downloadResult(item: DownloadItem, startedAt: number): DownloadWaitResult {
  return {
    downloaded: item.state === 'complete',
    id: item.id,
    filename: item.filename,
    url: item.url,
    finalUrl: item.finalUrl,
    mime: item.mime,
    totalBytes: item.totalBytes,
    state: item.state,
    danger: item.danger,
    error: item.error,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function waitForDownload(pattern = '', timeoutMs = 30_000): Promise<DownloadWaitResult> {
  const ext = getExt();
  const startedAt = Date.now();
  const timeout = Math.max(1, timeoutMs);
  const downloads = ext.downloads;

  return await new Promise<DownloadWaitResult>((resolve) => {
    let done = false;
    const inProgressIds = new Set<number>();
    const finish = (result: DownloadWaitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      downloads.onCreated.removeListener?.(onCreated);
      downloads.onChanged.removeListener?.(onChanged);
      resolve(result);
    };

    const inspectById = async (id: number) => {
      const items = await downloads.search({ id });
      const item = items[0];
      if (!item || !matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(id);
      if (item.state === 'complete' || item.state === 'interrupted') {
        finish(downloadResult(item, startedAt));
      }
    };

    const onCreated = (item: DownloadItem) => {
      if (!matchesDownloadPattern(item, pattern)) return;
      inProgressIds.add(item.id);
      if (item.state === 'complete' || item.state === 'interrupted') {
        finish(downloadResult(item, startedAt));
      }
    };
    const onChanged = (delta: DownloadDelta) => {
      if (!delta.id) return;
      if (!inProgressIds.has(delta.id) && !delta.filename && !delta.url) return;
      if (delta.filename?.current || delta.url?.current) {
        void inspectById(delta.id);
        return;
      }
      if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
        void inspectById(delta.id);
      }
    };
    const timer = setTimeout(() => {
      finish({
        downloaded: false,
        state: 'interrupted',
        error: `No download matched "${pattern || '*'}" within ${timeout}ms`,
        elapsedMs: Date.now() - startedAt,
      });
    }, timeout);

    downloads.onCreated.addListener(onCreated);
    downloads.onChanged.addListener(onChanged);

    void downloads
      .search({
        limit: 50,
        orderBy: ['-startTime'],
        startedAfter: new Date(startedAt - Math.max(timeout, 1000)).toISOString(),
      })
      .then((recent) => {
        if (done) return;
        const completed = recent.find(
          (item) => item.state === 'complete' && matchesDownloadPattern(item, pattern),
        );
        if (completed) {
          finish(downloadResult(completed, startedAt));
          return;
        }
        for (const item of recent) {
          if (item.state === 'in_progress' && matchesDownloadPattern(item, pattern)) {
            inProgressIds.add(item.id);
          }
        }
      })
      .catch((err) => {
        finish({
          downloaded: false,
          state: 'interrupted',
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - startedAt,
        });
      });
  });
}
