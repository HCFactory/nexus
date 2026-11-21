import { describe, expect, it, vi } from 'vitest';

import type { BillcomClient } from './client';
import { billcomStatusLabel, findConnectorInvoice, readBillcomInvoiceStatus } from './invoiceStatus';

function fakeClient(handler: (path: string) => unknown) {
  const request = vi.fn(async (path: string) => handler(path));
  return { client: { request } as unknown as BillcomClient, request };
}

const RAW = {
  id: '00eX',
  invoiceNumber: 'W-100532',
  dueDate: '2026-12-15',
  customerId: '0cu1',
  totalAmount: 45.23,
  dueAmount: 45.23,
  status: 'OPEN',
};

describe('billcomStatusLabel', () => {
  it('maps OPEN, PARTIALLY_PAID, PAID_IN_FULL, VOID and title-cases others', () => {
    expect(billcomStatusLabel('OPEN')).toBe('Open');
    expect(billcomStatusLabel('PARTIALLY_PAID')).toBe('Partially paid');
    expect(billcomStatusLabel('PAID_IN_FULL')).toBe('Paid');
    expect(billcomStatusLabel('VOID')).toBe('Void');
    expect(billcomStatusLabel('SCHEDULED')).toBe('Scheduled');
    expect(billcomStatusLabel('SOME_NEW_STATE')).toBe('Some new state');
  });
});

