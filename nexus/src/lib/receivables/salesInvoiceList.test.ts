import { describe, expect, it } from 'vitest';
import { fakeSupabase, type Row } from '@/test/fakeSupabase';
import { parseSalesInvoiceListParams, querySalesInvoiceList, salesInvoiceListSearch, SALES_INVOICE_PAGE_SIZE } from './salesInvoiceList';

const row = (n: number, extra: Row = {}): Row => ({
  id: `row-${n}`, organization_id: 'org-1', bc_connection_id: 'conn-1', bc_invoice_id: `inv-${n}`,
  bc_invoice_number: `PS-INV${String(n).padStart(5, '0')}`, external_document_number: `W-${n}`, customer_name: 'Zaha Mart',
  posting_date: `2026-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`, status: 'Open',
  search_text: `PS-INV${String(n).padStart(5, '0')} Zaha Mart W-${n}`,
  billcom_group: 'unmatched', billcom_owed_due_date: null, billcom_match: null, billcom_status: null, billcom_due_amount: null, billcom_due_date: null,
  ...extra,
});
const base = parseSalesInvoiceListParams({});
const run = (rows: Row[], params = {}, today = '2026-11-20') =>
  querySalesInvoiceList(fakeSupabase({ sales_invoice_list: rows }).client, 'org-1', 'conn-1', { ...base, ...params }, today, true);

describe('parseSalesInvoiceListParams', () => {
  it('defaults: no search, all filters, page 1', () => {
    expect(base).toEqual({ search: '', status: 'all', billcom: 'all', from: '', to: '', page: 1 });
  });
  it('reads the URL values and ignores junk', () => {
    expect(parseSalesInvoiceListParams({ q: [' W-1 ', 'x'], status: 'Paid', billcom: 'pastdue', from: '2026-01-01', to: 'nope', page: '3' }))
      .toEqual({ search: 'W-1', status: 'Paid', billcom: 'pastdue', from: '2026-01-01', to: '', page: 3 });
    expect(parseSalesInvoiceListParams({ status: 'Hacked', billcom: 'x', page: '-2' })).toMatchObject({ status: 'all', billcom: 'all', page: 1 });
  });
});

describe('salesInvoiceListSearch', () => {
  it('writes only non-default values, so the plain list has a clean address', () => {
    expect(salesInvoiceListSearch(base)).toBe('');
    expect(salesInvoiceListSearch({ ...base, search: 'W 1', billcom: 'paid', page: 2 })).toBe('?q=W+1&billcom=paid&page=2');
  });
});

describe('querySalesInvoiceList', () => {
  const many = Array.from({ length: 150 }, (_, i) => row(i + 1));

  it('returns 100 at a time, newest first, with the total count', async () => {
    const r = await run(many);
    expect(r.error).toBeNull();
    expect(r.total).toBe(150);
    expect(r.invoices).toHaveLength(SALES_INVOICE_PAGE_SIZE);
    const dates = r.invoices.map((i) => i.posting_date as string);
    expect([...dates].sort().reverse()).toEqual(dates);
    const page2 = await run(many, { page: 2 });
    expect(page2.invoices).toHaveLength(50);
    expect(new Set([...r.invoices, ...page2.invoices].map((i) => i.id)).size).toBe(150);
  });

  it('only this environment', async () => {
    const r = await run([row(1), row(2, { bc_connection_id: 'conn-2' }), row(3, { organization_id: 'org-2' })]);
    expect(r.invoices.map((i) => i.id)).toEqual(['row-1']);
  });

  it('searches invoice no., customer and External Doc. No. across every invoice, ignoring case', async () => {
    const rows = [...many, row(999, { customer_name: 'Aloha Fundraisers', search_text: 'PS-INV00999 Aloha Fundraisers W-999', posting_date: '2001-01-01' })];
    expect((await run(rows, { search: 'aloha' })).invoices.map((i) => i.id)).toEqual(['row-999']);
    expect((await run(rows, { search: 'w-999' })).total).toBe(1);
    expect((await run(rows, { search: '50%' })).total).toBe(0); // % is a literal, not a wildcard
  });

  it('filters by BC status and posting dates', async () => {
    const rows = [row(1, { status: 'Paid', posting_date: '2026-03-01' }), row(2, { posting_date: '2026-03-05' }), row(3, { posting_date: '2026-04-01' })];
    expect((await run(rows, { status: 'Paid' })).invoices.map((i) => i.id)).toEqual(['row-1']);
    expect((await run(rows, { from: '2026-03-02', to: '2026-03-31' })).invoices.map((i) => i.id)).toEqual(['row-2']);
  });

  it('filters by Bill.com status: paid, past due (owed after the due date), open, not matched', async () => {
    const rows = [
      row(1, { billcom_group: 'paid' }),
      row(2, { billcom_group: 'owed', billcom_owed_due_date: '2026-11-19' }), // past due
      row(3, { billcom_group: 'owed', billcom_owed_due_date: '2026-11-20' }), // due today: open
      row(4, { billcom_group: 'open' }),
      row(5),
    ];
    const ids = async (billcom: string) => (await run(rows, { billcom })).invoices.map((i) => i.id).sort();
    expect(await ids('paid')).toEqual(['row-1']);
    expect(await ids('pastdue')).toEqual(['row-2']);
    expect(await ids('open')).toEqual(['row-3', 'row-4']);
    expect(await ids('unmatched')).toEqual(['row-5']);
  });

  it('ignores the Bill.com filter when the environment has no Bill.com', async () => {
    const r = await querySalesInvoiceList(fakeSupabase({ sales_invoice_list: [row(1, { billcom_group: 'paid' }), row(2)] }).client, 'org-1', 'conn-1', { ...base, billcom: 'paid' }, '2026-11-20', false);
    expect(r.total).toBe(2);
  });

  it('a database error comes back as a message, never a crash', async () => {
    const db = fakeSupabase({ sales_invoice_list: [row(1)] });
    db.failOn = () => 'boom';
    const r = await querySalesInvoiceList(db.client, 'org-1', 'conn-1', base, '2026-11-20', true);
    expect(r).toEqual({ invoices: [], total: 0, error: 'boom' });
  });
});
