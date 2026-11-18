import { describe, expect, it, vi } from 'vitest';

import type { BillcomClient } from './client';
import { BillcomApiError } from './errors';
import { billcomInvoiceMismatch, BillcomDuplicateInvoiceError, createBillcomInvoice, findBillcomInvoice, findOrCreateBillcomInvoice, replaceBillcomInvoice } from './invoicePush';

function fakeClient(handler: (path: string, init?: RequestInit) => unknown) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init));
  return { client: { request } as unknown as BillcomClient, request };
}

describe('findBillcomInvoice', () => {
  it('returns the exact invoiceNumber match with its total and line count', async () => {
    const { client, request } = fakeClient(() => ({
      results: [
        { id: 'a', invoiceNumber: 'W-1 / PO' },
        { id: 'b', invoiceNumber: 'W-1', totalAmount: 45.23, invoiceLineItems: [{}, {}] },
      ],
    }));
    expect(await findBillcomInvoice(client, '0cu1', 'W-1')).toEqual({ id: 'b', totalAmount: 45.23, lineCount: 2 });
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
    expect((await findBillcomInvoice(client, '0cu1', 'W-1'))?.id).toBe('z');
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('billcomInvoiceMismatch', () => {
  const payload = {
    invoiceNumber: 'W-1',
    invoiceLineItems: [
      { quantity: 10, price: 4.5 },
      { quantity: 1, price: 0.23 },
    ],
  };

  it('accepts the same total and number of lines', () => {
    expect(billcomInvoiceMismatch({ id: 'x', totalAmount: 45.23, lineCount: 2 }, payload)).toBeNull();
  });

  it('rejects a missing line', () => {
    expect(billcomInvoiceMismatch({ id: 'x', totalAmount: 45, lineCount: 1 }, payload)).toBe(
      "Bill.com invoice W-1 doesn't match: it has $45.00 in 1 line, expected $45.23 in 2 lines. Fix or delete it in Bill.com, then Retry.",
    );
  });

  it('rejects a different total with the same lines', () => {
    expect(billcomInvoiceMismatch({ id: 'x', totalAmount: 45.24, lineCount: 2 }, payload)).not.toBeNull();
  });

  it('rejects an invoice whose total or lines Bill.com did not return', () => {
    expect(billcomInvoiceMismatch({ id: 'x', totalAmount: null, lineCount: 2 }, payload)).toContain('an unknown total');
    expect(billcomInvoiceMismatch({ id: 'x', totalAmount: 45.23, lineCount: null }, payload)).toContain('unknown lines');
  });
});

describe('createBillcomInvoice', () => {
  it('POSTs /v3/invoices and returns what Bill.com saved', async () => {
    const { client, request } = fakeClient(() => ({ id: '00eNEW', totalAmount: 2.74, invoiceLineItems: [{}, {}] }));
    expect(await createBillcomInvoice(client, { invoiceNumber: 'W-1' })).toEqual({ id: '00eNEW', totalAmount: 2.74, lineCount: 2 });
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

describe('replaceBillcomInvoice', () => {
  it('PUTs the full invoice (without processingOptions) to /v3/invoices/<id> and returns what Bill.com saved', async () => {
    const { client, request } = fakeClient(() => ({ id: '00eX', totalAmount: 8.5, invoiceLineItems: [{}, {}] }));
    const payload = { customer: { id: '0cu1' }, invoiceNumber: 'W-1', processingOptions: { sendEmail: false }, invoiceLineItems: [] };
    expect(await replaceBillcomInvoice(client, '00eX', payload)).toEqual({ id: '00eX', totalAmount: 8.5, lineCount: 2 });
    const [path, init] = request.mock.calls[0];
    expect(path).toBe('/v3/invoices/00eX');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ customer: { id: '0cu1' }, invoiceNumber: 'W-1', invoiceLineItems: [] });
  });
});

describe('findOrCreateBillcomInvoice', () => {
  const payload = { invoiceNumber: 'W-1' };
  const dup = () =>
    new BillcomApiError({ status: 422, statusText: 'x', code: 'BDC_1171', message: 'Duplicate invoice number', url: '/v3/invoices' });

  it('returns a found invoice without creating', async () => {
    const { client, request } = fakeClient(() => ({ results: [{ id: 'found', invoiceNumber: 'W-1', totalAmount: 1, invoiceLineItems: [{}] }] }));
    expect(await findOrCreateBillcomInvoice(client, '0cu1', payload)).toEqual({ id: 'found', totalAmount: 1, lineCount: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('creates when none is found', async () => {
    const { client } = fakeClient((_p, init) => (init?.method === 'POST' ? { id: 'new', totalAmount: 2, invoiceLineItems: [] } : { results: [] }));
    expect(await findOrCreateBillcomInvoice(client, '0cu1', payload)).toMatchObject({ id: 'new' });
  });

  it('a duplicate answer is resolved by finding again', async () => {
    let lists = 0;
    const { client } = fakeClient((_p, init) => {
      if (init?.method === 'POST') throw dup();
      lists++;
      return { results: lists === 1 ? [] : [{ id: 'raced', invoiceNumber: 'W-1' }] };
    });
    expect(await findOrCreateBillcomInvoice(client, '0cu1', payload)).toMatchObject({ id: 'raced' });
  });

  it('a duplicate that still cannot be found is thrown', async () => {
    const { client } = fakeClient((_p, init) => {
      if (init?.method === 'POST') throw dup();
      return { results: [] };
    });
    await expect(findOrCreateBillcomInvoice(client, '0cu1', payload)).rejects.toBeInstanceOf(BillcomDuplicateInvoiceError);
  });
});
