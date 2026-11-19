import { describe, expect, it } from 'vitest';

import { acquireSyncLock, releaseSyncLock } from './syncLock';

function fakeDb(rowsReturned: number) {
  const calls: { update?: Record<string, unknown>; eqs: [string, unknown][]; or?: string }[] = [];
  const from = () => {
    const c: (typeof calls)[number] = { eqs: [] };
    calls.push(c);
    const q: Record<string, unknown> = {};
    q.update = (p: Record<string, unknown>) => { c.update = p; return q; };
    q.eq = (k: string, v: unknown) => { c.eqs.push([k, v]); return q; };
    q.or = (f: string) => { c.or = f; return q; };
    q.select = () => q;
    q.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: Array.from({ length: rowsReturned }, () => ({ id: 'bc-1' })), error: null }).then(res);
    return q;
  };
  return { client: { from } as never, calls };
}

const NOW = '2026-11-18T22:00:00.000Z';
const UNTIL = '2026-11-18T22:10:00.000Z';

describe('acquireSyncLock', () => {
  it('takes the lock in one guarded update: only when free or expired, judged by the database, not a saved copy', async () => {
    const db = fakeDb(1);
    expect(await acquireSyncLock(db.client, 'bc-1', 'u1', NOW, UNTIL)).toBe(true);
    expect(db.calls[0].update).toEqual({ sync_in_progress_by: 'u1', sync_in_progress_since: NOW, sync_in_progress_timeout_at: UNTIL, updated_at: NOW });
    expect(db.calls[0].eqs).toContainEqual(['id', 'bc-1']);
    expect(db.calls[0].or).toBe(`sync_in_progress_since.is.null,sync_in_progress_timeout_at.lt.${NOW}`);
  });

  it('reports held when the guarded update matched nothing', async () => {
    expect(await acquireSyncLock(fakeDb(0).client, 'bc-1', null, NOW, UNTIL)).toBe(false);
  });
});

describe('releaseSyncLock', () => {
  it('only clears the lock this run took (same start time)', async () => {
    const db = fakeDb(1);
    await releaseSyncLock(db.client, 'bc-1', NOW, { last_error: null });
    expect(db.calls[0].update).toMatchObject({ sync_in_progress_by: null, sync_in_progress_since: null, sync_in_progress_timeout_at: null, last_error: null });
    expect(db.calls[0].eqs).toEqual([['id', 'bc-1'], ['sync_in_progress_since', NOW]]);
  });
});
