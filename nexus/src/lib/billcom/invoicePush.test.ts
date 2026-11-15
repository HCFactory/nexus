import { describe, expect, it, vi } from 'vitest';

import type { BillcomClient } from './client';
import { BillcomApiError } from './errors';
import { BillcomDuplicateInvoiceError, createBillcomInvoice, findBillcomInvoice } from './invoicePush';

function fakeClient(handler: (path: string, init?: RequestInit) => unknown) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init));
  return { client: { request } as unknown as BillcomClient, request };
}

describe('findBillcomInvoice', () => {
  it('returns the id of the exact invoiceNumber match', async () => {
    const { client, request } = fakeClient(() => ({
      results: [
        { id: 'a', invoiceNumber: 'W-1 / PO' },
        { id: 'b', invoiceNumber: 'W-1' },
      ],
    }));
    expect(await findBillcomInvoice(client, '0cu1', 'W-1')).toBe('b');
    const url = new URL(`http://x${request.mock.calls[0][0]}`);
    expect(url.pathname).toBe('/v3/invoices');
    expect(url.searchParams.get('filters')).toBe('customerId:eq:0cu1');
    expect(url.searchParams.get('max')).toBe('100');
  });

  it('returns null when none match', async () => {
    const { client } = fakeClient(() => ({ results: [{ id: 'a', invoiceNumber: 'X' }] }));
    expect(await findBillcomInvoice(client, '0cu1', 'W-1')).toBeNull();
  });

  it('follows nextPage', async () => {
    const { client, request } = fakeClient((path) =>
      path.includes('page=p2')
        ? { results: [{ id: 'z', invoiceNumber: 'W-1' }] }
        : { results: [{ id: 'a', invoiceNumber: 'X' }], nextPage: 'p2' },
    );
    expect(await findBillcomInvoice(client, '0cu1', 'W-1')).toBe('z');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('createBillcomInvoice', () => {
  it('POSTs /v3/invoices and returns the id', async () => {
    const { client, request } = fakeClient(() => ({ id: '00eNEW' }));
    expect(await createBillcomInvoice(client, { invoiceNumber: 'W-1' })).toBe('00eNEW');
    const [path, init] = request.mock.calls[0];
    expect(path).toBe('/v3/invoices');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ invoiceNumber: 'W-1' });
  });

  it('throws BillcomDuplicateInvoiceError on 422 BDC_1171', async () => {
    const { client } = fakeClient(() => {
      throw new BillcomApiError({ status: 422, statusText: 'Unprocessable', code: 'BDC_1171', message: 'Duplicate invoice number', url: '/v3/invoices' });
    });
    await expect(createBillcomInvoice(client, {})).rejects.toBeInstanceOf(BillcomDuplicateInvoiceError);
  });

  it('propagates other Bill.com errors unchanged', async () => {
    const err = new BillcomApiError({ status: 422, statusText: 'Unprocessable', code: 'BDC_9999', message: 'nope', url: '/v3/invoices' });
    const { client } = fakeClient(() => {
      throw err;
    });
    await expect(createBillcomInvoice(client, {})).rejects.toBe(err);
  });
});
