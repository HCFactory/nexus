import { describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type Row } from '@/test/fakeSupabase';
import { buildBackupChargeEmail, notifyBackupCharge } from './backupChargeEmail';

const NOW = new Date('2026-11-21T20:30:00Z');

const payment = (over: Row = {}): Row => ({
  id: 'cp-1',
  organization_id: 'org-1',
  bc_customer_number: 'C100',
  bc_invoice_id: 'inv-guid',
  invoice_number: 'W-116080',
  amount: 314.14,
  card_id: 'card-1',
  status: 'succeeded',
  billcom_state: 'recorded',
  billcom_error: null,
  charged_by: 'u1',
  charged_at: '2026-11-21T20:15:00Z',
  charge_email_sent_at: null,
  ...over,
});

function setup(opts: { payment?: Row; emails?: string[] | null; tables?: Record<string, Row[]> } = {}) {
  const db = fakeSupabase({
    org_notification_settings:
      opts.emails === null ? [] : [{ organization_id: 'org-1', backup_charge_emails: opts.emails ?? ['ar@example.com'], card_saved_emails: null }],
    card_payments: [opts.payment ?? payment()],
    customer_cards: [{ id: 'card-1', organization_id: 'org-1', brand: 'visa', last4: '4242' }],
    business_central_customers: [{ organization_id: 'org-1', bc_customer_number: 'C100', display_name: 'Aloha School' }],
    users: [{ id: 'u1', organization_id: 'org-1', display_name: 'Lani', email: 'lani@example.com' }],
    ...opts.tables,
  });
  const send = vi.fn(async (_m: { to: string[]; subject: string; text: string }) => {});
  const deps = { supabase: db.client, orgId: 'org-1', now: () => NOW, send, appUrl: 'https://nexus.example.com' };
  return { db, send, deps };
}

describe('buildBackupChargeEmail', () => {
  const base = {
    invoiceNumber: 'W-116080',
    amount: 314.14,
    customerName: 'Aloha School',
    customerNumber: 'C100',
    cardBrand: 'visa',
    cardLast4: '4242',
    chargedBy: 'Lani',
    chargedAt: '2026-11-21T20:15:00Z',
    billcomState: 'recorded',
    invoiceUrl: 'https://nexus.example.com/receivables/invoices/inv-guid',
  };

  it('subject and body name the invoice, amount, customer and card', () => {
    const { subject, text } = buildBackupChargeEmail(base);
    expect(subject).toBe('Backup payment charged: W-116080 · $314.14 · Aloha School [NEXUS]');
    expect(text).toBe(
      [
        'A backup payment method was charged.',
        '',
        'Invoice: W-116080',
        'Amount: $314.14',
        'Customer: Aloha School (C100)',
        'Card: Visa •••• 4242',
        'Charged by: Lani',
        'Charged: Nov 21, 2026, 10:15 AM HST',
        'Bill.com: Recorded in Bill.com.',
        '',
        'View the invoice: https://nexus.example.com/receivables/invoices/inv-guid',
      ].join('\n'),
    );
  });

  it('warns when the payment is not in Bill.com', () => {
    for (const state of ['failed', 'not_started']) {
      expect(buildBackupChargeEmail({ ...base, billcomState: state }).text).toContain(
        'Bill.com: NOT recorded in Bill.com yet. Open the invoice in Nexus to finish it.',
      );
    }
  });

  it('missing names fall back to staff and the customer number', () => {
    const { subject, text } = buildBackupChargeEmail({ ...base, chargedBy: null, customerName: null, cardBrand: null, cardLast4: null });
    expect(subject).toBe('Backup payment charged: W-116080 · $314.14 · C100 [NEXUS]');
    expect(text).toContain('Customer: C100\n');
    expect(text).toContain('Card: Card\n');
    expect(text).toContain('Charged by: staff\n');
  });
});

describe('notifyBackupCharge', () => {
  it('emails the Settings list once and marks the payment', async () => {
    const s = setup({ emails: ['ar@example.com', 'boss@example.com'] });
    await notifyBackupCharge(s.deps, 'cp-1');
    await notifyBackupCharge(s.deps, 'cp-1');
    expect(s.send).toHaveBeenCalledTimes(1);
    const msg = s.send.mock.calls[0][0];
    expect(msg.to).toEqual(['ar@example.com', 'boss@example.com']);
    expect(msg.subject).toBe('Backup payment charged: W-116080 · $314.14 · Aloha School [NEXUS]');
    expect(msg.text).toContain('Card: Visa •••• 4242');
    expect(msg.text).toContain('Charged by: Lani');
    expect(msg.text).toContain('https://nexus.example.com/receivables/invoices/inv-guid');
    expect(s.db.tables.card_payments[0].charge_email_sent_at).toBe(NOW.toISOString());
  });

  it('nobody on the list: no email and the payment is not marked', async () => {
    for (const emails of [[], null]) {
      const s = setup({ emails });
      await notifyBackupCharge(s.deps, 'cp-1');
      expect(s.send).not.toHaveBeenCalled();
      expect(s.db.tables.card_payments[0].charge_email_sent_at).toBeNull();
    }
  });

  it('only for a succeeded charge', async () => {
    const s = setup({ payment: payment({ status: 'failed' }) });
    await notifyBackupCharge(s.deps, 'cp-1');
    expect(s.send).not.toHaveBeenCalled();
  });

  it('never throws: the settings table or the new column missing, or the send failing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = setup();
    missing.db.failOn = (table, op) => (table === 'card_payments' && op === 'update' ? 'column "charge_email_sent_at" does not exist' : null);
    await expect(notifyBackupCharge(missing.deps, 'cp-1')).resolves.toBeUndefined();
    expect(missing.send).not.toHaveBeenCalled();

    const noTable = setup();
    noTable.db.failOn = (table) => (table === 'org_notification_settings' ? 'relation does not exist' : null);
    await expect(notifyBackupCharge(noTable.deps, 'cp-1')).resolves.toBeUndefined();
    expect(noTable.send).not.toHaveBeenCalled();

    const sendFails = setup();
    sendFails.send.mockRejectedValueOnce(new Error('Resend down'));
    await expect(notifyBackupCharge(sendFails.deps, 'cp-1')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("another organization's payment is never sent", async () => {
    const s = setup({ payment: payment({ organization_id: 'org-2' }) });
    await notifyBackupCharge(s.deps, 'cp-1');
    expect(s.send).not.toHaveBeenCalled();
  });
});
