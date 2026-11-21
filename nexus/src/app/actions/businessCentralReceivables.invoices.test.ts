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

import { parseSalesInvoiceListParams } from '@/lib/receivables/salesInvoiceList';

const base = parseSalesInvoiceListParams({});
const inv = (id: string, extra: Row = {}): Row => ({
  id: `row-${id}`, organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: id, posting_date: '2026-11-15', bc_invoice_number: `INV-${id}`,
  search_text: `INV-${id}`, billcom_group: 'unmatched', billcom_owed_due_date: null,
  billcom_match: null, billcom_status: null, billcom_due_amount: null, billcom_due_date: null, ...extra,
});

beforeEach(() => {
  mocks.db = fakeSupabase({
    sales_invoice_list: [
      inv('a', { billcom_match: 'found', billcom_status: 'PAID_IN_FULL', billcom_due_amount: '0', billcom_due_date: '2026-11-01', billcom_group: 'paid' }),
      inv('b', { billcom_match: 'mismatch' }),
      inv('c'),
      inv('x', { bc_connection_id: 'conn-2' }),
    ],
  });
});

describe('getSalesInvoicesPageData', () => {
  it('one page of this environment’s invoices with the total, and each listed invoice’s stored Bill.com status', async () => {
    mocks.resolveBillcom.mockResolvedValue({ id: 'b1', enabled: true });
    const r = await getSalesInvoicesPageData(base);
    expect(r.total).toBe(3);
    expect(r.invoices.map((i) => i.bc_invoice_id).sort()).toEqual(['a', 'b', 'c']);
    expect(r.billcomStatus).toEqual({
      a: { match: 'found', status: 'PAID_IN_FULL', dueAmount: 0, dueDate: '2026-11-01' },
      b: { match: 'mismatch', status: null, dueAmount: null, dueDate: null },
    });
    expect(r.error).toBeNull();
  });

  it('filters on the server (here: Bill.com Paid)', async () => {
    mocks.resolveBillcom.mockResolvedValue({ id: 'b1', enabled: true });
    const r = await getSalesInvoicesPageData({ ...base, billcom: 'paid' }, '2026-11-20');
    expect(r.invoices.map((i) => i.bc_invoice_id)).toEqual(['a']);
    expect(r.total).toBe(1);
  });

  it('null (no column) and no Bill.com filtering when the environment has no enabled Bill.com connection', async () => {
    mocks.resolveBillcom.mockResolvedValue(null);
    const r = await getSalesInvoicesPageData({ ...base, billcom: 'paid' });
    expect(r.billcomStatus).toBeNull();
    expect(r.total).toBe(3);
  });

  it('a failure to look up Bill.com never breaks the list', async () => {
    mocks.resolveBillcom.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await getSalesInvoicesPageData(base);
    expect(r.invoices).toHaveLength(3);
    expect(r.billcomStatus).toBeNull();
  });

  it('a list read failure comes back as a message', async () => {
    mocks.resolveBillcom.mockResolvedValue(null);
    mocks.db.failOn = () => 'boom';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getSalesInvoicesPageData(base)).toEqual({ invoices: [], total: 0, billcomStatus: null, error: 'Could not load invoices: boom' });
  });
});
