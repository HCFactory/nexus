import { describe, expect, it } from 'vitest';
import { fakeSupabase, type Row } from '@/test/fakeSupabase';

import { getInvoicePaymentsAndActivity, paymentTypeLabel } from './invoiceActivity';

const ORG = 'org-1';
const CONN = 'conn-1';
const BCOM = 'bcom-1';
const invoice = {
  bc_invoice_id: 'inv-1', bc_invoice_number: 'INV-1', external_document_number: 'W-1', posting_date: '2026-11-01', due_date: '2026-11-15',
  total_amount_including_tax: 300, status: 'Open',
};
const status = (over: Row = {}): Row => ({
  organization_id: ORG, bc_connection_id: CONN, bc_invoice_id: 'inv-1', billcom_connection_id: BCOM, match: 'found', billcom_invoice_id: 'bi-1',
  status: 'PARTIALLY_PAID', due_amount: 100, due_date: '2026-11-15', ...over,
});
const payment = (id: string, over: Row = {}): Row => ({
  id: `p-${id}`, organization_id: ORG, billcom_connection_id: BCOM, billcom_payment_id: id, payment_date: '2026-11-10', amount: 500,
  receivables_type: 'CHECK', online_payment: false, reference_number: '10482', status: 'PAID', ...over,
});
const app = (paymentRowId: string, over: Row = {}): Row => ({
  organization_id: ORG, payment_id: paymentRowId, billcom_connection_id: BCOM, billcom_invoice_id: 'bi-1', amount: 100, payment_date: '2026-11-10', status: 'PAID', ...over,
});
const users = [{ id: 'u-1', display_name: 'Fahim' }, { id: 'u-2', display_name: 'Lani' }];
const charge = (over: Row = {}): Row => ({
  id: 'cp-1', organization_id: ORG, bc_invoice_id: 'inv-1', amount: 200, status: 'succeeded', billcom_state: 'recorded', billcom_payment_id: 'rp-card',
  card_id: 'card-1', charged_by: 'u-1', charged_at: '2026-11-20T01:00:00Z', failure_message: null, ...over,
});
const card = { id: 'card-1', organization_id: ORG, brand: 'visa', last4: '4242' };

const run = (tables: Record<string, Row[]>, today = '2026-11-21') =>
  getInvoicePaymentsAndActivity(fakeSupabase({ users, customer_cards: [card], ...tables }).client, { orgId: ORG, bcConnectionId: CONN, invoice, today });

describe('paymentTypeLabel', () => {
  it('reads like people say it', () => {
    expect(paymentTypeLabel('ACH', true, null)).toBe('ePayment (online)');
    expect(paymentTypeLabel('ACH', false, null)).toBe('ACH');
    expect(paymentTypeLabel('CHECK', false, '10482')).toBe('Check #10482');
    expect(paymentTypeLabel('CHECK', false, null)).toBe('Check');
    expect(paymentTypeLabel('CASH', false, null)).toBe('Cash');
    expect(paymentTypeLabel('CREDIT_CARD', false, null)).toBe('Card');
    expect(paymentTypeLabel('OTHER', false, null)).toBe('Other');
    expect(paymentTypeLabel(null, null, null)).toBe('Payment');
  });
});

