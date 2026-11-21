import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type Row } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof fakeSupabase>, resolveBillcom: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/currentUserAccess', () => ({ requirePermission: vi.fn().mockResolvedValue({ orgId: 'org-1', user: { id: 'u' }, access: { isAdmin: true } }) }));
vi.mock('@/lib/businessCentral/activeConnection', () => ({ resolveActiveBcConnection: vi.fn().mockResolvedValue({ id: 'conn-1' }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.db.client }));
vi.mock('@/lib/billcom/customerSyncHooks', () => ({ resolveBillcomConnection: (...a: unknown[]) => mocks.resolveBillcom(...a) }));
vi.mock('@/lib/businessCentral/sync/receivablesSync', () => ({ runReceivablesSync: vi.fn() }));

import { getSalesInvoicesPageData } from './businessCentralReceivables';

const inv = (id: string): Row => ({ id: `row-${id}`, organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: id, posting_date: '2026-11-15' });
const st = (id: string, extra: Row = {}): Row => ({
  organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: id, match: 'found', status: 'PAID_IN_FULL', due_amount: 0, due_date: '2026-11-01', ...extra,
});

beforeEach(() => {
  mocks.db = fakeSupabase({
    business_central_sales_invoices: [inv('a'), inv('b')],
    billcom_invoice_status: [st('a'), st('b', { match: 'mismatch', status: null }), st('a', { bc_connection_id: 'conn-2', status: 'OPEN' }), st('zz')],
  });
});

describe('getSalesInvoicesPageData Bill.com status', () => {
  it('adds the stored Bill.com status of the listed invoices, for this environment only', async () => {
    mocks.resolveBillcom.mockResolvedValue({ id: 'b1', enabled: true });
    const { billcomStatus } = await getSalesInvoicesPageData();
    expect(billcomStatus).toEqual({
      a: { match: 'found', status: 'PAID_IN_FULL', dueAmount: 0, dueDate: '2026-11-01' },
      b: { match: 'mismatch', status: null, dueAmount: 0, dueDate: '2026-11-01' },
    });
  });

  it('null (no column) when the environment has no enabled Bill.com connection', async () => {
    mocks.resolveBillcom.mockResolvedValue(null);
    expect((await getSalesInvoicesPageData()).billcomStatus).toBeNull();
  });

  it('a failure to read statuses never breaks the list', async () => {
    mocks.resolveBillcom.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await getSalesInvoicesPageData();
    expect(r.invoices).toHaveLength(2);
    expect(r.billcomStatus).toBeNull();
  });
});
