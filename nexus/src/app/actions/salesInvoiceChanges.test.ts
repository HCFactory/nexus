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
  discard: vi.fn(),
  loadOpen: vi.fn(),
  readBlock: vi.fn(),
  findExtra: vi.fn(),
  deleteExtra: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/salesOrders/invoiceDeps', () => ({ buildInvoiceDeps: mocks.buildInvoiceDeps }));
vi.mock('@/lib/billcom/invoiceChangeCheck', () => ({ readChangeBlock: mocks.readBlock }));
vi.mock('@/lib/salesOrders/invoiceChangeProcess', () => ({
  startInvoiceChange: mocks.start,
  runInvoiceChange: mocks.run,
  retryInvoiceChange: mocks.retry,
  discardInvoiceChange: mocks.discard,
  loadOpenChange: mocks.loadOpen,
  findExtraDrafts: mocks.findExtra,
  deleteExtraDrafts: mocks.deleteExtra,
}));

import {
  deleteExtraInvoiceDrafts,
  discardChangeInvoice,
  getExtraInvoiceDrafts,
  getInvoiceChangeState,
  resumeInvoiceChangeIfStuck,
  retryChangeInvoice,
  startChangeInvoice,
} from './salesInvoiceChanges';

const NO_PERMISSION = "You don't have permission to change sales orders";
const PAID = "Paid or partly paid in Bill.com — can't change";
const T0 = '2026-11-17T10:00:00.000Z';
const scope = (edit = true) => ({
  orgId: 'org-1', bcConnectionId: 'conn-1', user: { id: 'user-1' },
  access: { canEditSalesOrders: edit, canViewSalesOrders: true },
});
const order = (extra: Row = {}): Row => ({
  id: 'o1', organization_id: 'org-1', bc_connection_id: 'conn-1', invoice_state: 'done', claimed_until: null, billcom_invoice_id: '00eX', ...extra,
});
const line = (): Row => ({
  id: 'l1', organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', position: 1, item_number: '20000',
  description: 'Candy', unit_of_measure_code: 'BOX', quantity: 1, unit_price: 24.5, discount_percent: 0, bc_unit_price: 24.5,
  bc_line_discount_percent: null, removed: false,
});
const draft = (extra: Row = {}) => ({
  key: 'k', id: 'l1', item_number: '20000', description: 'Candy', quantity: 2, unit_price: null, discount_percent: null,
  unit_of_measure_code: 'BOX', amount_incl_tax: null, estimate_price: null, bc_unit_price: 24.5, bc_line_discount_percent: null, ...extra,
});
const openChange = (state = 'post_failed') => ({ id: 'ch1', sales_order_id: 'o1', state });

let db: FakeSupabase;
let deps: Record<string, unknown>;
function setup(o: Row = {}) {
  db = fakeSupabase({ sales_orders: [order(o)], sales_order_lines: [line()], users: [{ id: 'user-1', display_name: 'Pat Lee' }] });
  mocks.createServiceClient.mockReturnValue(db.client);
  deps = { supabase: db.client, orgId: 'org-1', connectionId: 'conn-1', now: () => T0, billcom: { bill: true } };
  mocks.buildInvoiceDeps.mockResolvedValue(deps);
}
async function runAfter() {
  for (const [cb] of mocks.after.mock.calls) await cb();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireScope.mockResolvedValue(scope());
  mocks.readBlock.mockResolvedValue(null);
  mocks.start.mockResolvedValue({ ok: true, changeId: 'ch1' });
  mocks.run.mockResolvedValue('done');
  mocks.retry.mockResolvedValue({ ok: true });
  mocks.discard.mockResolvedValue({ ok: true });
  mocks.loadOpen.mockResolvedValue(null);
  setup();
});

