import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase';

const mocks = vi.hoisted(() => ({
  db: null as unknown as { client: unknown },
  fetchAndMirror: vi.fn(),
  mirrorLines: vi.fn(),
  resolveBillcom: vi.fn(),
  createBillcom: vi.fn(),
  readStatus: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/currentUserAccess', () => ({
  requirePermission: vi.fn().mockResolvedValue({ orgId: 'org-1', user: { id: 'u1' } }),
}));
vi.mock('@/lib/businessCentral/activeConnection', () => ({
  resolveActiveBcConnection: vi.fn().mockResolvedValue({ id: 'conn-1', environment: 'TEST', company_id: 'co-1' }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.db.client }));
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: vi.fn().mockResolvedValue({ listResourcePage: vi.fn() }) }));
vi.mock('@/lib/businessCentral/invoiceMirror', () => ({
  fetchAndMirrorSalesInvoice: (...a: unknown[]) => mocks.fetchAndMirror(...a),
  mirrorSalesInvoiceLines: (...a: unknown[]) => mocks.mirrorLines(...a),
}));
vi.mock('@/lib/billcom/customerSyncHooks', () => ({ resolveBillcomConnection: (...a: unknown[]) => mocks.resolveBillcom(...a) }));
vi.mock('@/lib/billcom/connection', () => ({ createBillcomClientForConnection: (...a: unknown[]) => mocks.createBillcom(...a) }));
vi.mock('@/lib/billcom/invoiceStatus', () => ({ readBillcomInvoiceStatus: (...a: unknown[]) => mocks.readStatus(...a) }));

import { getSalesInvoiceBillcomPanel, getSalesInvoicePage } from './salesInvoicePage';

const INV = '143fbb46-e8e0-f111-84e4-7ced8d88ddac';
const OTHER = '00000000-0000-0000-0000-000000000001';

const invoiceRow = (extra: Row = {}): Row => ({
  id: 'row-1',
  organization_id: 'org-1',
  bc_connection_id: 'conn-1',
  bc_invoice_id: INV,
  bc_invoice_number: 'INV-100412',
  external_document_number: 'W-100532',
  customer_number: 'C1',
  ...extra,
});
const lineRow = (id: string, sequence: number, extra: Row = {}): Row => ({
  id,
  organization_id: 'org-1',
  bc_connection_id: 'conn-1',
  bc_invoice_id: INV,
  sequence,
  ...extra,
});
const STATUS = { id: '00eX', invoiceNumber: 'W-100532', status: 'OPEN', statusLabel: 'Open', totalAmount: 45.23, dueAmount: 45.23, dueDate: null };

let db: FakeSupabase;
function setup(tables: Record<string, Row[]>) {
  db = fakeSupabase({ business_central_sales_invoices: [], business_central_sales_invoice_lines: [], sales_orders: [], billcom_customer_links: [], ...tables });
  mocks.db = db;
}

beforeEach(() => {
  mocks.fetchAndMirror.mockReset().mockResolvedValue(null);
  mocks.mirrorLines.mockReset().mockResolvedValue([]);
  mocks.resolveBillcom.mockReset().mockResolvedValue({ id: 'bcom-1', enabled: true });
  mocks.createBillcom.mockReset().mockResolvedValue({ request: vi.fn() });
  mocks.readStatus.mockReset().mockResolvedValue(STATUS);
});

