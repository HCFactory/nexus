// What happened to a sales invoice, and the payments that paid it: assembled
// from what Nexus already keeps (sales orders, notes, card charges, invoice
// corrections) plus synced Bill.com payments and status history. Every source
// is optional: a missing table or failed read leaves that part out.
import type { SupabaseClient } from '@supabase/supabase-js';

import { hawaiiToday } from '@/lib/billcom/paymentDisplay';
import { billcomStatusLabel } from '@/lib/billcom/invoiceStatus';
import { formatMoney } from '@/lib/format';

export interface ActivityInvoice {
  bc_invoice_id: string;
  bc_invoice_number: string | null;
  external_document_number: string | null;
  posting_date: string | null;
  due_date: string | null;
  total_amount_including_tax: number | null;
  status: string | null;
}

export interface InvoicePaymentRow {
  /** Bill.com payment id, or the Nexus card charge id when Bill.com has no record. */
  key: string;
  date: string | null;
  label: string;
  /** Amount applied to this invoice. */
  amount: number | null;
  status: 'paid' | 'cancelled' | 'processing' | 'failed';
  statusLabel: string;
  /** The payment's details page (Bill.com payments only). */
  href: string | null;
  /** For a card charge made in Nexus. */
  chargedBy?: string | null;
}

export type ActivityKind = 'posted' | 'sent_to_billcom' | 'past_due' | 'payment' | 'card_charge' | 'correction' | 'note' | 'status';

export interface ActivityEvent {
  /** ISO time, or YYYY-MM-DD for whole-day events; newest first. */
  at: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  href?: string;
}

const TYPE_LABEL: Record<string, string> = { ACH: 'ACH', CASH: 'Cash', CREDIT_CARD: 'Card', OTHER: 'Other' };

