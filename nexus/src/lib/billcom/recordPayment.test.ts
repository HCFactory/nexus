import { describe, expect, it, vi } from 'vitest';

import type { BillcomClient } from './client';
import { BillcomApiError } from './errors';
import { recordBillcomCardPayment } from './recordPayment';

function fakeClient(handler: (path: string, init?: RequestInit) => unknown) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init));
  return { client: { request } as unknown as BillcomClient, request };
}

const input = {
  billcomInvoiceId: 'inv1',
  customerId: 'cu1',
  amount: 12.34,
  paymentDate: '2026-11-17',
  description: 'Stripe pi_123',
};

describe('recordBillcomCardPayment', () => {
  it('posts to /v3/invoices/record-payment with CREDIT_CARD', async () => {
    const { client, request } = fakeClient(() => ({ id: '0rp1' }));
    await recordBillcomCardPayment(client, input);
    const [path, init] = request.mock.calls[0];
    expect(path).toBe('/v3/invoices/record-payment');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      amount: 12.34,
      customerId: 'cu1',
      paymentDate: '2026-11-17',
      paymentType: 'CREDIT_CARD',
      description: 'Stripe pi_123',
      invoices: [{ id: 'inv1', amount: 12.34 }],
    });
  });

  it('rounds the amount to 2 decimals', async () => {
    const { client, request } = fakeClient(() => ({}));
    await recordBillcomCardPayment(client, { ...input, amount: 10.005 + 0.1 });
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body.invoices[0].amount).toBe(10.11);
    expect(body.amount).toBe(10.11);
  });

  it('returns the payment id', async () => {
    expect(await recordBillcomCardPayment(fakeClient(() => ({ id: '0rp1' })).client, input)).toEqual({ paymentId: '0rp1' });
    expect(await recordBillcomCardPayment(fakeClient(() => ({})).client, input)).toEqual({ paymentId: null });
  });

  it('propagates Bill.com errors', async () => {
    const err = new BillcomApiError({ status: 422, statusText: 'Unprocessable', code: 'BDC_X', message: 'nope', url: '/v3/invoices/record-payment' });
    const { client } = fakeClient(() => { throw err; });
    await expect(recordBillcomCardPayment(client, input)).rejects.toBe(err);
  });
});
