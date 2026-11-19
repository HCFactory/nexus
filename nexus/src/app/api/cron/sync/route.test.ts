// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connections: [] as Record<string, unknown>[],
  eqs: [] as [string, unknown][],
  run: vi.fn(),
  record: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (c: string, v: unknown) => { mocks.eqs.push([c, v]); return q; };
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: mocks.connections, error: null }).then(res);
      return q;
    },
  }),
}));
vi.mock('@/lib/businessCentral/sync/receivablesSync', () => ({ runReceivablesSync: (...a: unknown[]) => mocks.run(...a) }));
vi.mock('@/lib/businessCentral/sync/syncRuns', () => ({
  recordSyncRun: (_db: unknown, meta: unknown, fn: () => unknown) => (mocks.record(meta), fn()),
}));

import { POST } from './route';

const call = (kind: string, auth?: string) =>
  POST(new Request(`https://nexus.example.com/api/cron/sync?kind=${kind}`, { method: 'POST', headers: auth ? { authorization: auth } : {} }));

describe('POST /api/cron/sync', () => {
  beforeEach(() => {
    mocks.eqs.length = 0;
    mocks.run.mockReset().mockResolvedValue([{ entityType: 'customer', recordsSynced: 1, complete: true, cursor: null, error: null }]);
    mocks.record.mockReset();
    mocks.connections = [{ id: 'prod', organization_id: 'org-1', auto_sync: true }];
    vi.stubEnv('CRON_SECRET', 's3cret-value-long-enough');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses when CRON_SECRET is not set', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await call('light', 'Bearer anything');
    expect(res.status).toBe(503);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('refuses a missing or wrong secret', async () => {
    expect((await call('light')).status).toBe(401);
    expect((await call('light', 'Bearer wrong')).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind', async () => {
    expect((await call('lists', 'Bearer s3cret-value-long-enough')).status).toBe(400);
  });

  it('syncs only environments marked Sync automatically, as an automatic run with no user', async () => {
    const res = await call('light', 'Bearer s3cret-value-long-enough');
    expect(res.status).toBe(200);
    expect(mocks.eqs).toContainEqual(['auto_sync', true]);
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', kind: 'light', lockedBy: null, connection: mocks.connections[0] }));
    expect(mocks.record).toHaveBeenCalledWith({ orgId: 'org-1', connectionId: 'prod', kind: 'light', trigger: 'scheduled', triggeredBy: null });
    expect(await res.json()).toEqual({ kind: 'light', outcomes: [{ connectionId: 'prod', rounds: 1, status: 'ok' }] });
  });
});