describe('readBillcomInvoiceStatus', () => {
  it('reads by id when billcomInvoiceId is given', async () => {
    const { client, request } = fakeClient(() => RAW);
    expect(await readBillcomInvoiceStatus(client, { billcomInvoiceId: '00eX', billcomCustomerId: '0cu1', invoiceNumbers: ['W-100532'] })).toEqual({
      id: '00eX',
      invoiceNumber: 'W-100532',
      status: 'OPEN',
      statusLabel: 'Open',
      totalAmount: 45.23,
      dueAmount: 45.23,
      dueDate: '2026-12-15',
      customerId: '0cu1',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/v3/invoices/00eX');
  });

  it('looks up by Invoice # first, then BC Invoice No., exact match only', async () => {
    const { client, request } = fakeClient(() => ({
      results: [
        { ...RAW, id: 'a', invoiceNumber: 'W-1 / PO' },
        { ...RAW, id: 'b', invoiceNumber: 'INV-9' },
      ],
    }));
    const found = await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1', 'INV-9'] });
    expect(found).toMatchObject({ id: 'b' });
    const url = new URL(`http://x${request.mock.calls[0][0]}`);
    expect(url.pathname).toBe('/v3/invoices');
    expect(url.searchParams.get('filters')).toBe('customerId:eq:0cu1');
  });

  it('prefers the Invoice # match over a BC Invoice No. match', async () => {
    const { client } = fakeClient(() => ({
      results: [
        { ...RAW, id: 'by-bc', invoiceNumber: 'INV-9' },
        { ...RAW, id: 'by-ext', invoiceNumber: 'W-1' },
      ],
    }));
    expect(await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1', 'INV-9'] })).toMatchObject({ id: 'by-ext' });
  });

  it('two invoices share the Invoice #: the BC Invoice No. match wins', async () => {
    const { client } = fakeClient(() => ({
      results: [
        { ...RAW, id: 'ship-1', invoiceNumber: 'W-1' },
        { ...RAW, id: 'ship-2', invoiceNumber: 'W-1' },
        { ...RAW, id: 'by-bc', invoiceNumber: 'INV-9' },
      ],
    }));
    expect(await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1', 'INV-9'] })).toMatchObject({ id: 'by-bc' });
  });

  it("two invoices share the Invoice # and none has the BC Invoice No.: 'ambiguous', never a guess", async () => {
    const { client } = fakeClient(() => ({
      results: [
        { ...RAW, id: 'ship-1', invoiceNumber: 'W-1' },
        { ...RAW, id: 'ship-2', invoiceNumber: 'W-1' },
      ],
    }));
    expect(await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1', 'INV-9'] })).toBe('ambiguous');
  });

  it('a unique Invoice # match on page 1 still checks later pages for a duplicate', async () => {
    const { client, request } = fakeClient((path) =>
      path.includes('page=p2')
        ? { results: [{ ...RAW, id: 'ship-2', invoiceNumber: 'W-1' }] }
        : { results: [{ ...RAW, id: 'ship-1', invoiceNumber: 'W-1' }], nextPage: 'p2' },
    );
    expect(await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1'] })).toBe('ambiguous');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('follows nextPage', async () => {
    const { client, request } = fakeClient((path) =>
      path.includes('page=p2') ? { results: [{ ...RAW, id: 'z', invoiceNumber: 'W-1' }] } : { results: [], nextPage: 'p2' },
    );
    expect(await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1'] })).toMatchObject({ id: 'z' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns null with no id and no customer, and when nothing matches', async () => {
    const { client, request } = fakeClient(() => ({ results: [{ ...RAW, invoiceNumber: 'OTHER' }] }));
    expect(await readBillcomInvoiceStatus(client, { invoiceNumbers: ['W-1'] })).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1', '', '  '] })).toBeNull();
  });
});

describe('findConnectorInvoice (Bill.com invoices copied by its BC connector)', () => {
  const expectBc = { bcTotal: 45.23, customerName: 'Aloha School, Inc.' };
  const handler = (byNumber: Record<string, unknown[]>, customerName = 'ALOHA SCHOOL INC') => (path: string) => {
    if (path.startsWith('/v3/customers/')) return { id: '0cu1', name: customerName };
    const filters = new URL(`https://x${path}`).searchParams.get('filters') ?? '';
    const key = filters.replace('invoiceNumber:eq:', '');
    return { results: ((byNumber[key] ?? []) as Record<string, unknown>[]).map((r) => ({ ...r, invoiceNumber: key })) };
  };

  it('finds the invoice directly by its number (External Doc. No.) when total and customer name agree', async () => {
    const { client, request } = fakeClient(handler({ 'W-115661/ PO#002043': [{ ...RAW, invoiceNumber: 'W-115661/ PO#002043' }] }));
    const r = await findConnectorInvoice(client, { invoiceNumbers: ['W-115661/ PO#002043', 'INV-1'], ...expectBc });
    expect(r).toMatchObject({ kind: 'found', status: { id: '00eX', customerId: '0cu1', dueAmount: 45.23 } });
    expect(request.mock.calls[0][0]).toBe(`/v3/invoices?${new URLSearchParams({ filters: 'invoiceNumber:eq:W-115661/ PO#002043', max: '5' })}`);
  });

  it('falls back to the BC invoice number', async () => {
    const { client } = fakeClient(handler({ 'INV-1': [RAW] }));
    expect((await findConnectorInvoice(client, { invoiceNumbers: ['W-1', 'INV-1'], ...expectBc })).kind).toBe('found');
  });

  it('a different total is a mismatch (never charged)', async () => {
    const { client } = fakeClient(handler({ 'W-1': [{ ...RAW, totalAmount: 45.24 }] }));
    expect(await findConnectorInvoice(client, { invoiceNumbers: ['W-1'], ...expectBc })).toEqual({ kind: 'mismatch' });
  });

  it('a different customer name is a mismatch', async () => {
    const { client } = fakeClient(handler({ 'W-1': [RAW] }, 'Someone Else LLC'));
    expect(await findConnectorInvoice(client, { invoiceNumbers: ['W-1'], ...expectBc })).toEqual({ kind: 'mismatch' });
  });

  it('several invoices with the number are ambiguous; none is not found', async () => {
    const amb = fakeClient(handler({ 'W-1': [RAW, { ...RAW, id: '00eY' }] }));
    expect(await findConnectorInvoice(amb.client, { invoiceNumbers: ['W-1'], ...expectBc })).toEqual({ kind: 'ambiguous' });
    const none = fakeClient(handler({}));
    expect(await findConnectorInvoice(none.client, { invoiceNumbers: ['W-1', ''], ...expectBc })).toEqual({ kind: 'not_found' });
  });

  it('a twin that differs only in letter case counts as a second invoice with the number (ambiguous)', async () => {
    const { client } = fakeClient((path: string) => {
      if (path.startsWith('/v3/customers/')) return { id: '0cu1', name: 'Aloha School, Inc.' };
      return { results: [{ ...RAW, invoiceNumber: 'W-1' }, { ...RAW, id: '00eY', invoiceNumber: 'w-1' }] };
    });
    expect(await findConnectorInvoice(client, { invoiceNumbers: ['W-1'], ...expectBc })).toEqual({ kind: 'ambiguous' });
  });

  it('accents do not make the same customer name a mismatch', async () => {
    const { client } = fakeClient(handler({ 'W-1': [RAW] }, 'Café Aloha'));
    expect((await findConnectorInvoice(client, { invoiceNumbers: ['W-1'], bcTotal: 45.23, customerName: 'Cafe Aloha' })).kind).toBe('found');
  });

  it('without a BC total or customer name it refuses to call it a match', async () => {
    const { client } = fakeClient(handler({ 'W-1': [RAW] }));
    expect(await findConnectorInvoice(client, { invoiceNumbers: ['W-1'], bcTotal: null, customerName: 'Aloha School, Inc.' })).toEqual({ kind: 'mismatch' });
    expect(await findConnectorInvoice(client, { invoiceNumbers: ['W-1'], bcTotal: 45.23, customerName: '' })).toEqual({ kind: 'mismatch' });
  });
});