describe('getInvoicePaymentsAndActivity — payments', () => {
  it('lists Bill.com payments with the amount applied to THIS invoice (not the payment total), linking to the payment page', async () => {
    const { payments } = await run({ billcom_invoice_status: [status()], billcom_received_payments: [payment('rp-1')], billcom_received_payment_invoices: [app('p-rp-1'), app('p-rp-1', { billcom_invoice_id: 'bi-other', amount: 400 })] });
    expect(payments).toEqual([
      expect.objectContaining({ key: 'rp-1', date: '2026-11-10', label: 'Check #10482', amount: 100, status: 'paid', href: '/receivables/payments/rp-1' }),
    ]);
  });

  it('a Nexus card charge shows once, merged with its Bill.com payment by id', async () => {
    const { payments } = await run({
      billcom_invoice_status: [status()],
      billcom_received_payments: [payment('rp-card', { receivables_type: 'CREDIT_CARD', reference_number: null, payment_date: '2026-11-19' })],
      billcom_received_payment_invoices: [app('p-rp-card', { amount: 200, payment_date: '2026-11-19' })],
      card_payments: [charge()],
    });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ key: 'rp-card', label: 'Card (Nexus) · Visa •••• 4242', amount: 200, href: '/receivables/payments/rp-card', chargedBy: 'Fahim' });
  });

  it('…and by invoice, amount, date and card type when the Bill.com id was not saved', async () => {
    const { payments } = await run({
      billcom_invoice_status: [status()],
      billcom_received_payments: [payment('rp-x', { receivables_type: 'CREDIT_CARD', reference_number: null, payment_date: '2026-11-19' })],
      billcom_received_payment_invoices: [app('p-rp-x', { amount: 200, payment_date: '2026-11-19' })],
      card_payments: [charge({ billcom_payment_id: null, billcom_state: 'recorded_manually' })],
    });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ key: 'rp-x', label: 'Card (Nexus) · Visa •••• 4242' });
  });

  it('a charge Bill.com does not have yet (or that failed) still shows, without a payment page', async () => {
    const { payments } = await run({ card_payments: [charge({ billcom_payment_id: null, billcom_state: 'failed' }), charge({ id: 'cp-2', status: 'failed', failure_message: 'Card declined' })] });
    expect(payments.map((p) => [p.status, p.href, p.statusLabel])).toEqual([
      ['paid', null, 'Charged · Bill.com not updated'],
      ['failed', null, 'Failed: Card declined'],
    ]);
  });

  it('cancelled payments stay listed, marked cancelled', async () => {
    const { payments } = await run({ billcom_invoice_status: [status()], billcom_received_payments: [payment('rp-1', { status: 'CANCELED' })], billcom_received_payment_invoices: [app('p-rp-1')] });
    expect(payments[0]).toMatchObject({ status: 'cancelled', statusLabel: 'Cancelled' });
  });

  it('nothing matched in Bill.com, no tables yet, or a read failure: an empty list, never an error', async () => {
    expect((await run({})).payments).toEqual([]);
    const db = fakeSupabase({ billcom_invoice_status: [status()] });
    db.failOn = () => 'relation does not exist';
    const r = await getInvoicePaymentsAndActivity(db.client, { orgId: ORG, bcConnectionId: CONN, invoice, today: '2026-11-21' });
    expect(r.payments).toEqual([]);
    expect(r.activity.some((e) => e.kind === 'posted')).toBe(true);
  });
});

