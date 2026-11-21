// One Bill.com payment as Nexus stores it, for its details page: how it was
// paid, where it was deposited, the invoices it paid (linked when Nexus has
// them) and, for a card charge made in Nexus, who charged which card.
import type { SupabaseClient } from '@supabase/supabase-js';

import { paymentTypeLabel } from './invoiceActivity';

export interface PaymentDetail {
  payment: {
    billcomPaymentId: string;
    date: string | null;
    amount: number | null;
    typeLabel: string;
    online: boolean | null;
    status: string;
    deposit: string | null;
    convenienceFee: number | null;
    unapplied: number | null;
  };
  invoices: { billcomInvoiceId: string; amount: number | null; number: string | null; href: string | null }[];
  customer: { name: string | null; number: string | null } | null;
  charge: { chargedBy: string | null; card: string; stripeReference: string | null; billcomState: string; chargedAt: string } | null;
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const STATUS: Record<string, string> = { PAID: 'Paid', CANCELED: 'Cancelled' };
const BILLCOM_STATE: Record<string, string> = {
  recorded: 'Recorded in Bill.com',
  recorded_manually: 'Marked as recorded in Bill.com',
  failed: 'Bill.com not updated',
  not_started: 'Bill.com not updated yet',
};

/** Null when the payment isn't stored for this environment's Bill.com connection. */
export async function readPaymentDetail(
  supabase: SupabaseClient,
  { orgId, bcConnectionId, billcomConnectionId, billcomPaymentId }: { orgId: string; bcConnectionId: string; billcomConnectionId: string; billcomPaymentId: string },
): Promise<PaymentDetail | null> {
  const { data: p } = await supabase
    .from('billcom_received_payments')
    .select('*')
    .eq('organization_id', orgId)
    .eq('billcom_connection_id', billcomConnectionId)
    .eq('billcom_payment_id', billcomPaymentId)
    .maybeSingle();
  if (!p) return null;

  const { data: appsData } = await supabase
    .from('billcom_received_payment_invoices')
    .select('billcom_invoice_id, amount')
    .eq('organization_id', orgId)
    .eq('payment_id', p.id);
  const apps = (appsData ?? []) as { billcom_invoice_id: string; amount: number | string | null }[];

  // Which BC invoice each Bill.com invoice is, in this environment.
  const billIds = [...new Set(apps.map((a) => a.billcom_invoice_id))];
  const { data: matchData } = billIds.length
    ? await supabase
        .from('billcom_invoice_status')
        .select('bc_invoice_id, billcom_invoice_id')
        .eq('organization_id', orgId)
        .eq('bc_connection_id', bcConnectionId)
        .eq('match', 'found')
        .in('billcom_invoice_id', billIds)
    : { data: [] };
  const matches = (matchData ?? []) as { bc_invoice_id: string; billcom_invoice_id: string }[];
  const { data: invData } = matches.length
    ? await supabase
        .from('business_central_sales_invoices')
        .select('bc_invoice_id, external_document_number, bc_invoice_number, customer_number, customer_name')
        .eq('organization_id', orgId)
        .eq('bc_connection_id', bcConnectionId)
        .in('bc_invoice_id', matches.map((m) => m.bc_invoice_id))
    : { data: [] };
  const invs = (invData ?? []) as { bc_invoice_id: string; external_document_number: string | null; bc_invoice_number: string | null; customer_number: string | null; customer_name: string | null }[];
  const invoiceFor = (billId: string) => {
    const m = matches.find((x) => x.billcom_invoice_id === billId);
    return m ? invs.find((i) => i.bc_invoice_id === m.bc_invoice_id) ?? null : null;
  };

  // A card charge made in Nexus that this payment records.
  const { data: chargeData } = await supabase
    .from('card_payments')
    .select('charged_by, card_id, stripe_payment_intent_id, billcom_state, charged_at')
    .eq('organization_id', orgId)
    .eq('billcom_payment_id', billcomPaymentId)
    .limit(1);
  const c = (chargeData ?? [])[0] as { charged_by: string | null; card_id: string | null; stripe_payment_intent_id: string | null; billcom_state: string; charged_at: string } | undefined;
  let charge: PaymentDetail['charge'] = null;
  if (c) {
    const [{ data: who }, { data: cardRow }] = await Promise.all([
      c.charged_by ? supabase.from('users').select('display_name').eq('id', c.charged_by).maybeSingle() : Promise.resolve({ data: null }),
      c.card_id ? supabase.from('customer_cards').select('brand, last4').eq('organization_id', orgId).eq('id', c.card_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const brand = (cardRow as { brand?: string | null } | null)?.brand;
    const last4 = (cardRow as { last4?: string | null } | null)?.last4;
    charge = {
      chargedBy: (who as { display_name?: string } | null)?.display_name ?? null,
      card: [brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : null, last4 ? `•••• ${last4}` : null].filter(Boolean).join(' ') || 'card',
      stripeReference: c.stripe_payment_intent_id,
      billcomState: BILLCOM_STATE[c.billcom_state] ?? c.billcom_state,
      chargedAt: c.charged_at,
    };
  }

  const first = invs[0] ?? null;
  return {
    payment: {
      billcomPaymentId,
      date: p.payment_date ?? null,
      amount: num(p.amount),
      typeLabel: c ? `Card (Nexus) · ${charge!.card}` : paymentTypeLabel(p.receivables_type ?? null, p.online_payment ?? null, p.reference_number ?? null),
      online: p.online_payment ?? null,
      status: STATUS[p.status] ?? p.status ?? '—',
      deposit: p.deposit_bank_name || p.deposit_account_last4 ? [p.deposit_bank_name, p.deposit_account_last4 ? `••••${p.deposit_account_last4}` : null].filter(Boolean).join(' ') : null,
      convenienceFee: num(p.convenience_fee),
      unapplied: num(p.unapplied_amount),
    },
    invoices: apps.map((a) => {
      const inv = invoiceFor(a.billcom_invoice_id);
      return {
        billcomInvoiceId: a.billcom_invoice_id,
        amount: num(a.amount),
        number: inv ? inv.external_document_number || inv.bc_invoice_number : null,
        href: inv ? `/receivables/invoices/${encodeURIComponent(inv.bc_invoice_id)}` : null,
      };
    }),
    customer: first ? { name: first.customer_name, number: first.customer_number } : null,
    charge,
  };
}
