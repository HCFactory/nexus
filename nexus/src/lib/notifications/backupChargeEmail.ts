import type { SupabaseClient } from '@supabase/supabase-js';

import { cardBrandName } from '@/lib/email';
import { readNotificationSettings } from './settings';

/**
 * Staff email when a backup card (saved Stripe card) charge succeeds, to the
 * Settings > Receivables list. Sent once per charge: card_payments.charge_email_sent_at
 * is claimed before sending. Never throws: a charge must never fail because of it.
 */

export interface BackupChargeEmailInput {
  invoiceNumber: string;
  amount: number;
  customerName: string | null;
  customerNumber: string;
  cardBrand: string | null;
  cardLast4: string | null;
  chargedBy: string | null;
  chargedAt: string;
  /** card_payments.billcom_state when the email is built. */
  billcomState: string;
  invoiceUrl: string;
}

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

const hawaiiTime = (iso: string) =>
  `${new Date(iso).toLocaleString('en-US', {
    timeZone: 'Pacific/Honolulu',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })} HST`;

export function buildBackupChargeEmail(p: BackupChargeEmailInput): { subject: string; text: string } {
  const customer = p.customerName?.trim() || p.customerNumber;
  const customerLine = p.customerName?.trim() ? `${p.customerName.trim()} (${p.customerNumber})` : p.customerNumber;
  const card = p.cardLast4 ? `${cardBrandName(p.cardBrand)} •••• ${p.cardLast4}` : cardBrandName(p.cardBrand);
  const inBillcom = p.billcomState === 'recorded' || p.billcomState === 'recorded_manually';
  const billcom = inBillcom ? 'Recorded in Bill.com.' : 'NOT recorded in Bill.com yet. Open the invoice in Nexus to finish it.';
  return {
    subject: `Backup payment charged: ${p.invoiceNumber} · ${money(p.amount)} · ${customer} [NEXUS]`,
    text: [
      'A backup payment method was charged.',
      '',
      `Invoice: ${p.invoiceNumber}`,
      `Amount: ${money(p.amount)}`,
      `Customer: ${customerLine}`,
      `Card: ${card}`,
      `Charged by: ${p.chargedBy?.trim() || 'staff'}`,
      `Charged: ${hawaiiTime(p.chargedAt)}`,
      `Bill.com: ${billcom}`,
      '',
      `View the invoice: ${p.invoiceUrl}`,
    ].join('\n'),
  };
}

export interface BackupChargeNotifyDeps {
  /** Service-role client. */
  supabase: SupabaseClient;
  orgId: string;
  now: () => Date;
  send: (m: { to: string[]; subject: string; text: string }) => Promise<void>;
  appUrl: string;
}

interface ClaimedPayment {
  id: string;
  bc_customer_number: string;
  bc_invoice_id: string;
  invoice_number: string;
  amount: number | string;
  card_id: string;
  billcom_state: string;
  charged_by: string | null;
  charged_at: string;
}

/** Best-effort lookups for the email: a failed read leaves the value off. */
async function one<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> {
  const { data, error } = await q;
  return error ? null : ((data as T | null) ?? null);
}

export async function notifyBackupCharge(deps: BackupChargeNotifyDeps, cardPaymentId: string): Promise<void> {
  try {
    const settings = await readNotificationSettings(deps.supabase, deps.orgId);
    const to = settings.backupChargeEmails;
    if (to.length === 0) return;

    // Claim first, so a second caller (or a retry) never sends it again.
    const { data, error } = await deps.supabase
      .from('card_payments')
      .update({ charge_email_sent_at: deps.now().toISOString() })
      .eq('organization_id', deps.orgId)
      .eq('id', cardPaymentId)
      .eq('status', 'succeeded')
      .is('charge_email_sent_at', null)
      .select('*');
    if (error) {
      console.error(`[notifications] card payment ${cardPaymentId}: could not mark the charge email: ${error.message}`);
      return;
    }
    const p = ((data ?? []) as ClaimedPayment[])[0];
    if (!p) return;

    const [card, customer, user] = await Promise.all([
      one<{ brand: string | null; last4: string | null }>(
        deps.supabase.from('customer_cards').select('brand, last4').eq('organization_id', deps.orgId).eq('id', p.card_id).maybeSingle(),
      ),
      one<{ display_name: string | null }>(
        deps.supabase
          .from('business_central_customers')
          .select('display_name')
          .eq('organization_id', deps.orgId)
          .eq('bc_customer_number', p.bc_customer_number)
          .limit(1)
          .maybeSingle(),
      ),
      p.charged_by
        ? one<{ display_name: string | null; email: string | null }>(
            deps.supabase.from('users').select('display_name, email').eq('organization_id', deps.orgId).eq('id', p.charged_by).maybeSingle(),
          )
        : Promise.resolve(null),
    ]);

    const email = buildBackupChargeEmail({
      invoiceNumber: p.invoice_number,
      amount: Number(p.amount),
      customerName: customer?.display_name ?? null,
      customerNumber: p.bc_customer_number,
      cardBrand: card?.brand ?? null,
      cardLast4: card?.last4 ?? null,
      chargedBy: user?.display_name?.trim() || user?.email || null,
      chargedAt: p.charged_at,
      billcomState: p.billcom_state,
      invoiceUrl: `${deps.appUrl.replace(/\/$/, '')}/receivables/invoices/${encodeURIComponent(p.bc_invoice_id)}`,
    });
    await deps.send({ to, ...email });
  } catch (e) {
    console.error(`[notifications] card payment ${cardPaymentId}: the backup payment email failed: ${e instanceof Error ? e.message : e}`);
  }
}