describe('getInvoicePaymentsAndActivity — activity', () => {
  it('collects every kind of event, newest first, with who did it', async () => {
    const { activity } = await run({
      billcom_invoice_status: [status()],
      billcom_received_payments: [payment('rp-1')],
      billcom_received_payment_invoices: [app('p-rp-1')],
      card_payments: [charge({ billcom_payment_id: null, billcom_state: 'failed' })],
      sales_invoice_notes: [{ organization_id: ORG, bc_connection_id: CONN, bc_invoice_id: 'inv-1', body: 'Called, will pay Friday', created_by: 'u-2', created_at: '2026-11-18T19:00:00Z' }],
      sales_invoice_status_events: [{ organization_id: ORG, bc_connection_id: CONN, bc_invoice_id: 'inv-1', source: 'billcom', from_status: 'OPEN', to_status: 'PARTIALLY_PAID', changed_by: null, occurred_at: '2026-11-11T00:30:00Z' }],
      sales_orders: [{ id: 'so-1', organization_id: ORG, bc_connection_id: CONN, bc_posted_invoice_id: 'inv-1', bc_order_number: 'SO-9', invoice_started_by: 'u-1', posted_at: '2026-11-01T18:00:00Z', billcom_invoiced_at: '2026-11-01T18:05:00Z' }],
    });
    expect(activity.map((e) => e.kind)).toEqual(['card_charge', 'note', 'past_due', 'status', 'payment', 'sent_to_billcom', 'posted']);
    expect(activity.find((e) => e.kind === 'card_charge')).toMatchObject({ title: 'Card charged via Nexus by Fahim · Visa •••• 4242 · $200.00', detail: 'Bill.com not updated' });
    expect(activity.find((e) => e.kind === 'note')).toMatchObject({ title: 'Note added by Lani', detail: 'Called, will pay Friday' });
    expect(activity.find((e) => e.kind === 'status')).toMatchObject({ title: 'Bill.com status: Open → Partially paid', detail: 'in Bill.com' });
    expect(activity.find((e) => e.kind === 'payment')).toMatchObject({ title: 'Payment received · Check #10482 · $100.00', href: '/receivables/payments/rp-1' });
    expect(activity.find((e) => e.kind === 'posted')).toMatchObject({ title: 'Posted in Business Central', detail: 'Created from sales order SO-9 by Fahim' });
    expect(activity.find((e) => e.kind === 'past_due')).toMatchObject({ at: '2026-11-16', title: 'Past due', detail: 'Due Nov 15, 2026 · $200.00 unpaid' });
  });

  it('not past due when it was paid in full by the due date (cancelled payments do not count)', async () => {
    const paidOnTime = await run({ billcom_invoice_status: [status({ due_amount: 0, status: 'PAID_IN_FULL' })], billcom_received_payments: [payment('rp-1')], billcom_received_payment_invoices: [app('p-rp-1', { amount: 300 })] });
    expect(paidOnTime.activity.some((e) => e.kind === 'past_due')).toBe(false);
    const cancelled = await run({ billcom_invoice_status: [status()], billcom_received_payments: [payment('rp-1', { status: 'CANCELED' })], billcom_received_payment_invoices: [app('p-rp-1', { amount: 300 })] });
    expect(cancelled.activity.some((e) => e.kind === 'past_due')).toBe(true);
  });

  it('not past due before the due date has passed, or for a cancelled invoice', async () => {
    expect((await run({}, '2026-11-15')).activity.some((e) => e.kind === 'past_due')).toBe(false);
    const cancelledInvoice = await getInvoicePaymentsAndActivity(fakeSupabase({}).client, { orgId: ORG, bcConnectionId: CONN, invoice: { ...invoice, status: 'Canceled' }, today: '2026-11-21' });
    expect(cancelledInvoice.activity.some((e) => e.kind === 'past_due')).toBe(false);
  });

  it('invoice corrections: on the old invoice "replaced by", on the new one "replaces"', async () => {
    const change = { organization_id: ORG, bc_connection_id: CONN, state: 'done', reason: 'Wrong qty', changed_by_name: 'Fahim', old_bc_invoice_id: 'inv-1', old_bc_invoice_number: 'INV-1', new_bc_invoice_id: 'inv-2', new_bc_invoice_number: 'INV-2', created_at: '2026-11-05T00:00:00Z', finished_at: '2026-11-05T00:10:00Z' };
    const old = await run({ sales_invoice_changes: [change] });
    expect(old.activity.find((e) => e.kind === 'correction')).toMatchObject({ title: 'Cancelled and replaced by INV-2', detail: 'Corrected by Fahim: Wrong qty', href: '/receivables/invoices/inv-2' });
    const fresh = await getInvoicePaymentsAndActivity(fakeSupabase({ sales_invoice_changes: [change] }).client, { orgId: ORG, bcConnectionId: CONN, invoice: { ...invoice, bc_invoice_id: 'inv-2' }, today: '2026-11-01' });
    expect(fresh.activity.find((e) => e.kind === 'correction')).toMatchObject({ title: 'Replaces INV-1', href: '/receivables/invoices/inv-1' });
  });
});

