import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase';
import type { LineDraft, SalesOrderInput } from '@/types/salesOrders';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  revalidatePath: vi.fn(),
  requireScope: vi.fn(),
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
  createBcClientForOrg: vi.fn(),
  createTransport: vi.fn(),
  getCompany: vi.fn(),
  syncSalesOrder: vi.fn(),
  deleteSalesOrderInBc: vi.fn(),
  findBcOrderByMarker: vi.fn(),
  getSelectOptions: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/businessCentral/environmentScope', () => ({ requireActiveBusinessCentralScope: mocks.requireScope }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: mocks.createBcClientForOrg }));
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({ createReferenceTransport: mocks.createTransport }));
vi.mock('@/lib/salesOrders/orderSync', () => ({
  syncSalesOrder: mocks.syncSalesOrder,
  deleteSalesOrderInBc: mocks.deleteSalesOrderInBc,
  findBcOrderByMarker: mocks.findBcOrderByMarker,
}));
vi.mock('./customerReferenceLists', () => ({ getSelectOptions: mocks.getSelectOptions }));

import {
  deleteSalesOrder,
  getSalesOrder,
  getSalesOrderFormContext,
  listSalesOrders,
  overwriteBcWithNexus,
  retrySalesOrderSync,
  saveSalesOrder,
  setSalesOrderStatus,
} from './salesOrders';

const NO_PERMISSION = "You don't have permission to change sales orders";
const BUSY = 'This order is being sent to BC. Try again in a moment.';

const scope = (canEditSalesOrders = true, canViewSalesOrders = true) => ({
  orgId: 'org-1',
  bcConnectionId: 'conn-1',
  user: { id: 'user-1' },
  connection: { id: 'conn-1', time_zone: 'Pacific/Honolulu' },
  access: { canEditSalesOrders, canViewSalesOrders },
});

const header = {
  bill_name: 'Acme', bill_address: '1 St', bill_address_2: '', bill_city: 'Kailua', bill_state: 'HI',
  bill_post_code: '96734', bill_country: 'US', bill_contact_no: '', bill_phone: '', bill_mobile: '',
  bill_email: '', bill_email_cc: '', ship_to_code: '', ship_to_name: 'Acme', ship_to_address: '1 St',
  ship_to_address_2: '', ship_to_city: 'Kailua', ship_to_state: 'HI', ship_to_post_code: '96734',
  ship_to_country: 'US', ship_to_contact: '', ship_to_phone: '', payment_terms_code: 'NET30',
  tax_area_code: 'HI', gen_bus_posting_group: 'DOM', customer_posting_group: 'DOM',
  shipment_method_code: '', location_code: 'MAIN', tax_liable: true,
};

const line = (key: string, extra: Partial<LineDraft> = {}): LineDraft => ({
  key, item_number: '1000', description: 'Box', quantity: 2, unit_price: null, discount_percent: 0,
  unit_of_measure_code: 'EA', amount_incl_tax: null, estimate_price: null, bc_unit_price: null, ...extra,
});

const input = (extra: Partial<SalesOrderInput> = {}): SalesOrderInput => ({
  ...header,
  customer_id: 'cust-1', customer_number: 'C1', status: 'draft', order_date: '2026-11-13',
  requested_delivery_date: null, invoice_number: null, customer_po: 'PO-1', notes: '',
  lines: [line('k1')], ...extra,
});

const orderRow = (id: string, extra: Row = {}): Row => ({
  id, organization_id: 'org-1', bc_connection_id: 'conn-1', ...header,
  customer_id: 'cust-1', customer_number: 'C1', status: 'draft', order_date: '2026-11-13',
  requested_delivery_date: null, invoice_number: null, customer_po: 'PO-1', notes: '',
  bc_order_number: null, bc_create_marker: null, sync_state: 'synced', sync_error: null,
  sync_attempts: 0, claimed_until: null, local_version: 3, synced_version: 3,
  updated_at: '2026-11-01T00:00:00.000Z', created_at: '2026-11-01T00:00:00.000Z', ...extra,
});

