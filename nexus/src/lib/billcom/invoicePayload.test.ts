import { describe, expect, it } from 'vitest';

import { buildBillcomInvoice, type InvoiceSourceLine } from './invoicePayload';
import type { PostedInvoice } from '@/lib/salesOrders/bcInvoicing';

const line = (over: Partial<InvoiceSourceLine> = {}): InvoiceSourceLine => ({
  item_number: 'ITEM1',
  description: 'Widget',
  quantity: 10,
  unit_price: 12.5,
  bc_unit_price: null,
  discount_percent: 10,
  bc_line_discount_percent: null,
  ...over,
});

const posted = (over: Partial<PostedInvoice> = {}): PostedInvoice => ({
  id: 'bc-1',
  number: 'INV-1',
  invoiceDate: '2026-11-15',
  dueDate: '2026-12-15',
  totalExclTax: 112.5,
  totalTax: 5,
  totalInclTax: 117.5,
  ...over,
});

const build = (over: Partial<Parameters<typeof buildBillcomInvoice>[0]> = {}) =>
  buildBillcomInvoice({
    billcomCustomerId: '0cu1',
    invoiceNumber: 'W-1 / PO-9',
    posted: posted(),
    lines: [line()],
    ...over,
  });

function payloadOf(r: ReturnType<typeof build>) {
  if (!r.ok) throw new Error(r.error);
  return r.payload as {
    customer: { id: string };
    invoiceNumber: string;
    invoiceDate: string;
    dueDate?: string;
    processingOptions: { sendEmail: boolean };
    invoiceLineItems: Array<{ description: string; quantity: number; price: number }>;
  };
}

describe('buildBillcomInvoice', () => {
  it('uses the price after discount (10 x 12.50 at 10% -> qty 10 @ 11.25)', () => {
    const p = payloadOf(build());
    expect(p.invoiceLineItems[0]).toEqual({ description: 'ITEM1 Widget', quantity: 10, price: 11.25 });
  });

  it('falls back to one line at the amount when qty x rounded unit is off by a cent', () => {
    const r = build({
      lines: [line({ quantity: 3, unit_price: 1.15, discount_percent: 5 })],
      posted: posted({ totalExclTax: 3.28, totalTax: 0, totalInclTax: 3.28 }),
    });
    const p = payloadOf(r);
    expect(p.invoiceLineItems).toEqual([{ description: 'ITEM1 Widget (Qty 3 @ $1.0925)', quantity: 1, price: 3.28 }]);
  });

  it('adds a non-taxable Sales tax line at the posted tax, with no salesTaxItemId', () => {
    const p = payloadOf(build());
    expect(p.invoiceLineItems[1]).toEqual({ description: 'Sales tax', quantity: 1, price: 5 });
    expect(JSON.stringify(p)).not.toContain('salesTaxItemId');
  });

  it('adds no tax line when tax is zero', () => {
    const p = payloadOf(build({ posted: posted({ totalTax: 0, totalInclTax: 112.5 }) }));
    expect(p.invoiceLineItems).toHaveLength(1);
  });

  it('sets customer, number, sendEmail false and dates from posted; sends no PO', () => {
    const p = payloadOf(build());
    expect(p.customer).toEqual({ id: '0cu1' });
    expect(p.invoiceNumber).toBe('W-1 / PO-9');
    expect(p.processingOptions).toEqual({ sendEmail: false });
    expect(p.invoiceDate).toBe('2026-11-15');
    expect(p.dueDate).toBe('2026-12-15');
    expect(Object.keys(p).sort()).toEqual(
      ['customer', 'dueDate', 'invoiceDate', 'invoiceLineItems', 'invoiceNumber', 'processingOptions'],
    );
    expect(p.invoiceLineItems.some((i) => /po/i.test(i.description))).toBe(false);
  });

  it('omits dueDate when posted has none', () => {
    const p = payloadOf(build({ posted: posted({ dueDate: null }) }));
    expect('dueDate' in p).toBe(false);
  });

  it('trims the line description when the item number is empty', () => {
    const p = payloadOf(build({ lines: [line({ item_number: '' })] }));
    expect(p.invoiceLineItems[0].description).toBe('Widget');
  });

  it('returns ok:false with the exact message when totals differ', () => {
    const r = build({ posted: posted({ totalInclTax: 120 }) });
    expect(r).toEqual({ ok: false, error: "Bill.com total $117.50 doesn't match BC's posted total $120.00." });
  });

  it('is ok when totals match at the cent level', () => {
    expect(build({ posted: posted({ totalInclTax: 117.5 }) }).ok).toBe(true);
  });
});
