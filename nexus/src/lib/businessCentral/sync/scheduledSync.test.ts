import { describe, expect, it, vi } from 'vitest';

import { runScheduledSync } from './scheduledSync';
import { SyncInProgressError } from './syncRunsError';

const r = (complete: boolean, recordsSynced = 1, cursor: string | null = null, error: string | null = null) =>
  ({ entityType: 'customer_ledger_entry', recordsSynced, complete, cursor, error }) as never;

describe('runScheduledSync', () => {
  it('light: one round per environment', async () => {
    const round = vi.fn<(id: string) => Promise<never[]>>(async () => [r(false, 5, 'a')]);
    const out = await runScheduledSync({ kind: 'light', connections: ['p1', 'p2'], round, nowMs: () => 0, budgetMs: 240_000 });
    expect(round.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2']);
    expect(out).toEqual([{ connectionId: 'p1', rounds: 1, status: 'ok' }, { connectionId: 'p2', rounds: 1, status: 'ok' }]);
  });

  it('full: repeats rounds while moving, until complete', async () => {
    const round = vi.fn()
      .mockResolvedValueOnce([r(false, 500, 'a')])
      .mockResolvedValueOnce([r(false, 500, 'b')])
      .mockResolvedValueOnce([r(true, 20, 'c')]);
    const out = await runScheduledSync({ kind: 'full', connections: ['p1'], round, nowMs: () => 0, budgetMs: 240_000 });
    expect(round).toHaveBeenCalledTimes(3);
    expect(out[0]).toEqual({ connectionId: 'p1', rounds: 3, status: 'ok' });
  });

  it('full: stops when out of time (the next schedule continues)', async () => {
    let t = 0;
    const round = vi.fn<(id: string) => Promise<never[]>>(async () => { t += 100_000; return [r(false, 500, `c${t}`)]; });
    const out = await runScheduledSync({ kind: 'full', connections: ['p1'], round, nowMs: () => t, budgetMs: 240_000 });
    expect(round).toHaveBeenCalledTimes(3);
    expect(out[0].status).toBe('ok');
  });

  it('skips an environment whose sync is already running, and reports other errors without stopping the rest', async () => {
    const round = vi.fn()
      .mockRejectedValueOnce(new SyncInProgressError('busy'))
      .mockRejectedValueOnce(new Error('BC down'))
      .mockResolvedValueOnce([r(true)]);
    const out = await runScheduledSync({ kind: 'light', connections: ['a', 'b', 'c'], round, nowMs: () => 0, budgetMs: 240_000 });
    expect(out).toEqual([
      { connectionId: 'a', rounds: 0, status: 'skipped (another sync is running)' },
      { connectionId: 'b', rounds: 0, status: 'error: BC down' },
      { connectionId: 'c', rounds: 1, status: 'ok' },
    ]);
  });
});