const lineRow = (id: string, extra: Row = {}): Row => ({
  id, organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', position: 0,
  item_number: '1000', description: 'Box', unit_of_measure_code: 'EA', quantity: 2, unit_price: null,
  discount_percent: 0, removed: false, bc_line_no: null, bc_etag: null, ...extra,
});

let db: FakeSupabase;

function setup(tables: Record<string, Row[]> = {}) {
  db = fakeSupabase({ sales_orders: [], sales_order_lines: [], ...tables });
  mocks.createClient.mockResolvedValue(db.client);
  mocks.createServiceClient.mockReturnValue(db.client);
}

/** Run every callback handed to after(). */
async function runAfter() {
  for (const [cb] of mocks.after.mock.calls) await cb();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireScope.mockResolvedValue(scope());
  mocks.createBcClientForOrg.mockResolvedValue({ config: { companyId: 'c1' }, getCompany: mocks.getCompany });
  mocks.getCompany.mockResolvedValue({ name: 'CRONUS' });
  mocks.createTransport.mockReturnValue({ transport: true });
  mocks.syncSalesOrder.mockResolvedValue('synced');
  mocks.getSelectOptions.mockResolvedValue([]);
  setup();
});

describe('permissions', () => {
  it('refuses every write without canEditSalesOrders', async () => {
    mocks.requireScope.mockResolvedValue(scope(false));
    setup({ sales_orders: [orderRow('o1')] });
    const fail = { ok: false, error: NO_PERMISSION };
    expect(await saveSalesOrder(input())).toEqual(fail);
    expect(await setSalesOrderStatus('o1', 'final')).toEqual(fail);
    expect(await deleteSalesOrder('o1')).toEqual(fail);
    expect(await retrySalesOrderSync('o1')).toEqual(fail);
    expect(await overwriteBcWithNexus('o1')).toEqual(fail);
    expect(db.writes).toEqual([]);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('refuses writes with edit but without view', async () => {
    mocks.requireScope.mockResolvedValue(scope(true, false));
    expect(await saveSalesOrder(input())).toEqual({ ok: false, error: NO_PERMISSION });
  });

  it('read actions return nothing without canViewSalesOrders', async () => {
    mocks.requireScope.mockResolvedValue(scope(false, false));
    setup({ sales_orders: [orderRow('o1')] });
    expect(await listSalesOrders()).toEqual([]);
    expect(await getSalesOrder('o1')).toBeNull();
    expect(mocks.after).not.toHaveBeenCalled();
  });
});

describe('saveSalesOrder: create', () => {
  it('creates a pending order with lines, schedules one background sync and revalidates', async () => {
    const res = await saveSalesOrder(input({ lines: [line('k1'), line('k2', { item_number: '2000' }), line('blank', { item_number: '' })] }));
    expect(res).toMatchObject({ ok: true });
    const id = (res as { id: string }).id;
    const o = db.tables.sales_orders[0];
    expect(o).toMatchObject({ id, organization_id: 'org-1', bc_connection_id: 'conn-1', sync_state: 'pending', local_version: 1, created_by: 'user-1', customer_po: 'PO-1' });
    expect(db.tables.sales_order_lines.map((l) => [l.item_number, l.position, l.sales_order_id])).toEqual([['1000', 0, id], ['2000', 1, id]]);
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/sales-orders', 'layout');
    await runAfter();
    expect(mocks.syncSalesOrder).toHaveBeenCalledTimes(1);
    expect(mocks.syncSalesOrder.mock.calls[0][1]).toBe(id);
    expect(db.tables.sales_orders[0].claimed_until).toBeNull();
  });

  it("uses today in the connection's time zone when no order date is given", async () => {
    await saveSalesOrder(input({ order_date: '' }));
    expect(db.tables.sales_orders[0].order_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('validates invoice #, quantity and discount', async () => {
    expect(await saveSalesOrder(input({ invoice_number: 'X'.repeat(36) }))).toEqual({ ok: false, error: 'Invoice # must be 35 characters or fewer.' });
    expect(await saveSalesOrder(input({ lines: [line('k', { quantity: 0 })] }))).toEqual({ ok: false, error: 'Quantity must be greater than 0.' });
    expect(await saveSalesOrder(input({ lines: [line('k', { discount_percent: 101 })] }))).toEqual({ ok: false, error: 'Discount % must be between 0 and 100.' });
    expect(await saveSalesOrder(input({ lines: [line('k', { discount_percent: -1 })] }))).toEqual({ ok: false, error: 'Discount % must be between 0 and 100.' });
    expect(db.writes).toEqual([]);
  });

  it('refuses to create a Shipped order', async () => {
    expect(await saveSalesOrder(input({ status: 'shipped' }))).toEqual({ ok: false, error: 'Shipped and Invoiced are set by the Ship and Create invoice buttons.' });
  });
});

describe('saveSalesOrder: update', () => {
  it('increments local_version, sets pending and schedules after once', async () => {
    setup({ sales_orders: [orderRow('o1')], sales_order_lines: [lineRow('l1')] });
    const res = await saveSalesOrder({ ...input({ customer_po: 'PO-2', lines: [line('k1', { id: 'l1', quantity: 5 })] }), id: 'o1' });
    expect(res).toEqual({ ok: true, id: 'o1' });
    expect(db.tables.sales_orders[0]).toMatchObject({ local_version: 5, sync_state: 'pending', customer_po: 'PO-2' });
    expect(db.tables.sales_order_lines[0]).toMatchObject({ id: 'l1', quantity: 5 });
    expect(mocks.after).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed customer_po on a final order, but allows changing only notes', async () => {
    setup({ sales_orders: [orderRow('o1', { status: 'final' })], sales_order_lines: [lineRow('l1')] });
    const lines = [line('k1', { id: 'l1' })];
    expect(await saveSalesOrder({ ...input({ status: 'final', customer_po: 'PO-2', lines }), id: 'o1' })).toEqual({
      ok: false,
      error: 'This order is Final. Move it back to Draft to change it.',
    });
    expect(db.writes).toEqual([]);
    expect(await saveSalesOrder({ ...input({ status: 'final', notes: 'call first', lines }), id: 'o1' })).toEqual({ ok: true, id: 'o1' });
    expect(db.tables.sales_orders[0]).toMatchObject({ notes: 'call first', customer_po: 'PO-1' });
  });

  it('refuses a changed line on a final order', async () => {
    setup({ sales_orders: [orderRow('o1', { status: 'final' })], sales_order_lines: [lineRow('l1')] });
    const res = await saveSalesOrder({ ...input({ status: 'final', lines: [line('k1', { id: 'l1', quantity: 9 })] }), id: 'o1' });
    expect(res).toEqual({ ok: false, error: 'This order is Final. Move it back to Draft to change it.' });
  });

  it('marks a removed BC line removed, deletes a removed unsent line, ignores the blank row', async () => {
    setup({
      sales_orders: [orderRow('o1')],
      sales_order_lines: [
        lineRow('keep', { position: 0 }),
        lineRow('sent', { position: 1, bc_line_no: 10000 }),
        lineRow('unsent', { position: 2 }),
      ],
    });
    const res = await saveSalesOrder({
      ...input({ lines: [line('n', { item_number: '3000' }), line('k', { id: 'keep' }), line('blank', { item_number: '' })] }),
      id: 'o1',
    });
    expect(res).toEqual({ ok: true, id: 'o1' });
    const byId = Object.fromEntries(db.tables.sales_order_lines.map((l) => [l.id, l]));
    expect(byId.sent.removed).toBe(true);
    expect(byId.unsent).toBeUndefined();
    expect(byId.keep).toMatchObject({ position: 1, removed: false });
    const added = db.tables.sales_order_lines.filter((l) => l.item_number === '3000');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ position: 0, sales_order_id: 'o1', organization_id: 'org-1', bc_connection_id: 'conn-1' });
    expect(db.tables.sales_order_lines.some((l) => l.item_number === '')).toBe(false);
  });

  it('bumps the version before writing lines and again after, so a sync reading mid-save ends pending', async () => {
    setup({ sales_orders: [orderRow('o1')], sales_order_lines: [lineRow('l1')] });
    const versionsAtLineWrite: unknown[] = [];
    db.failOn = (table, op) => {
      if (table === 'sales_order_lines' && op !== 'select') versionsAtLineWrite.push(db.tables.sales_orders[0].local_version);
      return null;
    };
    const res = await saveSalesOrder({ ...input({ lines: [line('k1', { id: 'l1', quantity: 7 })] }), id: 'o1' });
    expect(res).toEqual({ ok: true, id: 'o1' });
    expect(versionsAtLineWrite).toEqual([4]);
    expect(db.tables.sales_orders[0]).toMatchObject({ local_version: 5, sync_state: 'pending' });
  });

  it('a sync that marks the order synced during the save is undone by the final bump', async () => {
    setup({ sales_orders: [orderRow('o1')], sales_order_lines: [lineRow('l1')] });
    db.failOn = (table, op) => {
      if (op === 'select') return null;
      // A sync that read version 4 finishes while the lines are being written.
      if (table === 'sales_order_lines') Object.assign(db.tables.sales_orders[0], { sync_state: 'synced', synced_version: 4 });
      return null;
    };
    await saveSalesOrder({ ...input({ lines: [line('k1', { id: 'l1', quantity: 7 })] }), id: 'o1' });
    expect(db.tables.sales_orders[0]).toMatchObject({ local_version: 5, sync_state: 'pending', synced_version: 4 });
  });

  it('refuses when someone else saved since the order was read, without writing lines', async () => {
    setup({ sales_orders: [orderRow('o1')], sales_order_lines: [lineRow('l1')] });
    let first = true;
    db.failOn = (table, op) => {
      if (table === 'sales_orders' && op === 'update' && first) {
        first = false;
        db.tables.sales_orders[0].local_version = 9; // another save got in first
      }
      return null;
    };
    const res = await saveSalesOrder({ ...input({ lines: [line('k1', { id: 'l1', quantity: 7 })] }), id: 'o1' });
    expect(res).toEqual({ ok: false, error: 'This order was changed by someone else. Reload and try again.' });
    expect(db.writes.filter(([t]) => t === 'sales_order_lines')).toEqual([]);
    expect(db.tables.sales_order_lines[0].quantity).toBe(2);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('an empty order date keeps the current one, also on a locked order', async () => {
    setup({ sales_orders: [orderRow('o1', { status: 'final' })], sales_order_lines: [lineRow('l1')] });
    const res = await saveSalesOrder({ ...input({ status: 'final', order_date: '', notes: 'n', lines: [line('k1', { id: 'l1' })] }), id: 'o1' });
    expect(res).toEqual({ ok: true, id: 'o1' });
    expect(db.tables.sales_orders[0]).toMatchObject({ order_date: '2026-11-13', notes: 'n' });
    setup({ sales_orders: [orderRow('o2')], sales_order_lines: [lineRow('l2', { sales_order_id: 'o2' })] });
    await saveSalesOrder({ ...input({ order_date: '', lines: [line('k2', { id: 'l2' })] }), id: 'o2' });
    expect(db.tables.sales_orders[0].order_date).toBe('2026-11-13');
  });

  it('does not touch an order of another organization', async () => {
    setup({ sales_orders: [orderRow('o1', { organization_id: 'org-2' })] });
    expect(await saveSalesOrder({ ...input(), id: 'o1' })).toEqual({ ok: false, error: 'Sales order not found.' });
  });
});

describe('setSalesOrderStatus', () => {
  it('refuses shipped', async () => {
    setup({ sales_orders: [orderRow('o1')] });
    expect(await setSalesOrderStatus('o1', 'shipped')).toEqual({ ok: false, error: 'Shipped and Invoiced are set by the Ship and Create invoice buttons.' });
  });

  it('moves draft to final', async () => {
    setup({ sales_orders: [orderRow('o1')] });
    expect(await setSalesOrderStatus('o1', 'final')).toEqual({ ok: true });
    expect(db.tables.sales_orders[0].status).toBe('final');
  });
});

describe('deleteSalesOrder', () => {
  it('refuses a pulled order', async () => {
    setup({ sales_orders: [orderRow('o1', { status: 'pulled' })] });
    expect(await deleteSalesOrder('o1')).toEqual({ ok: false, error: 'Only Draft or Final orders can be deleted.' });
  });

  it('deletes locally with no BC call when the order has no BC number', async () => {
    setup({ sales_orders: [orderRow('o1')], sales_order_lines: [lineRow('l1')] });
    expect(await deleteSalesOrder('o1')).toEqual({ ok: true });
    expect(db.tables.sales_orders).toEqual([]);
    expect(mocks.deleteSalesOrderInBc).not.toHaveBeenCalled();
    expect(mocks.createBcClientForOrg).not.toHaveBeenCalled();
  });

  it('refuses while the order is claimed', async () => {
    setup({ sales_orders: [orderRow('o1', { claimed_until: '2999-01-01T00:00:00.000Z' })] });
    expect(await deleteSalesOrder('o1')).toEqual({ ok: false, error: BUSY });
    expect(db.tables.sales_orders).toHaveLength(1);
  });

  it('deletes in BC first, then locally', async () => {
    setup({ sales_orders: [orderRow('o1', { bc_order_number: 'SO1' })] });
    expect(await deleteSalesOrder('o1')).toEqual({ ok: true });
    expect(mocks.deleteSalesOrderInBc.mock.calls[0][1]).toMatchObject({ id: 'o1', bc_order_number: 'SO1' });
    expect(db.tables.sales_orders).toEqual([]);
  });

  it('with only a create marker, finds the BC order by marker and deletes it in BC first', async () => {
    setup({ sales_orders: [orderRow('o1', { bc_create_marker: 'NX-o1' })] });
    mocks.findBcOrderByMarker.mockResolvedValue({ key: {}, etag: 'e', fields: { No: 'SO9' } });
    expect(await deleteSalesOrder('o1')).toEqual({ ok: true });
    expect(mocks.findBcOrderByMarker.mock.calls[0][1]).toBe('NX-o1');
    expect(mocks.deleteSalesOrderInBc.mock.calls[0][1]).toMatchObject({ id: 'o1', bc_order_number: 'SO9' });
    expect(db.tables.sales_orders).toEqual([]);
  });

  it('with only a create marker and no BC order, deletes locally without a BC delete', async () => {
    setup({ sales_orders: [orderRow('o1', { bc_create_marker: 'NX-o1' })] });
    mocks.findBcOrderByMarker.mockResolvedValue(null);
    expect(await deleteSalesOrder('o1')).toEqual({ ok: true });
    expect(mocks.deleteSalesOrderInBc).not.toHaveBeenCalled();
    expect(db.tables.sales_orders).toEqual([]);
  });

  it('keeps the order as failed when the marker lookup fails', async () => {
    setup({ sales_orders: [orderRow('o1', { bc_create_marker: 'NX-o1' })] });
    mocks.findBcOrderByMarker.mockRejectedValue(new Error('BC is down'));
    expect(await deleteSalesOrder('o1')).toEqual({ ok: false, error: 'BC is down' });
    expect(db.tables.sales_orders[0]).toMatchObject({ sync_state: 'failed', sync_error: 'BC is down', claimed_until: null });
    expect(mocks.deleteSalesOrderInBc).not.toHaveBeenCalled();
  });

  it('keeps the order as failed when the BC delete fails', async () => {
    setup({ sales_orders: [orderRow('o1', { bc_order_number: 'SO1' })] });
    mocks.deleteSalesOrderInBc.mockRejectedValue(new Error('Order is released'));
    expect(await deleteSalesOrder('o1')).toEqual({ ok: false, error: 'Order is released' });
    expect(db.tables.sales_orders[0]).toMatchObject({ sync_state: 'failed', sync_error: 'Order is released', claimed_until: null });
  });
});

describe('retry and overwrite', () => {
  it('retry syncs under a claim and releases it', async () => {
    setup({ sales_orders: [orderRow('o1', { sync_state: 'failed' })] });
    expect(await retrySalesOrderSync('o1')).toEqual({ ok: true, state: 'synced' });
    expect(mocks.syncSalesOrder.mock.calls[0].slice(1)).toEqual(['o1', {}]);
    expect(db.tables.sales_orders[0].claimed_until).toBeNull();
  });

  it('overwrite syncs with overwrite: true', async () => {
    setup({ sales_orders: [orderRow('o1', { sync_state: 'conflict' })] });
    expect(await overwriteBcWithNexus('o1')).toEqual({ ok: true, state: 'synced' });
    expect(mocks.syncSalesOrder.mock.calls[0].slice(1)).toEqual(['o1', { overwrite: true }]);
  });

  it('retry refuses while claimed', async () => {
    setup({ sales_orders: [orderRow('o1', { claimed_until: '2999-01-01T00:00:00.000Z' })] });
    expect(await retrySalesOrderSync('o1')).toEqual({ ok: false, error: BUSY });
    expect(mocks.syncSalesOrder).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('listSalesOrders returns rows and schedules a sweep', async () => {
    setup({ sales_orders: [orderRow('o1', { sync_state: 'pending' }), orderRow('o2', { organization_id: 'org-2' })] });
    const rows = await listSalesOrders();
    expect(rows.map((r) => r.id)).toEqual(['o1']);
    expect(rows[0]).toMatchObject({ customer_name: 'Acme', sync_state: 'pending' });
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await runAfter();
    expect(mocks.syncSalesOrder.mock.calls.map((c) => c[1])).toEqual(['o1']);
  });

  it('getSalesOrder still loads an order whose customer is now blocked', async () => {
    setup({
      sales_orders: [orderRow('o1', { customer_id: 'cb' })],
      business_central_customers: [{ id: 'cb', organization_id: 'org-1', bc_connection_id: 'conn-1', blocked: 'All' }],
    });
    expect((await getSalesOrder('o1'))?.order.id).toBe('o1');
  });

  it('getSalesOrder returns the order and its non-removed lines', async () => {
    setup({ sales_orders: [orderRow('o1')], sales_order_lines: [lineRow('l1'), lineRow('l2', { removed: true })] });
    const res = await getSalesOrder('o1');
    expect(res?.order.id).toBe('o1');
    expect(res?.lines.map((l) => l.id)).toEqual(['l1']);
  });

  it('getSalesOrderFormContext returns customers, non-blocked items, selects and the most-used location', async () => {
    setup({
      business_central_customers: [
        { id: 'c1', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_customer_number: 'C1', display_name: 'A', location_code: 'MAIN' },
        { id: 'c2', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_customer_number: 'C2', display_name: 'B', location_code: 'MAIN' },
        { id: 'c3', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_customer_number: 'C3', display_name: 'C', location_code: 'EAST' },
        { id: 'c4', organization_id: 'org-2', bc_connection_id: 'conn-1', bc_customer_number: 'C4', display_name: 'D', location_code: 'EAST' },
        { id: 'c5', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_customer_number: 'C5', display_name: 'E', location_code: 'EAST', blocked: 'All' },
        { id: 'c6', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_customer_number: 'C6', display_name: 'F', location_code: 'EAST', blocked: 'Ship' },
      ],
      business_central_items: [
        { id: 'i1', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_item_number: '1000', display_name: 'Box', unit_price: 2, base_unit_of_measure_code: 'EA', blocked: false },
        { id: 'i2', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_item_number: '2000', display_name: 'Old', unit_price: 1, base_unit_of_measure_code: 'EA', blocked: true },
      ],
    });
    mocks.getSelectOptions.mockImplementation(async (k: string) => [{ code: k, label: k }]);
    const ctx = await getSalesOrderFormContext();
    expect(ctx.customers.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(ctx.items).toEqual([{ bc_item_number: '1000', display_name: 'Box', unit_price: 2, base_unit_of_measure_code: 'EA' }]);
    expect(Object.keys(ctx.selectOptions).sort()).toEqual(
      ['customerPostingGroups', 'generalBusinessPostingGroups', 'paymentTerms', 'shipmentMethods', 'taxAreas'],
    );
    expect(ctx.companyLocation).toBe('MAIN');
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
