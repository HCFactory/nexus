import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireScope: vi.fn(),
  openPushDeps: vi.fn(),
  resolveConnection: vi.fn(),
  pushAfterSave: vi.fn(),
  planInitialPush: vi.fn(),
  pushCustomers: vi.fn(),
  markPending: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let range: [number, number] | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        order: () => q,
        range: (a: number, b: number) => ((range = [a, b]), q),
        then: (res: (v: unknown) => unknown) => {
          const rows = (mocks.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return res({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null });
        },
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/billcom/customerSyncHooks', () => ({
  openPushDeps: mocks.openPushDeps,
  resolveBillcomConnection: mocks.resolveConnection,
  pushCustomerAfterSave: mocks.pushAfterSave,
}));
vi.mock('@/lib/billcom/customerPush', () => ({
  planInitialPush: mocks.planInitialPush,
  pushCustomers: mocks.pushCustomers,
  markPending: mocks.markPending,
}));

import {
  confirmInitialPush,
  getBillcomPushStatus,
  previewInitialPush,
  retryCustomerPush,
  runPendingPush,
} from './billcomCustomers';

const ADMIN_ONLY = 'Only admins can push customers to Bill.com';
const scope = (access: Record<string, boolean>) => ({ orgId: 'org-1', bcConnectionId: 'bc-1', access });
const admin = scope({ isAdmin: true, canEditCustomers: true, canViewCustomers: true });
const editor = scope({ isAdmin: false, canEditCustomers: true, canViewCustomers: true });
const deps = { orgId: 'org-1', bcConnectionId: 'bc-1', billcomConnectionId: 'b1' };
const pushResult = { created: 1, updated: 0, linked: 0, unchanged: 0, failed: 0, needsAttention: 0, remaining: 0 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tables = {};
  mocks.openPushDeps.mockResolvedValue(deps);
  mocks.pushCustomers.mockResolvedValue(pushResult);
});

describe('admin-only bulk actions', () => {
  it('refuse non-admins', async () => {
    mocks.requireScope.mockResolvedValue(editor);
    expect(await previewInitialPush()).toEqual({ ok: false, error: ADMIN_ONLY });
    expect(await confirmInitialPush()).toEqual({ ok: false, error: ADMIN_ONLY });
    expect(await runPendingPush()).toEqual({ ok: false, error: ADMIN_ONLY });
    expect(mocks.openPushDeps).not.toHaveBeenCalled();
  });

  it('preview plans without writing', async () => {
    mocks.requireScope.mockResolvedValue(admin);
    mocks.planInitialPush.mockResolvedValue({ link: 1 });
    expect(await previewInitialPush()).toEqual({ ok: true, preview: { link: 1 } });
    expect(mocks.markPending).not.toHaveBeenCalled();
    expect(mocks.pushCustomers).not.toHaveBeenCalled();
  });

  it('confirm marks every customer pending then runs one 25 s batch', async () => {
    mocks.requireScope.mockResolvedValue(admin);
    mocks.tables.business_central_customers = [
      { organization_id: 'org-1', bc_connection_id: 'bc-1', bc_customer_number: 'C1' },
      { organization_id: 'org-1', bc_connection_id: 'bc-1', bc_customer_number: 'C2' },
      { organization_id: 'org-2', bc_connection_id: 'bc-1', bc_customer_number: 'X' },
    ];
    expect(await confirmInitialPush()).toEqual({ ok: true, result: pushResult });
    expect(mocks.markPending).toHaveBeenCalledWith(deps, ['C1', 'C2']);
    expect(mocks.pushCustomers).toHaveBeenCalledTimes(1);
    expect(mocks.pushCustomers).toHaveBeenCalledWith(deps, { budgetMs: 25000 });
    expect(mocks.markPending.mock.invocationCallOrder[0]).toBeLessThan(mocks.pushCustomers.mock.invocationCallOrder[0]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/customers', 'layout');
  });

  it('runPendingPush runs the pending list with a 25 s budget', async () => {
    mocks.requireScope.mockResolvedValue(admin);
    expect(await runPendingPush()).toEqual({ ok: true, result: pushResult });
    expect(mocks.pushCustomers).toHaveBeenCalledWith(deps, { budgetMs: 25000 });
  });

  it('report Bill.com off in plain language', async () => {
    mocks.requireScope.mockResolvedValue(admin);
    mocks.openPushDeps.mockResolvedValue(null);
    const r = await runPendingPush();
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/Bill\.com is turned off/);
  });
});

describe('retryCustomerPush', () => {
  it('is allowed for customer editors', async () => {
    mocks.requireScope.mockResolvedValue(editor);
    mocks.pushAfterSave.mockResolvedValue({ status: 'synced' });
    expect(await retryCustomerPush('C1')).toEqual({ ok: true, billcom: { status: 'synced' } });
    expect(mocks.pushAfterSave.mock.calls[0][1]).toBe('C1');
  });

  it('refuses users who cannot edit customers', async () => {
    mocks.requireScope.mockResolvedValue(scope({ isAdmin: false, canEditCustomers: false, canViewCustomers: true }));
    expect((await retryCustomerPush('C1')).ok).toBe(false);
    expect(mocks.pushAfterSave).not.toHaveBeenCalled();
  });
});

describe('getBillcomPushStatus', () => {
  it('counts links by status for the scoped connection', async () => {
    mocks.requireScope.mockResolvedValue(editor);
    mocks.resolveConnection.mockResolvedValue({ id: 'b1', enabled: true });
    const l = (status: string, b = 'b1') => ({ organization_id: 'org-1', bc_connection_id: 'bc-1', billcom_connection_id: b, status });
    mocks.tables.billcom_customer_links = [l('pending'), l('pending'), l('failed'), l('synced'), l('pending', 'other')];
    expect(await getBillcomPushStatus()).toEqual({
      ok: true,
      on: true,
      counts: { pending: 2, synced: 1, failed: 1, needs_attention: 0 },
    });
  });

  it('reports off when there is no enabled connection', async () => {
    mocks.requireScope.mockResolvedValue(editor);
    mocks.resolveConnection.mockResolvedValue(null);
    expect(await getBillcomPushStatus()).toEqual({ ok: true, on: false, counts: { pending: 0, synced: 0, failed: 0, needs_attention: 0 } });
  });
});
