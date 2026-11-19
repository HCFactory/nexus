import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { recordSyncRun, SyncInProgressError } from './syncRuns';

function fakeDb(opts: { insertError?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const from = () => {
    const q: Record<string, unknown> = {};
    let op: 'insert' | 'update' | 'delete' | null = null;
    let payload: Record<string, unknown> = {};
    let id: string | null = null;
    q.insert = (p: Record<string, unknown>) => { op = 'insert'; payload = p; return q; };
    q.update = (p: Record<string, unknown>) => { op = 'update'; payload = p; return q; };
    q.delete = () => { op = 'delete'; return q; };
    q.eq = (_c: string, v: string) => { id = v; return q; };
    q.select = () => q;
    q.single = async () => {
      if (opts.insertError) return { data: null, error: { message: 'relation "bc_sync_runs" does not exist' } };
      const row = { id: `run-${rows.length + 1}`, ...payload };
      rows.push(row);
      return { data: row, error: null };
    };
    q.then = (res: (v: unknown) => unknown) => {
      if (op === 'update') Object.assign(rows.find((r) => r.id === id) ?? {}, payload);
      if (op === 'delete' && id) deleted.push(id);
      return Promise.resolve({ error: null }).then(res);
    };
    return q;
  };
  return { client: { from } as never, rows, deleted };
}

const meta = { orgId: 'org-1', connectionId: 'bc-1', kind: 'light' as const, trigger: 'manual' as const, triggeredBy: 'u1' };
const ok = [{ entityType: 'customer', recordsSynced: 3, complete: true, cursor: null, error: null }];

describe('recordSyncRun', () => {
  it('records the start, then the finish with complete, results and no error', async () => {
    const db = fakeDb();
    const out = await recordSyncRun(db.client, meta, async () => ok as never);
    expect(out).toBe(ok);
    expect(db.rows[0]).toMatchObject({ organization_id: 'org-1', bc_connection_id: 'bc-1', kind: 'light', trigger: 'manual', triggered_by: 'u1', complete: true, error: null, results: ok });
    expect(db.rows[0].finished_at).toEqual(expect.any(String));
  });

  it('an incomplete or errored round is not complete, and errors are joined', async () => {
    const db = fakeDb();
    await recordSyncRun(db.client, meta, async () => [
      { entityType: 'customer', recordsSynced: 0, complete: false, cursor: 'x', error: 'Ship-to addresses: 404' },
      { entityType: 'customer_ledger_entry', recordsSynced: 10, complete: false, cursor: 'e', error: null },
    ] as never);
    expect(db.rows[0]).toMatchObject({ complete: false, error: 'customer: Ship-to addresses: 404' });
  });

  it('a thrown sync is recorded with its message and rethrown', async () => {
    const db = fakeDb();
    await expect(recordSyncRun(db.client, meta, async () => { throw new Error('BC down'); })).rejects.toThrow('BC down');
    expect(db.rows[0]).toMatchObject({ complete: false, error: 'BC down' });
  });

  it('a sync that found the lock held leaves no row behind', async () => {
    const db = fakeDb();
    const err = new SyncInProgressError('Sync already in progress');
    await expect(recordSyncRun(db.client, meta, async () => { throw err; })).rejects.toBe(err);
    expect(db.deleted).toEqual(['run-1']);
  });

  it('logging failures (e.g. migration not applied yet) never stop the sync', async () => {
    const db = fakeDb({ insertError: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await recordSyncRun(db.client, meta, async () => ok as never)).toBe(ok);
  });
});