/** How a payment type reads: "ePayment (online)", "Check #10482", "Cash"… */
export function paymentTypeLabel(type: string | null, online: boolean | null, reference: string | null): string {
  if (!type) return 'Payment';
  if (type === 'ACH' && online) return 'ePayment (online)';
  if (type === 'CHECK') return reference ? `Check #${reference}` : 'Check';
  return TYPE_LABEL[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');
}

const money = (v: number | null) => formatMoney(v, null);
const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const longDate = (d: string) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const nextDay = (d: string) => new Date(Date.parse(`${d.slice(0, 10)}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
const cardName = (brand: string | null, last4: string | null) =>
  [brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : null, last4 ? `•••• ${last4}` : null].filter(Boolean).join(' ') || 'card';

/** Reads rows, or none when the table is missing or the read fails. */
async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await query;
    return error ? [] : ((data ?? []) as T[]);
  } catch {
    return [];
  }
}

type StatusRow = { billcom_connection_id: string | null; match: string; billcom_invoice_id: string | null };
type PaymentRowDb = { id: string; billcom_payment_id: string; payment_date: string | null; receivables_type: string | null; online_payment: boolean | null; reference_number: string | null; status: string | null };
type AppRow = { payment_id: string; amount: number | string | null; payment_date: string | null; status: string | null };
type ChargeRow = { id: string; amount: number | string; status: string; billcom_state: string; billcom_payment_id: string | null; card_id: string | null; charged_by: string | null; charged_at: string; failure_message: string | null };
type CardRow = { id: string; brand: string | null; last4: string | null };
type NoteRow = { body: string; created_by: string | null; created_at: string };
type EventRow = { source: 'bc' | 'billcom'; from_status: string | null; to_status: string | null; changed_by: string | null; occurred_at: string };
type OrderRow = { bc_order_number: string | null; invoice_started_by: string | null; posted_at: string | null; billcom_invoiced_at: string | null };
type ChangeRow = { state: string; reason: string; changed_by_name: string; old_bc_invoice_id: string; old_bc_invoice_number: string; new_bc_invoice_id: string | null; new_bc_invoice_number: string | null; created_at: string; finished_at: string | null };

export async function getInvoicePaymentsAndActivity(
  supabase: SupabaseClient,
  { orgId, bcConnectionId, invoice, today }: { orgId: string; bcConnectionId: string; invoice: ActivityInvoice; today: string },
): Promise<{ payments: InvoicePaymentRow[]; activity: ActivityEvent[] }> {
  const id = invoice.bc_invoice_id;
  const scoped = (table: string, columns: string) =>
    supabase.from(table).select(columns).eq('organization_id', orgId).eq('bc_connection_id', bcConnectionId);

  const [statusRows, charges, notes, events, orders, changesOld, changesNew] = await Promise.all([
    rows<StatusRow>(scoped('billcom_invoice_status', 'billcom_connection_id, match, billcom_invoice_id').eq('bc_invoice_id', id).limit(1)),
    rows<ChargeRow>(
      supabase
        .from('card_payments')
        .select('id, amount, status, billcom_state, billcom_payment_id, card_id, charged_by, charged_at, failure_message')
        .eq('organization_id', orgId)
        .eq('bc_invoice_id', id),
    ),
    rows<NoteRow>(scoped('sales_invoice_notes', 'body, created_by, created_at').eq('bc_invoice_id', id)),
    rows<EventRow>(scoped('sales_invoice_status_events', 'source, from_status, to_status, changed_by, occurred_at').eq('bc_invoice_id', id)),
    rows<OrderRow>(scoped('sales_orders', 'bc_order_number, invoice_started_by, posted_at, billcom_invoiced_at').eq('bc_posted_invoice_id', id).limit(1)),
    rows<ChangeRow>(scoped('sales_invoice_changes', '*').eq('old_bc_invoice_id', id)),
    rows<ChangeRow>(scoped('sales_invoice_changes', '*').eq('new_bc_invoice_id', id)),
  ]);

  // Bill.com payments applied to this invoice (once Nexus has matched it in Bill.com).
  const match = statusRows[0]?.match === 'found' ? statusRows[0] : null;
  let applied: { payment: PaymentRowDb; app: AppRow }[] = [];
  if (match?.billcom_invoice_id && match.billcom_connection_id) {
    const apps = await rows<AppRow>(
      supabase
        .from('billcom_received_payment_invoices')
        .select('payment_id, amount, payment_date, status')
        .eq('organization_id', orgId)
        .eq('billcom_connection_id', match.billcom_connection_id)
        .eq('billcom_invoice_id', match.billcom_invoice_id),
    );
    if (apps.length > 0) {
      const payments = await rows<PaymentRowDb>(
        supabase
          .from('billcom_received_payments')
          .select('id, billcom_payment_id, payment_date, receivables_type, online_payment, reference_number, status')
          .eq('organization_id', orgId)
          .in('id', [...new Set(apps.map((a) => a.payment_id))]),
      );
      const byId = new Map(payments.map((p) => [p.id, p]));
      applied = apps.flatMap((app) => (byId.has(app.payment_id) ? [{ payment: byId.get(app.payment_id)!, app }] : []));
    }
  }

  // Names of the people involved, and the cards charged.
  const userIds = [...new Set([...charges.map((c) => c.charged_by), ...notes.map((n) => n.created_by), ...events.map((e) => e.changed_by), orders[0]?.invoice_started_by].filter((v): v is string => Boolean(v)))];
  const cardIds = [...new Set(charges.map((c) => c.card_id).filter((v): v is string => Boolean(v)))];
  const [people, cards] = await Promise.all([
    userIds.length ? rows<{ id: string; display_name: string }>(supabase.from('users').select('id, display_name').in('id', userIds)) : [],
    cardIds.length ? rows<CardRow>(supabase.from('customer_cards').select('id, brand, last4').eq('organization_id', orgId).in('id', cardIds)) : [],
  ]);
  const nameOf = (uid: string | null) => (uid ? people.find((p) => p.id === uid)?.display_name ?? 'someone' : null);
  const cardOf = (cid: string | null) => {
    const c = cards.find((x) => x.id === cid);
    return cardName(c?.brand ?? null, c?.last4 ?? null);
  };

  // Match each Nexus card charge to its Bill.com payment: by saved id, else
  // by same amount on the same (Hawaii) day as a Bill.com card payment.
  const mergedCharge = new Map<string, ChargeRow>(); // billcom payment id -> charge
  const unmerged: ChargeRow[] = [];
  for (const c of charges) {
    let hit = c.billcom_payment_id ? applied.find((a) => a.payment.billcom_payment_id === c.billcom_payment_id) : undefined;
    if (!hit && c.status === 'succeeded') {
      const day = hawaiiToday(new Date(c.charged_at));
      hit = applied.find(
        (a) =>
          !mergedCharge.has(a.payment.billcom_payment_id) &&
          a.payment.receivables_type === 'CREDIT_CARD' &&
          Math.abs((num(a.app.amount) ?? NaN) - Number(c.amount)) < 0.005 &&
          (a.app.payment_date ?? a.payment.payment_date) === day,
      );
    }
    if (hit) mergedCharge.set(hit.payment.billcom_payment_id, c);
    else unmerged.push(c);
  }

  const payments: InvoicePaymentRow[] = [
    ...applied.map(({ payment: p, app }) => {
      const c = mergedCharge.get(p.billcom_payment_id);
      const cancelled = p.status === 'CANCELED' || app.status === 'CANCELED';
      return {
        key: p.billcom_payment_id,
        date: app.payment_date ?? p.payment_date,
        label: c ? `Card (Nexus) · ${cardOf(c.card_id)}` : paymentTypeLabel(p.receivables_type, p.online_payment, p.reference_number),
        amount: num(app.amount),
        status: cancelled ? ('cancelled' as const) : ('paid' as const),
        statusLabel: cancelled ? 'Cancelled' : 'Paid',
        href: `/receivables/payments/${encodeURIComponent(p.billcom_payment_id)}`,
        ...(c ? { chargedBy: nameOf(c.charged_by) } : {}),
      };
    }),
    ...unmerged.map((c) => ({
      key: c.id,
      date: hawaiiToday(new Date(c.charged_at)),
      label: `Card (Nexus) · ${cardOf(c.card_id)}`,
      amount: num(c.amount),
      status: c.status === 'succeeded' ? ('paid' as const) : c.status === 'failed' ? ('failed' as const) : ('processing' as const),
      statusLabel:
        c.status === 'failed'
          ? `Failed${c.failure_message ? `: ${c.failure_message}` : ''}`
          : c.status === 'processing'
            ? 'Processing'
            : c.billcom_state === 'recorded' || c.billcom_state === 'recorded_manually'
              ? 'Charged · recorded in Bill.com'
              : 'Charged · Bill.com not updated',
      href: null,
      chargedBy: nameOf(c.charged_by),
    })),
  ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  // The timeline.
  const activity: ActivityEvent[] = [];
  const order = orders[0];
  const postedAt = order?.posted_at ?? invoice.posting_date;
  if (postedAt) {
    activity.push({
      at: postedAt,
      kind: 'posted',
      title: 'Posted in Business Central',
      ...(order ? { detail: `Created from sales order${order.bc_order_number ? ` ${order.bc_order_number}` : ''}${order.invoice_started_by ? ` by ${nameOf(order.invoice_started_by)}` : ''}` } : {}),
    });
  }
  if (order?.billcom_invoiced_at) activity.push({ at: order.billcom_invoiced_at, kind: 'sent_to_billcom', title: 'Sent to Bill.com' });

  for (const { payment: p, app } of applied) {
    if (mergedCharge.has(p.billcom_payment_id)) continue; // shown as the card charge
    const cancelled = p.status === 'CANCELED' || app.status === 'CANCELED';
    activity.push({
      at: app.payment_date ?? p.payment_date ?? '',
      kind: 'payment',
      title: `Payment received · ${paymentTypeLabel(p.receivables_type, p.online_payment, p.reference_number)} · ${money(num(app.amount))}`,
      ...(cancelled ? { detail: 'Cancelled' } : {}),
      href: `/receivables/payments/${encodeURIComponent(p.billcom_payment_id)}`,
    });
  }
  for (const c of charges) {
    const billcomPaymentId = [...mergedCharge.entries()].find(([, v]) => v === c)?.[0];
    activity.push({
      at: c.charged_at,
      kind: 'card_charge',
      title: `Card charged via Nexus by ${nameOf(c.charged_by) ?? 'someone'} · ${cardOf(c.card_id)} · ${money(num(c.amount))}`,
      detail:
        c.status === 'failed'
          ? `Failed${c.failure_message ? `: ${c.failure_message}` : ''}`
          : c.status === 'processing'
            ? 'Processing'
            : c.billcom_state === 'recorded' || c.billcom_state === 'recorded_manually' || billcomPaymentId
              ? 'Recorded in Bill.com'
              : 'Bill.com not updated',
      ...(billcomPaymentId ? { href: `/receivables/payments/${encodeURIComponent(billcomPaymentId)}` } : {}),
    });
  }
  for (const n of notes) {
    activity.push({ at: n.created_at, kind: 'note', title: `Note added by ${nameOf(n.created_by) ?? 'someone'}`, detail: n.body.length > 160 ? `${n.body.slice(0, 157)}…` : n.body });
  }
  for (const e of events) {
    const label = (s: string | null) => (!s ? '—' : e.source === 'billcom' ? billcomStatusLabel(s) : s);
    activity.push({
      at: e.occurred_at,
      kind: 'status',
      title: `${e.source === 'billcom' ? 'Bill.com' : 'BC'} status: ${label(e.from_status)} → ${label(e.to_status)}`,
      detail: e.changed_by ? `by ${nameOf(e.changed_by)}` : e.source === 'billcom' ? 'in Bill.com' : 'in Business Central',
    });
  }
  for (const c of changesOld.filter((x) => x.state === 'done' && x.new_bc_invoice_id)) {
    activity.push({
      at: c.finished_at ?? c.created_at,
      kind: 'correction',
      title: `Cancelled and replaced by ${c.new_bc_invoice_number ?? 'a new invoice'}`,
      detail: `Corrected by ${c.changed_by_name || 'someone'}: ${c.reason}`,
      href: `/receivables/invoices/${encodeURIComponent(c.new_bc_invoice_id!)}`,
    });
  }
  for (const c of changesNew.filter((x) => x.state === 'done')) {
    activity.push({
      at: c.finished_at ?? c.created_at,
      kind: 'correction',
      title: `Replaces ${c.old_bc_invoice_number}`,
      detail: `Corrected by ${c.changed_by_name || 'someone'}: ${c.reason}`,
      href: `/receivables/invoices/${encodeURIComponent(c.old_bc_invoice_id)}`,
    });
  }

  // Past due: the day after the due date, if money was still owed then.
  const due = invoice.due_date?.slice(0, 10);
  const total = num(invoice.total_amount_including_tax);
  const knowsPayments = Boolean(match) || charges.length > 0;
  if (due && total !== null && today > due && invoice.status !== 'Canceled' && (knowsPayments || invoice.status !== 'Paid')) {
    const paidByDue =
      applied
        .filter(({ payment: p, app }) => p.status !== 'CANCELED' && app.status !== 'CANCELED' && (app.payment_date ?? p.payment_date ?? '9999') <= due)
        .reduce((s, { app }) => s + (num(app.amount) ?? 0), 0) +
      unmerged.filter((c) => c.status === 'succeeded' && hawaiiToday(new Date(c.charged_at)) <= due).reduce((s, c) => s + Number(c.amount), 0);
    const unpaid = Math.round((total - paidByDue) * 100) / 100;
    if (unpaid > 0.005) activity.push({ at: nextDay(due), kind: 'past_due', title: 'Past due', detail: `Due ${longDate(due)} · ${money(unpaid)} unpaid` });
  }

  activity.sort((a, b) => b.at.localeCompare(a.at));
  return { payments, activity };
}