describe('getSalesInvoicePage', () => {
  it('returns null for an invoice of another org or connection', async () => {
    setup({
      business_central_sales_invoices: [invoiceRow({ organization_id: 'org-2' }), invoiceRow({ id: 'row-2', bc_connection_id: 'conn-2' })],
    });
    expect(await getSalesInvoicePage(INV)).toBeNull();
  });

  it('returns null for an id that is not a GUID, without asking BC', async () => {
    setup({});
    expect(await getSalesInvoicePage("x' or 1 eq 1")).toBeNull();
    expect(mocks.fetchAndMirror).not.toHaveBeenCalled();
  });

  it('returns stored invoice and lines ordered by sequence, without BC', async () => {
    setup({
      business_central_sales_invoices: [invoiceRow()],
      business_central_sales_invoice_lines: [lineRow('l2', 20000), lineRow('l1', 10000), lineRow('x', 1, { bc_invoice_id: OTHER })],
    });
    const page = await getSalesInvoicePage(INV);
    expect(page?.invoice.bc_invoice_number).toBe('INV-100412');
    expect(page?.lines.map((l) => l.id)).toEqual(['l1', 'l2']);
    expect(mocks.fetchAndMirror).not.toHaveBeenCalled();
    expect(mocks.mirrorLines).not.toHaveBeenCalled();
  });

  it('fills a missing row and missing lines from BC once', async () => {
    setup({});
    mocks.fetchAndMirror.mockImplementation(async () => {
      db.tables.business_central_sales_invoices.push(invoiceRow());
      return invoiceRow();
    });
    mocks.mirrorLines.mockImplementation(async () => {
      db.tables.business_central_sales_invoice_lines.push(lineRow('l1', 10000));
      return [lineRow('l1', 10000)];
    });
    const page = await getSalesInvoicePage(INV);
    expect(page?.lines.map((l) => l.id)).toEqual(['l1']);
    expect(mocks.fetchAndMirror).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAndMirror.mock.calls[0][1]).toBe(INV);
    expect(mocks.mirrorLines).toHaveBeenCalledTimes(1);

    await getSalesInvoicePage(INV);
    expect(mocks.fetchAndMirror).toHaveBeenCalledTimes(1);
    expect(mocks.mirrorLines).toHaveBeenCalledTimes(1);
  });

  it('uses the rows the mirror stored, without reading them back (Next.js memoizes identical reads in one render)', async () => {
    setup({});
    // The mirror returns what it stored; the fake db is not updated, as a memoized re-read would see it.
    mocks.fetchAndMirror.mockResolvedValue(invoiceRow());
    mocks.mirrorLines.mockResolvedValue([lineRow('l2', 20000), lineRow('l1', 10000)]);
    const page = await getSalesInvoicePage(INV);
    expect(page?.invoice.bc_invoice_number).toBe('INV-100412');
    expect(page?.lines.map((l) => l.id)).toEqual(['l1', 'l2']);
  });

  it('returns null when BC has no such posted invoice either', async () => {
    setup({});
    expect(await getSalesInvoicePage(INV)).toBeNull();
    expect(mocks.fetchAndMirror).toHaveBeenCalledTimes(1);
  });

  it('a BC failure while filling missing lines keeps the page, with linesError', async () => {
    setup({ business_central_sales_invoices: [invoiceRow()] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.mirrorLines.mockRejectedValue(new Error('BC is down'));
    const page = await getSalesInvoicePage(INV);
    expect(page?.invoice.bc_invoice_number).toBe('INV-100412');
    expect(page?.lines).toEqual([]);
    expect(page?.linesError).toBe(true);
  });

  it('links the sales order that posted it', async () => {
    setup({
      business_central_sales_invoices: [invoiceRow()],
      business_central_sales_invoice_lines: [lineRow('l1', 10000)],
      sales_orders: [{ id: 'so-1', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_posted_invoice_id: INV, bc_order_number: 'W-100532' }],
    });
    expect((await getSalesInvoicePage(INV))?.salesOrder).toEqual({ id: 'so-1', bcOrderNumber: 'W-100532', billcomInvoiceId: null });
  });
});

describe('getSalesInvoiceBillcomPanel', () => {
  const link = (extra: Row = {}): Row => ({
    organization_id: 'org-1',
    bc_connection_id: 'conn-1',
    billcom_connection_id: 'bcom-1',
    bc_customer_number: 'C1',
    status: 'synced',
    billcom_customer_id: '0cu1',
    ...extra,
  });
  const input = (extra: Partial<Parameters<typeof getSalesInvoiceBillcomPanel>[0]> = {}) => ({
    customerNumber: 'C1',
    invoiceNumbers: ['W-100532', 'INV-100412'],
    billcomInvoiceId: null,
    ...extra,
  });

  it('off when Bill.com is disabled or its client cannot be created', async () => {
    setup({});
    mocks.resolveBillcom.mockResolvedValue({ id: 'bcom-1', enabled: false });
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'off' });
    mocks.resolveBillcom.mockResolvedValue({ id: 'bcom-1', enabled: true });
    mocks.createBillcom.mockRejectedValue(new Error('no creds'));
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'off' });
  });

  it('found by the order’s billcom_invoice_id', async () => {
    setup({});
    expect(await getSalesInvoiceBillcomPanel(input({ billcomInvoiceId: '00eX' }))).toEqual({ kind: 'found', status: STATUS });
    expect(mocks.readStatus.mock.calls[0][1]).toMatchObject({ billcomInvoiceId: '00eX' });
  });

  it('uses the invoice details it is given and never reads the invoice row (first open after a BC fill)', async () => {
    // No stored invoice row: a memoized re-read in the same render would see none.
    setup({ billcom_customer_links: [link()] });
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'found', status: STATUS });
  });

  it('not_linked without a ready customer link', async () => {
    setup({ billcom_customer_links: [link({ status: 'needs_attention' })] });
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'not_linked' });
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it('looks up by Invoice # then BC Invoice No. for the linked customer; not_found when none', async () => {
    setup({ billcom_customer_links: [link()] });
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'found', status: STATUS });
    expect(mocks.readStatus.mock.calls[0][1]).toEqual({ billcomCustomerId: '0cu1', invoiceNumbers: ['W-100532', 'INV-100412'] });
    mocks.readStatus.mockResolvedValue(null);
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'not_found' });
  });

  it('ambiguous when several Bill.com invoices share the number', async () => {
    setup({ billcom_customer_links: [link()] });
    mocks.readStatus.mockResolvedValue('ambiguous');
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'ambiguous' });
  });

  it('error keeps the message', async () => {
    setup({ billcom_customer_links: [link()] });
    mocks.readStatus.mockRejectedValue(new Error('Bill.com is unavailable'));
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'error', message: 'Bill.com is unavailable' });
  });

  it('any failure, even before Bill.com is called, is an error panel, never a thrown error', async () => {
    setup({});
    mocks.resolveBillcom.mockRejectedValue(new Error('db down'));
    expect(await getSalesInvoiceBillcomPanel(input())).toEqual({ kind: 'error', message: 'db down' });
  });
});