describe('review fixes', () => {
  it('a paid invoice whose payments Nexus has not synced yet is not called past due (no guessing)', async () => {
    const paidNoHistory = await getInvoicePaymentsAndActivity(
      fakeSupabase({ users, billcom_invoice_status: [status({ status: 'PAID_IN_FULL', due_amount: 0 })] }).client,
      { orgId: ORG, bcConnectionId: CONN, invoice: { ...invoice, status: 'Paid' }, today: '2026-11-21' },
    );
    expect(paidNoHistory.activity.some((e) => e.kind === 'past_due')).toBe(false);
    // Paid now, but the payments Nexus has don't add up (e.g. a credit): no guessing either.
    const partial = await run({ billcom_invoice_status: [status({ status: 'PAID_IN_FULL', due_amount: 0 })], billcom_received_payments: [payment('rp-1')], billcom_received_payment_invoices: [app('p-rp-1', { amount: 100 })] });
    expect(partial.activity.some((e) => e.kind === 'past_due')).toBe(false);
    // Still unpaid with no payments at all: past due.
    expect((await run({ billcom_invoice_status: [status({ status: 'OPEN', due_amount: 300 })] })).activity.some((e) => e.kind === 'past_due')).toBe(true);
  });

  it('a charge marked "recorded in Bill.com" by hand merges with the payment staff entered (any type, a few days later) — shown once, counted once', async () => {
    const r = await run({
      billcom_invoice_status: [status({ status: 'PARTIALLY_PAID', due_amount: 100 })],
      billcom_received_payments: [payment('rp-o', { receivables_type: 'OTHER', reference_number: null, payment_date: '2026-11-12' })],
      billcom_received_payment_invoices: [app('p-rp-o', { amount: 200, payment_date: '2026-11-12' })],
      card_payments: [charge({ billcom_payment_id: null, billcom_state: 'recorded_manually', charged_at: '2026-11-10T20:00:00Z' })],
    });
    expect(r.payments).toHaveLength(1);
    expect(r.payments[0]).toMatchObject({ key: 'rp-o', label: 'Card (Nexus) · Visa •••• 4242' });
    expect(r.activity.filter((e) => e.kind === 'payment' || e.kind === 'card_charge')).toHaveLength(1);
    expect(r.activity.find((e) => e.kind === 'past_due')).toMatchObject({ detail: 'Due Nov 15, 2026 · $100.00 unpaid' });
  });

  it('saved ids win over guesses, whatever the order (a guessed charge never steals or loses a payment)', async () => {
    const r = await run({
      billcom_invoice_status: [status()],
      billcom_received_payments: [payment('rp-p', { receivables_type: 'CREDIT_CARD', reference_number: null, payment_date: '2026-11-19' })],
      billcom_received_payment_invoices: [app('p-rp-p', { amount: 200, payment_date: '2026-11-19' })],
      card_payments: [charge({ id: 'cp-a', billcom_payment_id: null }), charge({ id: 'cp-b', billcom_payment_id: 'rp-p' })],
    });
    expect(r.payments.map((p) => p.key).sort()).toEqual(['cp-a', 'rp-p']);
  });

  it('whole-day entries sort by the Hawaii day, not before every same-UTC-day timestamp', async () => {
    const r = await run({
      billcom_invoice_status: [status({ status: 'OPEN' })],
      billcom_received_payments: [payment('rp-1', { payment_date: '2026-11-20' })],
      billcom_received_payment_invoices: [app('p-rp-1', { payment_date: '2026-11-20' })],
      // Nov 19, 7 pm in Hawaii: older than a payment dated Nov 20.
      sales_invoice_notes: [{ organization_id: ORG, bc_connection_id: CONN, bc_invoice_id: 'inv-1', body: 'x', created_by: 'u-2', created_at: '2026-11-20T05:00:00Z' }],
    });
    const kinds = r.activity.map((e) => e.kind);
    expect(kinds.indexOf('payment')).toBeLessThan(kinds.indexOf('note'));
  });
});