describe('startChangeInvoice', () => {
  it('refuses without edit permission', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await startChangeInvoice('o1', [draft()], 'why')).toEqual({ ok: false, error: NO_PERMISSION });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('a server-side Bill.com block is returned and the process is not started', async () => {
    mocks.readBlock.mockResolvedValue(PAID);
    expect(await startChangeInvoice('o1', [draft()], 'why')).toEqual({ ok: false, error: PAID });
    expect(mocks.readBlock).toHaveBeenCalledWith(deps.billcom, '00eX');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('a draft line error is returned', async () => {
    expect(await startChangeInvoice('o1', [draft({ id: undefined, unit_price: null, bc_unit_price: null, estimate_price: null })], 'why')).toEqual({ ok: false, error: 'Enter a unit price for 20000.' });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('starts with the user name and the resolved lines, then runs in the background', async () => {
    expect(await startChangeInvoice('o1', [draft()], 'Customer got 2')).toEqual({ ok: true });
    expect(mocks.start).toHaveBeenCalledWith(deps, {
      orderId: 'o1', reason: 'Customer got 2', userId: 'user-1', userName: 'Pat Lee', blockedReason: null,
      lines: [{ item_number: '20000', description: 'Candy', unit_of_measure_code: 'BOX', quantity: 2, unit_price: 24.5, discount_percent: 0 }],
    });
    expect(mocks.run).not.toHaveBeenCalled();
    await runAfter();
    expect(mocks.run).toHaveBeenCalledWith(deps, 'ch1');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/sales-orders', 'layout');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/receivables/invoices', 'layout');
  });

  it("the process's refusal is returned", async () => {
    mocks.start.mockResolvedValue({ ok: false, error: 'A change is already open for this invoice.' });
    expect(await startChangeInvoice('o1', [draft()], 'why')).toEqual({ ok: false, error: 'A change is already open for this invoice.' });
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe('getInvoiceChangeState', () => {
  it('an invoiced order with no open change gets the Bill.com check', async () => {
    mocks.readBlock.mockResolvedValue(PAID);
    expect(await getInvoiceChangeState('o1')).toEqual({ change: null, blockedReason: PAID });
  });

  it('an open change is returned and Bill.com is not read', async () => {
    mocks.loadOpen.mockResolvedValue(openChange());
    setup({ invoice_state: 'changing' });
    expect(await getInvoiceChangeState('o1')).toEqual({ change: openChange(), blockedReason: null });
    expect(mocks.readBlock).not.toHaveBeenCalled();
  });

  it('an order that is not invoiced is not checked', async () => {
    setup({ invoice_state: 'none' });
    expect(await getInvoiceChangeState('o1')).toEqual({ change: null, blockedReason: null });
    expect(mocks.readBlock).not.toHaveBeenCalled();
  });
});

describe('retry and discard', () => {
  it('retry runs the open change in the background', async () => {
    mocks.loadOpen.mockResolvedValue(openChange('post_failed'));
    expect(await retryChangeInvoice('o1')).toEqual({ ok: true });
    await runAfter();
    expect(mocks.retry).toHaveBeenCalledWith(deps, 'ch1');
  });

  it('retry with nothing failed', async () => {
    mocks.loadOpen.mockResolvedValue(openChange('posting'));
    expect(await retryChangeInvoice('o1')).toEqual({ ok: false, error: 'Nothing to retry.' });
  });

  it('discard passes the result through', async () => {
    mocks.loadOpen.mockResolvedValue(openChange('cancel_failed'));
    mocks.discard.mockResolvedValue({ ok: false, error: 'nope' });
    expect(await discardChangeInvoice('o1')).toEqual({ ok: false, error: 'nope' });
    expect(mocks.discard).toHaveBeenCalledWith(deps, 'ch1');
  });
});

describe('resumeInvoiceChangeIfStuck', () => {
  it('schedules a run for a resumable change whose lease expired', async () => {
    mocks.loadOpen.mockResolvedValue(openChange('posting'));
    setup({ invoice_state: 'changing', claimed_until: '2026-11-17T09:00:00.000Z' });
    await resumeInvoiceChangeIfStuck('o1');
    await runAfter();
    expect(mocks.run).toHaveBeenCalledWith(deps, 'ch1');
  });

  it('does nothing while the lease is held, or for a failed change', async () => {
    mocks.loadOpen.mockResolvedValue(openChange('posting'));
    setup({ invoice_state: 'changing', claimed_until: '2099-01-01T00:00:00.000Z' });
    await resumeInvoiceChangeIfStuck('o1');
    mocks.loadOpen.mockResolvedValue(openChange('post_failed'));
    setup({ invoice_state: 'changing' });
    await resumeInvoiceChangeIfStuck('o1');
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe('extra drafts', () => {
  it('both need edit permission', async () => {
    setup();
    mocks.requireScope.mockResolvedValue(scope(false));
    expect(await getExtraInvoiceDrafts('o1')).toEqual({ ok: false, error: NO_PERMISSION });
    expect(await deleteExtraInvoiceDrafts('o1', ['d2'])).toEqual({ ok: false, error: NO_PERMISSION });
    expect(mocks.deleteExtra).not.toHaveBeenCalled();
  });

  it("the preview is the open change's keep and extras", async () => {
    setup();
    mocks.loadOpen.mockResolvedValue(openChange());
    const preview = { ok: true, keep: { id: 'd1', no: 'S-INV102028', totalExclTax: 58 }, extra: [{ id: 'd2', no: 'S-INV102029', totalExclTax: 0 }] };
    mocks.findExtra.mockResolvedValue(preview);
    expect(await getExtraInvoiceDrafts('o1')).toEqual(preview);
    expect(mocks.findExtra).toHaveBeenCalledWith(deps, 'ch1');
  });

  it('delete passes the confirmed ids and refreshes the pages', async () => {
    setup();
    mocks.loadOpen.mockResolvedValue(openChange());
    mocks.deleteExtra.mockResolvedValue({ ok: true });
    expect(await deleteExtraInvoiceDrafts('o1', ['d2'])).toEqual({ ok: true });
    expect(mocks.deleteExtra).toHaveBeenCalledWith(deps, 'ch1', ['d2']);
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });

  it('no open change → nothing to clean up', async () => {
    setup();
    mocks.loadOpen.mockResolvedValue(null);
    expect(await deleteExtraInvoiceDrafts('o1', ['d2'])).toEqual({ ok: false, error: 'Nothing to clean up.' });
  });
});
