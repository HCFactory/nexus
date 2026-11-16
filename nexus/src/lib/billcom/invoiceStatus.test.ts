import { describe, expect, it, vi } from 'vitest';

import type { BillcomClient } from './client';
import { billcomStatusLabel, readBillcomInvoiceStatus } from './invoiceStatus';

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
    expect(found?.id).toBe('b');
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
    expect((await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1', 'INV-9'] }))?.id).toBe('by-ext');
  });

  it('follows nextPage', async () => {
    const { client, request } = fakeClient((path) =>
      path.includes('page=p2') ? { results: [{ ...RAW, id: 'z', invoiceNumber: 'W-1' }] } : { results: [], nextPage: 'p2' },
    );
    expect((await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1'] }))?.id).toBe('z');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns null with no id and no customer, and when nothing matches', async () => {
    const { client, request } = fakeClient(() => ({ results: [{ ...RAW, invoiceNumber: 'OTHER' }] }));
    expect(await readBillcomInvoiceStatus(client, { invoiceNumbers: ['W-1'] })).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(await readBillcomInvoiceStatus(client, { billcomCustomerId: '0cu1', invoiceNumbers: ['W-1', '', '  '] })).toBeNull();
  });
});
