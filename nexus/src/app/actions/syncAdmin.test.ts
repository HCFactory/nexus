import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), runs: {} as Record<string, Record<string, unknown> | null>, conn: { auto_sync: true, display_name: 'Production' } }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.scope }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let kind = '';
      q.select = () => q;
      q.eq = (c: string, v: string) => { if (c === 'kind') kind = v; return q; };
      q.order = () => q;
      q.limit = () => q;
      q.maybeSingle = async () => ({ data: table === 'bc_sync_runs' ? mocks.runs[kind] ?? null : mocks.conn, error: null });
      return q;
    },
  }),
}));

import { getSyncOverview } from './syncAdmin';

describe('getSyncOverview', () => {
  beforeEach(() => {
    mocks.scope.mockResolvedValue({ orgId: 'org-1', bcConnectionId: 'bc-1', user: { id: 'u' }, access: { isAdmin: true } });
    mocks.runs = {
      full: { started_at: '2026-11-18T20:00:00Z', finished_at: '2026-11-18T20:02:00Z', trigger: 'scheduled', complete: true, error: null },
      lists: null,
      light: { started_at: '2026-11-18T21:45:00Z', finished_at: null, trigger: 'manual', complete: null, error: null },
    };
  });

  it('gives the environment, its Sync automatically flag and the latest run of each sync', async () => {
    expect(await getSyncOverview()).toEqual({
      environment: 'Production',
      autoSync: true,
      runs: {
        full: { startedAt: '2026-11-18T20:00:00Z', finishedAt: '2026-11-18T20:02:00Z', trigger: 'scheduled', complete: true, error: null, unfinished: false },
        lists: null,
        light: { startedAt: '2026-11-18T21:45:00Z', finishedAt: null, trigger: 'manual', complete: null, error: null, unfinished: expect.any(Boolean) },
      },
    });
  });

  it('a run still unfinished after 15 minutes is marked unfinished; a recent one is not', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T21:50:00Z'));
    const o = await getSyncOverview();
    expect(o?.runs.light?.unfinished).toBe(false);
    vi.setSystemTime(new Date('2026-11-18T22:01:00Z'));
    expect((await getSyncOverview())?.runs.light?.unfinished).toBe(true);
    vi.useRealTimers();
  });

  it('is admin only', async () => {
    mocks.scope.mockResolvedValue({ orgId: 'org-1', bcConnectionId: 'bc-1', user: { id: 'u' }, access: { isAdmin: false } });
    expect(await getSyncOverview()).toBeNull();
  });

  it('no environment selected: null', async () => {
    mocks.scope.mockRejectedValue(new Error('Select a Business Central environment first'));
    expect(await getSyncOverview()).toBeNull();
  });
});
