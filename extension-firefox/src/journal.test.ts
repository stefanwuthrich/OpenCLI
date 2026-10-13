import { describe, expect, it, vi } from 'vitest';

import { createJournal, JOURNAL_KEY } from './journal';
import type { StorageArea } from './browser-api';
import type { Command, Result } from './protocol';

function fakeArea(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { ...initial };
  const area: StorageArea = {
    async get(key) {
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = state[k];
      return out;
    },
    async set(items) {
      Object.assign(state, items);
    },
  };
  return { area, state };
}

function cmd(id: string): Command {
  return { id, action: 'exec', code: '1' };
}

describe('createJournal', () => {
  it('replays a completed result instead of re-executing the same id', async () => {
    const { area } = fakeArea();
    const journal = createJournal(area);
    const execute = vi.fn(async (c: Command): Promise<Result> => ({ id: c.id, ok: true, data: 1 }));

    expect(await journal.executeWithJournal(cmd('a'), execute)).toEqual({ id: 'a', ok: true, data: 1 });

    const reExecute = vi.fn(async (c: Command): Promise<Result> => ({ id: c.id, ok: true, data: 999 }));
    expect(await journal.executeWithJournal(cmd('a'), reExecute)).toEqual({ id: 'a', ok: true, data: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reExecute).not.toHaveBeenCalled();
  });

  it('coalesces duplicate deliveries of an in-flight command onto one execution', async () => {
    const { area } = fakeArea();
    const journal = createJournal(area);
    let resolveRun!: (result: Result) => void;
    const run = new Promise<Result>((resolve) => {
      resolveRun = resolve;
    });
    const execute = vi.fn(() => run);

    const first = journal.executeWithJournal(cmd('b'), execute);
    const second = journal.executeWithJournal(cmd('b'), execute);

    // execute() runs after the journal loads from storage.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(execute).toHaveBeenCalledTimes(1);
    resolveRun({ id: 'b', ok: true, data: 'once' });
    expect(await first).toEqual({ id: 'b', ok: true, data: 'once' });
    expect(await second).toEqual({ id: 'b', ok: true, data: 'once' });
  });

  it('reports command_lost for an id marked started but never finished', async () => {
    const { area } = fakeArea({ [JOURNAL_KEY]: { c: { status: 'started', ts: 1 } } });
    const journal = createJournal(area);
    const execute = vi.fn(async (c: Command): Promise<Result> => ({ id: c.id, ok: true }));

    const result = await journal.executeWithJournal(cmd('c'), execute);
    expect(result).toMatchObject({ ok: false, errorCode: 'command_lost' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports result_evicted for a completed id whose result was too large to store', async () => {
    const { area } = fakeArea({ [JOURNAL_KEY]: { d: { status: 'done', ts: 1 } } });
    const journal = createJournal(area);
    const result = await journal.executeWithJournal(cmd('d'), async (c) => ({ id: c.id, ok: true }));
    expect(result).toMatchObject({ ok: false, errorCode: 'result_evicted' });
  });

  it('degrades to an in-memory journal without a storage area', async () => {
    const journal = createJournal(null);
    const execute = vi.fn(async (c: Command): Promise<Result> => ({ id: c.id, ok: true, data: 2 }));

    expect(await journal.executeWithJournal(cmd('e'), execute)).toEqual({ id: 'e', ok: true, data: 2 });
    expect(await journal.executeWithJournal(cmd('e'), execute)).toEqual({ id: 'e', ok: true, data: 2 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
