import { describe, expect, it } from 'vitest';
import { fakeSupabase, type Row } from '@/test/fakeSupabase';

import { readPaymentDetail } from './paymentDetail';

const ORG = 'org-1';
const base = (): Record<string, Row[]> => ({
  billcom_received_payments: [
    { id: 'p-1', organization_id: ORG, billcom_connection_id: 'bcom-1', billcom_payment_id: 'rp-1', payment_date: '2026-11-12', amount: 150, unapplied_amount: 0, convenience_fee: 0,
      receivables_type: 'CHECK', online_payment: false, reference_number: '10482', status: 'PAID', deposit_bank_name: 'First Hawaiian', deposit_account_last4: '6789' },
    { id: 'p-other-env', organization_id: ORG, billcom_connection_id: 'bcom-2', billcom_payment_id: 'rp-2' },
  ],
  billcom_received_payment_invoices: [
    { organization_id: ORG, payment_id: 'p-1', billcom_connection_id: 'bcom-1', billcom_invoice_id: 'bi-1', amount: 100, payment_date: '2026-11-12', status: 'PAID' },
    { organization_id: ORG, payment_id: 'p-1', billcom_connection_id: 'bcom-1', billcom_invoice_id: 'bi-9', amount: 50, payment_date: '2026-11-12', status: 'PAID' },
  ],
  billcom_invoice_status: [{ organization_id: ORG, bc_connection_id: 'conn-1', bc_invoice_id: 'inv-1', match: 'found', billcom_invoice_id: 'bi-1' }],
  business_central_sales_invoices: [{ organization_id: ORG, bc_connection_id: 'conn-1', bc_invoice_id: 'inv-1', external_document_number: 'W-1', bc_invoice_number: 'INV-1', customer_number: 'C1', customer_name: 'Food Pantry' }],
  card_payments: [],
  users: [{ id: 'u-1', display_name: 'Fahim' }],
  customer_cards: [{ id: 'card-1', organization_id: ORG, brand: 'visa', last4: '4242' }],
});
const read = (tables = base(), billcomPaymentId = 'rp-1') =>
  readPaymentDetail(fakeSupabase(tables).client, { orgId: ORG, bcConnectionId: 'conn-1', billcomConnectionId: 'bcom-1', billcomPaymentId });

describe('readPaymentDetail', () => {
  it('the payment, how it was paid, where it was deposited, and every invoice it paid (linked when Nexus has it)', async () => {
    const d = await read();
    expect(d).toMatchObject({
      payment: { billcomPaymentId: 'rp-1', date: '2026-11-12', amount: 150, typeLabel: 'Check #10482', online: false, status: 'Paid', deposit: 'First Hawaiian ••••6789', convenienceFee: 0, unapplied: 0 },
      customer: { name: 'Food Pantry', number: 'C1' },
      charge: null,
    });
    expect(d!.invoices).toEqual([
      { billcomInvoiceId: 'bi-1', amount: 100, number: 'W-1', href: '/receivables/invoices/inv-1' },
      { billcomInvoiceId: 'bi-9', amount: 50, number: null, href: null },
    ]);
  });

  it('a card charge made in Nexus: who charged, which card, the Stripe reference', async () => {
    const t = base();
    t.card_payments = [{ id: 'cp-1', organization_id: ORG, billcom_payment_id: 'rp-1', charged_by: 'u-1', card_id: 'card-1', stripe_payment_intent_id: 'pi_123', billcom_state: 'recorded', charged_at: '2026-11-12T01:00:00Z' }];
    expect((await read(t))!.charge).toEqual({ chargedBy: 'Fahim', card: 'Visa •••• 4242', stripeReference: 'pi_123', billcomState: 'Recorded in Bill.com', chargedAt: '2026-11-12T01:00:00Z' });
  });

  it('a payment of another environment, or unknown: not found', async () => {
    expect(await read(base(), 'rp-2')).toBeNull();
    expect(await read(base(), 'nope')).toBeNull();
  });
});
