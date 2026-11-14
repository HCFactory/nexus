import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Row } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({ syncSalesOrder: vi.fn() }));
vi.mock('./orderSync', () => ({ syncSalesOrder: mocks.syncSalesOrder }));

import { LEASE_MS, SWEEP_BATCH, claimOrder, releaseOrder, sweepPendingOrders, syncWithClaim } from './orderClaim';
import type { OrderSyncDeps } from './orderSync';

const T0 = '2026-11-13T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const order = (id: string, extra: Row = {}): Row => ({
  id,
  organization_id: 'org-1',
  bc_connection_id: 'conn-1',
  sync_state: 'pending',
  claimed_until: null,
  updated_at: T0,
  ...extra,
});

beforeEach(() => vi.resetAllMocks());

describe('claimOrder / releaseOrder', () => {
  it('returns false while another lease is live, and true after it expires', async () => {
    const fake = fakeSupabase({ sales_orders: [order('o1')] });
    expect(await claimOrder(fake.client, 'o1', T0)).toBe(true);
    expect(fake.tables.sales_orders[0].claimed_until).toBe(at(LEASE_MS));
    expect(await claimOrder(fake.client, 'o1', at(LEASE_MS - 1))).toBe(false);
    expect(await claimOrder(fake.client, 'o1', at(LEASE_MS + 1))).toBe(true);
  });

  it('does not claim an order of another organization or connection', async () => {
    const fake = fakeSupabase({ sales_orders: [order('o1')] });
    expect(await claimOrder(fake.client, 'o1', T0, { orgId: 'org-2', connectionId: 'conn-1' })).toBe(false);
    expect(await claimOrder(fake.client, 'o1', T0, { orgId: 'org-1', connectionId: 'conn-1' })).toBe(true);
  });

  it('release clears our lease but not a newer one taken after ours expired', async () => {
    const fake = fakeSupabase({ sales_orders: [order('o1')] });
    await claimOrder(fake.client, 'o1', T0);
    await claimOrder(fake.client, 'o1', at(LEASE_MS + 1)); // someone else, after expiry
    await releaseOrder(fake.client, 'o1', at(LEASE_MS)); // our stale lease
    expect(fake.tables.sales_orders[0].claimed_until).toBe(at(2 * LEASE_MS + 1));
    await releaseOrder(fake.client, 'o1');
    expect(fake.tables.sales_orders[0].claimed_until).toBeNull();
  });
});

function deps(rows: Row[]): { deps: OrderSyncDeps; tables: Record<string, Row[]> } {
  const fake = fakeSupabase({ sales_orders: rows });
  return {
    tables: fake.tables,
    deps: { supabase: fake.client, transport: {} as never, orgId: 'org-1', connectionId: 'conn-1', now: () => T0 },
  };
}

describe('syncWithClaim', () => {
  it('claims, syncs and always releases, even when the sync throws', async () => {
    const d = deps([order('o1')]);
    mocks.syncSalesOrder.mockImplementation(async () => {
      expect(d.tables.sales_orders[0].claimed_until).toBe(at(LEASE_MS));
      throw new Error('boom');
    });
    await expect(syncWithClaim(d.deps, 'o1')).rejects.toThrow('boom');
    expect(d.tables.sales_orders[0].claimed_until).toBeNull();
  });

  it('returns null without syncing when the order is claimed', async () => {
    const d = deps([order('o1', { claimed_until: at(5000) })]);
    expect(await syncWithClaim(d.deps, 'o1')).toBeNull();
    expect(mocks.syncSalesOrder).not.toHaveBeenCalled();
  });

  it('passes overwrite through', async () => {
    const d = deps([order('o1')]);
    mocks.syncSalesOrder.mockResolvedValue('synced');
    expect(await syncWithClaim(d.deps, 'o1', { overwrite: true })).toBe('synced');
    expect(mocks.syncSalesOrder).toHaveBeenCalledWith(d.deps, 'o1', { overwrite: true });
  });
});

describe('sweepPendingOrders', () => {
  it('skips conflict and synced orders and handles at most 5, oldest first', async () => {
    const rows = [
      order('conflict', { sync_state: 'conflict', updated_at: '2026-01-01T00:00:00.000Z' }),
      order('synced', { sync_state: 'synced', updated_at: '2026-01-01T00:00:00.000Z' }),
      order('claimed', { claimed_until: at(1000), updated_at: '2026-01-01T00:00:00.000Z' }),
      order('other-org', { organization_id: 'org-2', updated_at: '2026-01-01T00:00:00.000Z' }),
      ...Array.from({ length: 7 }, (_, i) =>
        order(`p${i}`, { sync_state: i % 2 ? 'failed' : 'pending', updated_at: `2026-11-0${i + 1}T00:00:00.000Z` }),
      ),
    ];
    const d = deps(rows);
    mocks.syncSalesOrder.mockResolvedValue('synced');
    expect(SWEEP_BATCH).toBe(5);
    expect(await sweepPendingOrders(d.deps)).toBe(5);
    expect(mocks.syncSalesOrder.mock.calls.map((c) => c[1])).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(d.tables.sales_orders.every((r) => r.id === 'claimed' || r.claimed_until === null)).toBe(true);
  });

  it('orders by sync_attempts, then updated_at, so failing orders do not starve newer pending ones', async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        order(`stuck${i}`, { sync_state: 'failed', sync_attempts: 4, updated_at: `2026-01-0${i + 1}T00:00:00.000Z` }),
      ),
      order('new-late', { sync_attempts: 0, updated_at: '2026-11-12T00:00:00.000Z' }),
      order('new-early', { sync_attempts: 0, updated_at: '2026-11-11T00:00:00.000Z' }),
      order('once', { sync_state: 'failed', sync_attempts: 1, updated_at: '2026-11-01T00:00:00.000Z' }),
    ];
    const d = deps(rows);
    mocks.syncSalesOrder.mockResolvedValue('failed');
    await sweepPendingOrders(d.deps, 4);
    expect(mocks.syncSalesOrder.mock.calls.map((c) => c[1])).toEqual(['new-early', 'new-late', 'once', 'stuck0']);
  });

  it('skips failed orders whose save did not finish (they need a re-save), but not other failures', async () => {
    const d = deps([
      order('half', { sync_state: 'failed', sync_error: 'Save did not finish: disk full', updated_at: '2026-01-01' }),
      order('bc-down', { sync_state: 'failed', sync_error: 'BC is down', updated_at: '2026-01-02' }),
      order('pending', { sync_error: null, updated_at: '2026-01-03' }),
    ]);
    mocks.syncSalesOrder.mockResolvedValue('synced');
    await sweepPendingOrders(d.deps);
    expect(mocks.syncSalesOrder.mock.calls.map((c) => c[1])).toEqual(['bc-down', 'pending']);
  });

  it('keeps going when one order throws', async () => {
    const d = deps([order('a', { updated_at: '2026-01-01' }), order('b', { updated_at: '2026-01-02' })]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.syncSalesOrder.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce('synced');
    expect(await sweepPendingOrders(d.deps)).toBe(1);
    expect(mocks.syncSalesOrder).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
