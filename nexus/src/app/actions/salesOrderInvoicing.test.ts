import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({
  requireScope: vi.fn(),
  createServiceClient: vi.fn(),
  revalidatePath: vi.fn(),
  after: vi.fn(),
  buildInvoiceDeps: vi.fn(),
  start: vi.fn(),
  run: vi.fn(),
  retry: vi.fn(),
  resolveConn: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/salesOrders/invoiceDeps', () => ({ buildInvoiceDeps: mocks.buildInvoiceDeps }));
vi.mock('@/lib/billcom/customerSyncHooks', () => ({ resolveBillcomConnection: mocks.resolveConn }));
vi.mock('@/lib/salesOrders/invoiceProcess', () => ({
  startInvoiceProcess: mocks.start,
  runInvoiceProcess: mocks.run,
  retryInvoiceProcess: mocks.retry,
}));

import { createInvoice, getInvoiceReadiness, resumeInvoiceIfStuck, retryInvoice } from './salesOrderInvoicing';

const NO_PERMISSION = "You don't have permission to change sales orders";
const scope = (edit = true, view = true) => ({
  orgId: 'org-1', bcConnectionId: 'conn-1', user: { id: 'user-1' },
  access: { canEditSalesOrders: edit, canViewSalesOrders: view },
});
const order = (extra: Row = {}): Row => ({
  id: 'o1', organization_id: 'org-1', bc_connection_id: 'conn-1', status: 'final', sync_state: 'synced',
  invoice_state: 'none', claimed_until: null, ...extra,
});
const link = (extra: Row = {}): Row => ({
  organization_id: 'org-1', bc_connection_id: 'conn-1', billcom_connection_id: 'bc-1', bc_customer_number: 'C1',
  status: 'synced', billcom_customer_id: 'b1', ...extra,
});

let db: FakeSupabase;
function setup(tables: Record<string, Row[]> = {}) {
  db = fakeSupabase({ sales_orders: [order()], billcom_customer_links: [link()], ...tables });
  mocks.createServiceClient.mockReturnValue(db.client);
}
async function runAfter() {
  for (const [cb] of mocks.after.mock.calls) await cb();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireScope.mockResolvedValue(scope());
  mocks.buildInvoiceDeps.mockResolvedValue({ deps: true });
  mocks.start.mockResolvedValue({ ok: true });
  mocks.run.mockResolvedValue('done');
  mocks.retry.mockResolvedValue({ ok: true, state: 'done' });
  mocks.resolveConn.mockResolvedValue({ id: 'bc-1', enabled: true });
  setup();
});

describe('createInvoice', () => {
  it('refuses without edit permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await createInvoice('o1')).toEqual({ ok: false, error: NO_PERMISSION });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('returns the exact reason and schedules nothing when the start is refused', async () => {
    mocks.start.mockResolvedValue({ ok: false, error: "This customer isn't in Bill.com yet. Push it from Customers first." });
    expect(await createInvoice('o1')).toEqual({ ok: false, error: "This customer isn't in Bill.com yet. Push it from Customers first." });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('starts, revalidates, and runs the process in after()', async () => {
    expect(await createInvoice('o1')).toEqual({ ok: true });
    expect(mocks.buildInvoiceDeps).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1' });
    expect(mocks.start).toHaveBeenCalledWith({ deps: true }, 'o1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/sales-orders', 'layout');
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.run).not.toHaveBeenCalled();
    await runAfter();
    expect(mocks.run).toHaveBeenCalledWith({ deps: true }, 'o1');
  });

  it('turns a thrown error into a message', async () => {
    mocks.start.mockRejectedValue(new Error('boom'));
    expect(await createInvoice('o1')).toEqual({ ok: false, error: 'Could not create the invoice: boom' });
  });
});

describe('retryInvoice', () => {
  it('refuses without edit permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await retryInvoice('o1')).toEqual({ ok: false, error: NO_PERMISSION });
  });

  it('says Nothing to retry unless the order failed', async () => {
    expect(await retryInvoice('o1')).toEqual({ ok: false, error: 'Nothing to retry.' });
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each([{ sync_state: 'pending' }, { status: 'draft' }])(
    'does not refuse a post_failed order with %o up front (BC may already hold the posted invoice)',
    async (extra) => {
      setup({ sales_orders: [order({ invoice_state: 'post_failed', ...extra })] });
      expect(await retryInvoice('o1')).toEqual({ ok: true });
      await runAfter();
      expect(mocks.retry).toHaveBeenCalledWith({ deps: true }, 'o1');
    },
  );

  it.each(['post_failed', 'billcom_failed'])('routes %s to retryInvoiceProcess in after()', async (state) => {
    setup({ sales_orders: [order({ invoice_state: state })] });
    expect(await retryInvoice('o1')).toEqual({ ok: true });
    await runAfter();
    expect(mocks.retry).toHaveBeenCalledWith({ deps: true }, 'o1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/sales-orders', 'layout');
  });

  it('does not require synced for a billcom_failed order', async () => {
    setup({ sales_orders: [order({ invoice_state: 'billcom_failed', sync_state: 'pending' })] });
    expect(await retryInvoice('o1')).toEqual({ ok: true });
  });
});

describe('resumeInvoiceIfStuck', () => {
  it.each(['posting', 'posted', 'billcom_sending'])('runs %s with a free lease', async (state) => {
    setup({ sales_orders: [order({ invoice_state: state })] });
    await resumeInvoiceIfStuck('o1');
    await runAfter();
    expect(mocks.run).toHaveBeenCalledWith({ deps: true }, 'o1');
  });

  it('runs when the lease has expired', async () => {
    setup({ sales_orders: [order({ invoice_state: 'posting', claimed_until: '2000-01-01T00:00:00.000Z' })] });
    await resumeInvoiceIfStuck('o1');
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the lease is held, or in other states', async () => {
    setup({ sales_orders: [order({ invoice_state: 'posting', claimed_until: '2999-01-01T00:00:00.000Z' })] });
    await resumeInvoiceIfStuck('o1');
    for (const state of ['none', 'post_failed', 'billcom_failed', 'done']) {
      setup({ sales_orders: [order({ invoice_state: state })] });
      await resumeInvoiceIfStuck('o1');
    }
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mocks.requireScope.mockRejectedValue(new Error('no env'));
    await expect(resumeInvoiceIfStuck('o1')).resolves.toBeUndefined();
    mocks.requireScope.mockResolvedValue(scope());
    mocks.createServiceClient.mockImplementation(() => { throw new Error('db'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(resumeInvoiceIfStuck('o1')).resolves.toBeUndefined();
  });
});

describe('getInvoiceReadiness', () => {
  it("is ready without any Bill.com link when this environment's invoices come through Bill.com's connector", async () => {
    mocks.requireScope.mockResolvedValue({ ...scope(), connection: { billcom_via_connector: true } });
    mocks.resolveConn.mockResolvedValue(null);
    setup({ billcom_customer_links: [] });
    expect(await getInvoiceReadiness('C1')).toEqual({ blockedReason: null });
  });

  it('is ready for a synced link', async () => {
    expect(await getInvoiceReadiness('C1')).toEqual({ blockedReason: null });
  });

  it('reflects the link status', async () => {
    setup({ billcom_customer_links: [link({ status: 'needs_attention' })] });
    expect((await getInvoiceReadiness('C1')).blockedReason).toBe('Add a name and email to this customer in Customers before invoicing.');
    setup({ billcom_customer_links: [link({ status: 'failed' })] });
    expect((await getInvoiceReadiness('C1')).blockedReason).toBe("This customer couldn't be sent to Bill.com. Retry it from Customers first.");
    setup({ billcom_customer_links: [] });
    expect((await getInvoiceReadiness('C1')).blockedReason).toBe("This customer isn't in Bill.com yet. Push it from Customers first.");
  });

  it('says Bill.com is off when disabled or missing', async () => {
    const off = 'Bill.com is turned off. Turn it on in Settings before invoicing.';
    mocks.resolveConn.mockResolvedValue({ id: 'bc-1', enabled: false });
    expect((await getInvoiceReadiness('C1')).blockedReason).toBe(off);
    mocks.resolveConn.mockResolvedValue(null);
    expect((await getInvoiceReadiness('C1')).blockedReason).toBe(off);
  });

  it('reports a check failure instead of throwing', async () => {
    mocks.resolveConn.mockRejectedValue(new Error('x'));
    expect(await getInvoiceReadiness('C1')).toEqual({ blockedReason: 'Could not check Bill.com for this customer.' });
  });
});
