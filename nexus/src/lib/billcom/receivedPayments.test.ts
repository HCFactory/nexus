import { describe, expect, it, vi } from 'vitest';

import { BillcomRateLimitError } from './errors';
import { syncBillcomReceivedPayments, toStoredPayment, type BillcomReceivedPayment } from './receivedPayments';

const pay = (over: Partial<BillcomReceivedPayment> = {}): BillcomReceivedPayment => ({
  id: 'rp-1', customerId: 'cus-1', paymentDate: '2026-11-12', amount: 150, unappliedAmount: 0, convenienceFeeAmount: 0,
  receivablesType: 'CHECK', status: 'PAID', referenceNumber: '10482', onlinePayment: false,
  receivablesAccount: { id: 'a1', type: 'CHECKING', bankName: 'First Hawaiian', accountNumber: '000123456789' },
  invoicePayments: [
    { invoiceId: 'bi-1', amount: 100, paymentDate: '2026-11-12', status: 'PAID', receivedPaymentId: 'x1' },
    { invoiceId: 'bi-2', amount: 50, paymentDate: '2026-11-12', status: 'PAID', receivedPaymentId: 'x2' },
  ],
  createdTime: '2026-11-12T20:00:00.000+00:00', updatedTime: '2026-11-12T21:00:00.000+00:00',
  ...over,
});

describe('toStoredPayment', () => {
  it('keeps the payment details and each invoice it paid, with only the last 4 of the account number', () => {
    const { payment, applications } = toStoredPayment(pay());
    expect(payment).toEqual({
      billcom_payment_id: 'rp-1', billcom_customer_id: 'cus-1', payment_date: '2026-11-12', amount: 150, unapplied_amount: 0,
      convenience_fee: 0, receivables_type: 'CHECK', online_payment: false, reference_number: '10482', status: 'PAID',
      deposit_bank_name: 'First Hawaiian', deposit_account_last4: '6789',
      billcom_created_time: '2026-11-12T20:00:00.000+00:00', billcom_updated_time: '2026-11-12T21:00:00.000+00:00',
    });
    expect(JSON.stringify(payment)).not.toContain('000123456789');
    expect(applications).toEqual([
      { billcom_invoice_id: 'bi-1', amount: 100, payment_date: '2026-11-12', status: 'PAID', received_payment_id: 'x1' },
      { billcom_invoice_id: 'bi-2', amount: 50, payment_date: '2026-11-12', status: 'PAID', received_payment_id: 'x2' },
    ]);
  });

  it('missing pieces become nulls (no account, no invoices, amounts as text)', () => {
    const { payment, applications } = toStoredPayment(pay({ receivablesAccount: undefined, invoicePayments: undefined, amount: '12.50' as unknown as number, referenceNumber: '' }));
    expect(payment).toMatchObject({ deposit_bank_name: null, deposit_account_last4: null, amount: 12.5, reference_number: null });
    expect(applications).toEqual([]);
  });
});

const deps = (pages: { results: BillcomReceivedPayment[]; nextPage?: string }[], over: Record<string, unknown> = {}) => {
  let clock = Date.parse('2026-11-21T00:00:00Z');
  return {
    listChanged: vi.fn(async () => pages.shift() ?? { results: [] }),
    save: vi.fn(async () => undefined),
    readCheckpoint: vi.fn(async () => ({ cursor_value: null, records_synced: 0 })),
    writeCheckpoint: vi.fn(async () => undefined),
    nowMs: vi.fn(() => (clock += 10)),
    ...over,
  };
};

describe('syncBillcomReceivedPayments', () => {
  it('reads every page of changed payments, saves them and finishes with the cursor at the last update', async () => {
    const d = deps([
      { results: [pay({ id: 'a', updatedTime: '2026-10-01T00:00:00Z' })], nextPage: 'p2' },
      { results: [pay({ id: 'b', updatedTime: '2026-10-02T00:00:00Z' })] },
    ]);
    const r = await syncBillcomReceivedPayments(d, 30_000);
    expect(r).toMatchObject({ entityType: 'billcom_received_payment', recordsSynced: 2, complete: true, error: null, cursor: '2026-10-02T00:00:00Z' });
    expect(d.listChanged.mock.calls).toEqual([[null, undefined], [null, 'p2']]);
    expect(d.save).toHaveBeenCalledTimes(2);
    expect(d.writeCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ complete: true, cursor_value: '2026-10-02T00:00:00Z', records_synced: 2 }));
  });

  it('continues from the saved cursor, never later than a day ago', async () => {
    const d = deps([{ results: [pay({ updatedTime: '2026-11-20T23:00:00Z' })] }], {
      readCheckpoint: vi.fn(async () => ({ cursor_value: '2026-11-01T00:00:00Z', records_synced: 5 })),
    });
    const r = await syncBillcomReceivedPayments(d, 30_000);
    expect(d.listChanged).toHaveBeenCalledWith('2026-11-01T00:00:00Z', undefined);
    expect(Date.parse(r.cursor!)).toBeLessThanOrEqual(Date.parse('2026-11-20T00:00:01Z'));
  });

  it('stops when the time budget is used up, keeping progress for next time', async () => {
    let t = 0;
    const d = deps([{ results: [pay()], nextPage: 'p2' }, { results: [pay({ id: 'b' })] }], { nowMs: vi.fn(() => (t += 20_000)) });
    const r = await syncBillcomReceivedPayments(d, 30_000);
    expect(r.complete).toBe(false);
    expect(r.error).toBeNull();
    expect(d.listChanged).toHaveBeenCalledTimes(1);
  });

  it('Bill.com rate limit: incomplete, no error', async () => {
    const d = deps([], { listChanged: vi.fn(async () => { throw new BillcomRateLimitError({ status: 429, statusText: 'x', message: 'BDC_1144', url: 'u', code: 'BDC_1144' } as never); }) });
    const r = await syncBillcomReceivedPayments(d, 30_000);
    expect(r).toMatchObject({ complete: false, error: null });
  });

  it('any other failure comes back as a message', async () => {
    const d = deps([{ results: [pay()] }], { save: vi.fn(async () => { throw new Error('db down'); }) });
    const r = await syncBillcomReceivedPayments(d, 30_000);
    expect(r).toMatchObject({ complete: false, error: 'db down' });
  });
});
