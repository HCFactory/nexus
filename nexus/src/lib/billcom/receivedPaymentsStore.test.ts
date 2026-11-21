import { describe, expect, it } from 'vitest';
import { fakeSupabase } from '@/test/fakeSupabase';

import { toStoredPayment, type BillcomReceivedPayment } from './receivedPayments';
import { saveReceivedPayments } from './receivedPaymentsStore';

const pay = (invoices: [string, number][], over: Partial<BillcomReceivedPayment> = {}): BillcomReceivedPayment => ({
  id: 'rp-1', amount: invoices.reduce((s, [, a]) => s + a, 0), status: 'PAID', receivablesType: 'CHECK',
  invoicePayments: invoices.map(([invoiceId, amount]) => ({ invoiceId, amount, paymentDate: '2026-11-12', status: 'PAID' })),
  updatedTime: '2026-11-12T21:00:00Z', ...over,
});

describe('saveReceivedPayments', () => {
  it('stores each payment once per connection and the invoices it paid', async () => {
    const db = fakeSupabase();
    await saveReceivedPayments(db.client, 'org-1', 'bcom-1', [toStoredPayment(pay([['bi-1', 100], ['bi-2', 50]]))]);
    expect(db.tables.billcom_received_payments).toHaveLength(1);
    expect(db.tables.billcom_received_payments[0]).toMatchObject({ organization_id: 'org-1', billcom_connection_id: 'bcom-1', billcom_payment_id: 'rp-1', amount: 150 });
    const apps = db.tables.billcom_received_payment_invoices;
    expect(apps.map((a) => [a.billcom_invoice_id, a.amount, a.payment_id])).toEqual([['bi-1', 100, db.tables.billcom_received_payments[0].id], ['bi-2', 50, db.tables.billcom_received_payments[0].id]]);
  });

  it('a payment synced again replaces its invoice list (none left behind) and updates its details', async () => {
    const db = fakeSupabase();
    await saveReceivedPayments(db.client, 'org-1', 'bcom-1', [toStoredPayment(pay([['bi-1', 100], ['bi-2', 50]]))]);
    await saveReceivedPayments(db.client, 'org-1', 'bcom-1', [toStoredPayment(pay([['bi-3', 150]], { status: 'CANCELED' }))]);
    expect(db.tables.billcom_received_payments).toHaveLength(1);
    expect(db.tables.billcom_received_payments[0].status).toBe('CANCELED');
    expect(db.tables.billcom_received_payment_invoices.map((a) => a.billcom_invoice_id)).toEqual(['bi-3']);
  });

  it('a database error is thrown with a clear message', async () => {
    const db = fakeSupabase();
    db.failOn = (t) => (t === 'billcom_received_payments' ? 'down' : null);
    await expect(saveReceivedPayments(db.client, 'org-1', 'bcom-1', [toStoredPayment(pay([['bi-1', 1]]))])).rejects.toThrow('Could not save Bill.com payments: down');
  });
});
