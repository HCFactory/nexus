import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import type { BillcomClient } from '@/lib/billcom/client';
import { recordBillcomCardPayment } from '@/lib/billcom/recordPayment';
import type { BillcomPanelInput } from '@/lib/receivables/salesInvoicePage';
import { isChangeOpen, type ChangeState } from '@/types/invoiceChanges';
import type {
  BillcomLookup,
  CardLabel,
  CardPayment,
  CardPaymentRow,
  ChargeEligibility,
  CustomerCard,
} from '@/types/stripe';

/**
 * Charging a past-due invoice to the customer's saved card.
 *
 * Money moves here, so the order of writes is fixed:
 *   insert `processing` → Stripe → `succeeded` (+ intent id) → Bill.com record → `recorded`.
 * Stripe is never called unless the insert succeeded (the partial unique index
 * on billcom_invoice_id is the double-charge guard), Bill.com is never called
 * unless Stripe succeeded, and an unknown Stripe outcome leaves the row
 * `processing` for checkChargeStatus to settle; it is never re-charged.
 *
 * "Today" is the business date in Hawaii (Pacific/Honolulu), the time zone the
 * app shows dates in: it decides "past due" and is the Bill.com payment date.
 */

export const RETRY_CANNOT_CHECK = "Couldn't check this invoice in Bill.com, so nothing was recorded. Try again.";
export const RETRY_LESS_OWING =
  'Bill.com shows less owing on this invoice than this payment, so it may already be recorded. Check Bill.com; if the payment is there, use "I marked it paid in Bill.com".';
export const RETRY_LESS_OWING_LATE =
  'Bill.com shows less owing on this invoice than this late charge, so the customer may have paid twice. Refund this charge in Stripe, then use "I marked it paid in Bill.com".';
const LATE_CHARGE_PREFIX = 'Stripe charged this card (';
const billcomAlreadyHas = (id: string) => `Bill.com already has this payment (${id}). Use "I marked it paid in Bill.com" instead of Retry.`;
export const DUPLICATE_CHARGE_MESSAGE = 'A charge for this invoice is already in progress or needs attention.';
export const AUTH_REQUIRED_MESSAGE = 'The bank needs the customer to approve this charge — send a new setup link.';

const REASONS = {
  noPermission: "You don't have permission to charge cards.",
  stripeOff: "Stripe isn't set up.",
  noCard: 'No card on file — send a setup link from the customer page.',
  notInBillcom: "This invoice isn't in Bill.com yet.",
  ambiguous: 'More than one Bill.com invoice matches this number.',
  mismatch: "The Bill.com invoice with this number doesn't match this invoice's total or customer.",
  nothingDue: 'Nothing is due on this invoice.',
  notPastDue: "This invoice isn't past due yet.",
  replaced: 'This invoice was cancelled and replaced — charge the corrected invoice.',
  changing: 'This invoice is being changed — try again once the change is done.',
} as const;

/** 'replaced' = a finished invoice change cancelled it; 'changing' = its order has a change still open. */
export type InvoiceChargeStatus = 'live' | 'replaced' | 'changing';

/**
 * Whether the invoice can be charged at all, from its invoice changes. Mid-change
 * the Bill.com invoice still has the old total and is about to be rewritten.
 */
export function invoiceChargeStatus(p: { replacedBy: unknown; changes: { state: ChangeState }[] }): InvoiceChargeStatus {
  if (p.replacedBy) return 'replaced';
  return p.changes.some((c) => isChangeOpen(c.state)) ? 'changing' : 'live';
}

export const MARKED_NOT_CHARGED_MESSAGE = 'Marked as not charged by staff after checking Stripe.';
export const CHARGE_CHANGED_MESSAGE =
  'The amount due or card on file changed since you opened this — refresh and review before charging.';
const BILLCOM_INTERRUPTED =
  'Recording in Bill.com was interrupted, so the payment may already be in Bill.com. Check Bill.com before pressing Retry; if it is there, use "I marked it paid in Bill.com".';
const BILLCOM_OFF = "Bill.com isn't connected.";
const NOT_RETRYABLE = "This payment isn't waiting for a Bill.com retry.";
const NOT_MANUAL = 'Only a charged payment that Bill.com failed to record can be marked paid.';
const NOT_FOUND = 'Card payment not found.';

/** list() looks back this far before charged_at, for clock skew between Nexus and Stripe. */
const LIST_LOOKBACK_SECONDS = 300;
const LIST_MAX_PAGES = 20;
const NOT_PROCESSING = 'Only a charge still being checked with Stripe can be marked as not charged.';
const INTENT_EXISTS = 'Stripe has a payment for this charge, so it was settled from Stripe instead.';
/** Stripe errors that mean the request was refused before any money moved. */
const NO_CHARGE_ERRORS = new Set([
  'StripeCardError',
  'StripeInvalidRequestError',
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeRateLimitError',
]);
/** A Bill.com record takes seconds; still `not_started` after this means it was cut off. */
const BILLCOM_STUCK_AFTER_MS = 10 * 60 * 1000;
/**
 * "Not charged" is refused this soon after the attempt: a create can still be
 * in flight (client timeout + retries) and succeed after Check status saw nothing.
 */
export const NOT_CHARGED_MIN_AGE_MS = 10 * 60 * 1000;
const TOO_SOON_FOR_NOT_CHARGED = 'Wait at least 10 minutes after the charge attempt before marking it as not charged.';
const UNIQUE_VIOLATION = '23505';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the charge needs to know about the BC posted invoice. */
export interface ChargeInvoiceContext {
  bcInvoiceId: string;
  customerNumber: string | null;
  /** Shown to staff, sent to Stripe and stored: the BC Invoice No. */
  invoiceNumber: string;
  /** For the Bill.com by-number lookup: Invoice #, then BC Invoice No. */
  invoiceNumbers: string[];
  salesOrderId: string | null;
  /** Set when Nexus created the Bill.com invoice. */
  billcomInvoiceId: string | null;
  /** From the order's invoice changes; missing = 'live'. */
  status?: InvoiceChargeStatus;
  /** BC total incl. tax and customer name: connector mode only matches a Bill.com invoice that agrees. */
  bcTotal?: number | null;
  customerName?: string | null;
}

/** Everything with side effects, injected so tests need no network. */
export interface ChargeDeps {
  supabase: SupabaseClient;
  orgId: string;
  canCharge: boolean;
  /** The org's CURRENT default Stripe connection when enabled; null = Stripe off. */
  stripeConnectionId: string | null;
  stripeClient: (connectionId: string) => Promise<Stripe>;
  /** null when Bill.com is off or its client cannot be created. */
  billcom: () => Promise<BillcomClient | null>;
  loadInvoice: (bcInvoiceId: string) => Promise<ChargeInvoiceContext | null>;
  /** A live Bill.com read: the amount due is never taken from the page. */
  findBillcomInvoice: (input: BillcomPanelInput) => Promise<BillcomLookup>;
  now: () => Date;
}

/** YYYY-MM-DD in Hawaii. */
export function businessDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Honolulu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const toCents = (amount: number) => Math.round(amount * 100);

export function chargeEligibility(a: {
  canCharge: boolean;
  /** Defaults to 'live'. */
  invoice?: InvoiceChargeStatus;
  /** 'off' = no enabled default Stripe connection. Defaults to 'ready'. */
  stripe?: 'off' | 'ready';
  card: CardLabel | null;
  billcom: BillcomLookup;
  /** Business date, YYYY-MM-DD. */
  today: string;
}): ChargeEligibility {
  const no = (reason: string): ChargeEligibility => ({ ok: false, reason });
  if (!a.canCharge) return no(REASONS.noPermission);
  if (a.invoice === 'replaced') return no(REASONS.replaced);
  if (a.invoice === 'changing') return no(REASONS.changing);
  if (a.stripe === 'off') return no(REASONS.stripeOff);
  if (!a.card) return no(REASONS.noCard);
  if (a.billcom.kind === 'ambiguous') return no(REASONS.ambiguous);
  if (a.billcom.kind === 'mismatch') return no(REASONS.mismatch);
  if (a.billcom.kind !== 'found' || !a.billcom.billcomCustomerId) return no(REASONS.notInBillcom);
  const { dueAmount, dueDate } = a.billcom.status;
  if (dueAmount === null || toCents(dueAmount) <= 0) return no(REASONS.nothingDue);
  if (!dueDate || dueDate.slice(0, 10) >= a.today) return no(REASONS.notPastDue);
  return { ok: true, amount: dueAmount, dueDate };
}

// ---------- reads ----------

async function activeCard(deps: ChargeDeps, customerNumber: string | null): Promise<CardLabel | null> {
  if (!deps.stripeConnectionId || !customerNumber) return null;
  const { data, error } = await deps.supabase
    .from('customer_cards')
    .select('*')
    .eq('organization_id', deps.orgId)
    .eq('stripe_connection_id', deps.stripeConnectionId)
    .eq('bc_customer_number', customerNumber)
    .is('removed_at', null)
    .maybeSingle();
  if (error) throw new Error(`Could not read the card: ${error.message}`);
  const c = data as CustomerCard | null;
  return c
    ? {
        id: c.id,
        brand: c.brand,
        last4: c.last4,
        expMonth: c.exp_month,
        expYear: c.exp_year,
        savedAt: c.saved_at,
        stripePaymentMethodId: c.stripe_payment_method_id,
        stripeConnectionId: c.stripe_connection_id,
      }
    : null;
}

async function cardOf(deps: ChargeDeps, cardId: string): Promise<{ brand: string | null; last4: string | null }> {
  const { data, error } = await deps.supabase
    .from('customer_cards')
    .select('brand, last4')
    .eq('organization_id', deps.orgId)
    .eq('id', cardId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the card: ${error.message}`);
  const c = data as { brand: string | null; last4: string | null } | null;
  return { brand: c?.brand ?? null, last4: c?.last4 ?? null };
}

async function readPayment(deps: ChargeDeps, id: string): Promise<CardPayment> {
  const { data, error } = await deps.supabase
    .from('card_payments')
    .select('*')
    .eq('organization_id', deps.orgId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Could not read the card payment: ${error.message}`);
  if (!data) throw new Error(NOT_FOUND);
  return data as CardPayment;
}

async function toRow(deps: ChargeDeps, p: CardPayment): Promise<CardPaymentRow> {
  const card = await cardOf(deps, p.card_id);
  return {
    id: p.id,
    bcInvoiceId: p.bc_invoice_id,
    invoiceNumber: p.invoice_number,
    billcomInvoiceId: p.billcom_invoice_id,
    amount: Number(p.amount),
    currency: p.currency,
    status: p.status,
    failureMessage: p.failure_message ?? null,
    stripePaymentIntentId: p.stripe_payment_intent_id ?? null,
    billcomState: p.billcom_state,
    billcomError: p.billcom_error ?? null,
    billcomRecordedAt: p.billcom_recorded_at ?? null,
    chargedAt: p.charged_at,
    chargedBy: p.charged_by ?? null,
    recordedManuallyBy: p.recorded_manually_by ?? null,
    notChargedBy: p.not_charged_by ?? null,
    notChargedAt: p.not_charged_at ?? null,
    cardBrand: card.brand,
    cardLast4: card.last4,
    billcomStuck: isBillcomStuck(deps, p),
  };
}

/** Charged, but the current Bill.com attempt started over 10 minutes ago and is still `not_started`. */
function isBillcomStuck(deps: ChargeDeps, p: CardPayment): boolean {
  if (p.status !== 'succeeded' || p.billcom_state !== 'not_started') return false;
  const attemptAt = p.billcom_attempt_at ?? p.charged_at;
  return deps.now().getTime() - new Date(attemptAt).getTime() > BILLCOM_STUCK_AFTER_MS;
}

const rowById = async (deps: ChargeDeps, id: string) => toRow(deps, await readPayment(deps, id));

/** The first valid address of a customer's email field (it may hold several). */
async function receiptEmail(deps: ChargeDeps, customerNumber: string): Promise<string | null> {
  const { data, error } = await deps.supabase
    .from('business_central_customers')
    .select('email')
    .eq('organization_id', deps.orgId)
    .eq('bc_customer_number', customerNumber)
    .limit(1)
    .maybeSingle();
  if (error) return null; // the receipt is a courtesy; never block a charge on it
  const raw = (data as { email: string | null } | null)?.email ?? '';
  return raw.split(/[;,\s]+/).find((e) => EMAIL.test(e)) ?? null;
}

// ---------- guarded writes ----------

/** Updates the payment only while `guard` still holds; returns whether it did. */
async function transition(
  deps: ChargeDeps,
  id: string,
  guard: { status?: string; billcomStates?: string[]; attemptAt?: string | null },
  values: Record<string, unknown>,
): Promise<boolean> {
  let q = deps.supabase.from('card_payments').update(values).eq('id', id).eq('organization_id', deps.orgId);
  if (guard.status) q = q.eq('status', guard.status);
  if (guard.billcomStates) q = q.in('billcom_state', guard.billcomStates);
  if (guard.attemptAt !== undefined) q = guard.attemptAt === null ? q.is('billcom_attempt_at', null) : q.eq('billcom_attempt_at', guard.attemptAt);
  const { data, error } = await q.select('id');
  if (error) throw Object.assign(new Error(`Could not update the card payment: ${error.message}`), { code: error.code });
  return (data ?? []).length > 0;
}

/** Records a Stripe-succeeded payment in Bill.com. Never throws for a Bill.com error: it is stored. */
async function recordInBillcom(deps: ChargeDeps, p: CardPayment, intentId: string, attemptAt: string): Promise<void> {
  // Every write is for this attempt only: a newer attempt (after Check status + Retry) is never overwritten.
  const notStarted = { status: 'succeeded', billcomStates: ['not_started'], attemptAt };
  const client = await deps.billcom().catch(() => null);
  if (!client) {
    await transition(deps, p.id, notStarted, { billcom_state: 'failed', billcom_error: BILLCOM_OFF });
    return;
  }
  const card = await cardOf(deps, p.card_id);
  const cardText = card.brand || card.last4 ? ` (${[card.brand, card.last4 && `•••• ${card.last4}`].filter(Boolean).join(' ')})` : '';
  let paymentId: string | null;
  try {
    ({ paymentId } = await recordBillcomCardPayment(client, {
      billcomInvoiceId: p.billcom_invoice_id,
      customerId: p.billcom_customer_id,
      amount: Number(p.amount),
      paymentDate: businessDate(deps.now()),
      description: `Card payment via Stripe ${intentId}${cardText}`,
    }));
  } catch (e) {
    // Only a Bill.com error means Bill.com was not updated.
    await transition(deps, p.id, notStarted, {
      billcom_state: 'failed',
      billcom_error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  const recordedIn = `Recorded in Bill.com (payment ${paymentId ?? 'id not returned'})`;
  let saved: boolean;
  try {
    saved = await transition(deps, p.id, notStarted, {
      billcom_state: 'recorded',
      billcom_payment_id: paymentId,
      billcom_error: null,
      billcom_recorded_at: deps.now().toISOString(),
    });
  } catch (e) {
    // Bill.com HAS the payment: never mark it failed (a retry would record it twice).
    // The row stays `not_started`; after 10 minutes the panel offers Check status,
    // which moves it to failed, where "I marked it paid in Bill.com" is shown.
    const msg = `${recordedIn} but Nexus could not save that. Do not press Retry: after 10 minutes use Check status, then "I marked it paid in Bill.com". ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[chargeInvoice] card payment ${p.id}: ${msg}`);
    // Best effort: keep Bill.com's payment id on the row (state unchanged) so Retry refuses later.
    if (paymentId) {
      await transition(deps, p.id, notStarted, { billcom_payment_id: paymentId }).catch((e2) =>
        console.error(`[chargeInvoice] card payment ${p.id}: could not note the Bill.com payment ${paymentId} on the row:`, e2),
      );
    }
    throw new Error(msg);
  }
  if (saved) return;

  // The row left `not_started` while Bill.com was recording (e.g. Check status
  // marked it interrupted). Bill.com HAS the payment: say so on the row without
  // changing its state, so staff use "I marked it paid" instead of Retry.
  const msg = `${recordedIn}, but this payment had already changed in Nexus, so that was not saved. Do not press Retry: use "I marked it paid in Bill.com".`;
  console.error(`[chargeInvoice] BILL.COM RECORDED BUT NOT SAVED: card payment ${p.id}, Bill.com payment ${paymentId ?? 'unknown'}. ${msg}`);
  try {
    await transition(deps, p.id, { status: 'succeeded', billcomStates: ['failed'] }, { billcom_payment_id: paymentId, billcom_error: msg });
  } catch (e) {
    console.error(`[chargeInvoice] card payment ${p.id}: could not note the Bill.com payment on the row:`, e);
  }
  throw new Error(msg);
}

/** processing → succeeded, then Bill.com. Only the caller that wins the transition records. */
async function settleSucceeded(deps: ChargeDeps, p: CardPayment, intentId: string): Promise<void> {
  let won: boolean;
  const attemptAt = deps.now().toISOString();
  try {
    // The Bill.com step starts right after this, so its attempt time is set with it.
    won = await transition(deps, p.id, { status: 'processing' }, {
      status: 'succeeded',
      stripe_payment_intent_id: intentId,
      failure_message: null,
      billcom_attempt_at: attemptAt,
    });
  } catch (e) {
    throw new Error(
      `The card was charged in Stripe (${intentId}) but Nexus could not save it. Use Check status. ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (won) {
    await recordInBillcom(deps, { ...p, status: 'succeeded' }, intentId, attemptAt);
    return;
  }
  // Lost the transition. If the row was marked failed meanwhile, money moved anyway: say so loudly.
  const current = await readPayment(deps, p.id);
  if (current.status !== 'failed') return;
  console.error(
    `[chargeInvoice] CARD WAS CHARGED but the row says failed: card payment ${p.id}, intent ${intentId}, amount ${Number(p.amount)} ${p.currency}. Refund or reconcile in Stripe.`,
  );
  if (current.failure_message?.includes(intentId)) return;
  // Charged, not in Bill.com: this state blocks another charge (unique index) until staff resolve it.
  // Never recorded in Bill.com automatically: staff check Stripe first.
  try {
    await transition(deps, p.id, { status: 'failed' }, {
      status: 'succeeded',
      stripe_payment_intent_id: intentId,
      billcom_state: 'failed',
      billcom_error: lateChargeNote(intentId),
      billcom_attempt_at: deps.now().toISOString(),
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== UNIQUE_VIOLATION || !err.message?.includes('card_payments_one_open_per_invoice')) throw e;
    // Another charge for this invoice is open: the customer may have paid twice.
    const note = `Stripe later charged this card (${intentId}) while another charge for this invoice was open — the customer may have been charged twice. Check Stripe and refund one.`;
    await transition(deps, p.id, { status: 'failed' }, {
      failure_message: current.failure_message ? `${current.failure_message} ${note}` : note,
    });
  }
}

function lateChargeNote(intentId: string): string {
  return `${LATE_CHARGE_PREFIX}${intentId}) after Nexus had marked the charge failed. Check Stripe: if this is the only charge for the invoice, press Retry to record it in Bill.com; if the invoice was paid another way, refund this charge in Stripe, then use "I marked it paid in Bill.com".`;
}

async function settleFailed(deps: ChargeDeps, id: string, message: string, intentId: string | null): Promise<void> {
  await transition(deps, id, { status: 'processing' }, {
    status: 'failed',
    failure_message: message,
    ...(intentId ? { stripe_payment_intent_id: intentId } : {}),
  });
}

/** Applies a PaymentIntent's state to a processing row. */
async function applyIntent(deps: ChargeDeps, p: CardPayment, pi: Stripe.PaymentIntent): Promise<void> {
  switch (pi.status) {
    case 'succeeded':
      return settleSucceeded(deps, p, pi.id);
    case 'processing':
      await transition(deps, p.id, { status: 'processing' }, { stripe_payment_intent_id: pi.id });
      return;
    case 'requires_action':
      return settleFailed(deps, p.id, AUTH_REQUIRED_MESSAGE, pi.id);
    default:
      return settleFailed(deps, p.id, pi.last_payment_error?.message || 'The charge did not go through.', pi.id);
  }
}

type StripeErrorLike = { type?: string; code?: string; message?: string; payment_intent?: { id?: string } };

/** A definite "no charge" from Stripe, or null when the outcome is unknown. */
function definiteFailure(e: unknown): { message: string; intentId: string | null } | null {
  const err = (e ?? {}) as StripeErrorLike;
  if (!err.type || !NO_CHARGE_ERRORS.has(err.type)) return null;
  const message = err.code === 'authentication_required' ? AUTH_REQUIRED_MESSAGE : err.message || 'The card was declined.';
  return { message, intentId: err.payment_intent?.id ?? null };
}

// ---------- entry points ----------

async function assess(deps: ChargeDeps, bcInvoiceId: string) {
  const invoice = await deps.loadInvoice(bcInvoiceId);
  if (!invoice) throw new Error('Invoice not found.');
  const card = await activeCard(deps, invoice.customerNumber);
  const stripe = deps.stripeConnectionId ? ('ready' as const) : ('off' as const);
  const status = invoice.status ?? 'live';
  // Bill.com is only asked when nothing before it already rules the charge out.
  const billcom: BillcomLookup =
    deps.canCharge && status === 'live' && stripe === 'ready' && card
      ? await deps.findBillcomInvoice({
          customerNumber: invoice.customerNumber,
          invoiceNumbers: invoice.invoiceNumbers,
          billcomInvoiceId: invoice.billcomInvoiceId,
          bcTotal: invoice.bcTotal ?? null,
          customerName: invoice.customerName ?? null,
        })
      : { kind: 'off' };
  const eligibility = chargeEligibility({ canCharge: deps.canCharge, invoice: status, stripe, card, billcom, today: businessDate(deps.now()) });
  return { invoice, card, billcom, eligibility };
}

/** What the invoice page shows: can it be charged (or why not), the card, and past card payments. */
export async function invoiceChargeView(
  deps: ChargeDeps,
  bcInvoiceId: string,
): Promise<{ eligibility: ChargeEligibility; card: CardLabel | null; payments: CardPaymentRow[] }> {
  const { card, eligibility } = await assess(deps, bcInvoiceId);
  const { data, error } = await deps.supabase
    .from('card_payments')
    .select('*')
    .eq('organization_id', deps.orgId)
    .eq('bc_invoice_id', bcInvoiceId)
    .order('charged_at', { ascending: false });
  if (error) throw new Error(`Could not read the card payments: ${error.message}`);
  const rows = (data ?? []) as CardPayment[];
  const payments = await Promise.all(rows.map((p) => toRow(deps, p)));

  // Resolve who charged / recorded to display names. Names are a nicety: a failed
  // read leaves them off (the UI falls back to "staff") rather than hiding the payments.
  const ids = [
    ...new Set(rows.flatMap((p) => [p.charged_by, p.recorded_manually_by, p.not_charged_by]).filter((x): x is string => Boolean(x))),
  ];
  if (ids.length > 0) {
    const { data: users, error: usersError } = await deps.supabase
      .from('users')
      .select('id, display_name, email')
      .eq('organization_id', deps.orgId)
      .in('id', ids);
    if (usersError) {
      console.error('[chargeInvoice] could not read user names:', usersError.message);
    } else {
      const names = new Map(
        ((users ?? []) as { id: string; display_name: string | null; email: string | null }[]).map((u) => [
          u.id,
          u.display_name?.trim() || u.email || '',
        ]),
      );
      for (const p of payments) {
        const by = names.get(p.chargedBy ?? '');
        const rec = names.get(p.recordedManuallyBy ?? '');
        const notCharged = names.get(p.notChargedBy ?? '');
        if (by) p.chargedByName = by;
        if (rec) p.recordedManuallyByName = rec;
        if (notCharged) p.notChargedByName = notCharged;
      }
    }
  }
  return { eligibility, card, payments };
}

export async function chargeInvoice(
  deps: ChargeDeps,
  a: {
    bcInvoiceId: string;
    userId: string;
    /** The amount (in cents) and card staff saw in the confirm dialog. */
    expectedAmountCents: number;
    cardId: string;
  },
): Promise<CardPaymentRow> {
  const { invoice, card, billcom, eligibility } = await assess(deps, a.bcInvoiceId);
  if (!eligibility.ok) throw new Error(eligibility.reason);
  // Never charge something other than what staff confirmed.
  if (toCents(eligibility.amount) !== a.expectedAmountCents || card?.id !== a.cardId) throw new Error(CHARGE_CHANGED_MESSAGE);
  // Narrowed by eligibility; restated for the type checker.
  if (!card || billcom.kind !== 'found' || !billcom.billcomCustomerId || !deps.stripeConnectionId || !invoice.customerNumber) {
    throw new Error(REASONS.notInBillcom);
  }
  const connectionId = deps.stripeConnectionId;
  const customerNumber = invoice.customerNumber;

  const { data: sc, error: scError } = await deps.supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('organization_id', deps.orgId)
    .eq('stripe_connection_id', connectionId)
    .eq('bc_customer_number', customerNumber)
    .maybeSingle();
  if (scError) throw new Error(`Could not read the Stripe customer: ${scError.message}`);
  const stripeCustomerId = (sc as { stripe_customer_id: string } | null)?.stripe_customer_id;
  if (!stripeCustomerId) throw new Error(REASONS.noCard);

  const stripe = await deps.stripeClient(connectionId);
  const email = await receiptEmail(deps, customerNumber);

  // 1. The row first: the unique index turns a second charge into a 23505 here.
  const { data: inserted, error: insError } = await deps.supabase
    .from('card_payments')
    .insert({
      organization_id: deps.orgId,
      stripe_connection_id: connectionId,
      bc_customer_number: customerNumber,
      sales_order_id: invoice.salesOrderId,
      bc_invoice_id: invoice.bcInvoiceId,
      billcom_invoice_id: billcom.status.id,
      billcom_customer_id: billcom.billcomCustomerId,
      invoice_number: invoice.invoiceNumber,
      amount: eligibility.amount,
      currency: 'usd',
      card_id: card.id,
      status: 'processing',
      billcom_state: 'not_started',
      charged_by: a.userId,
      charged_at: deps.now().toISOString(),
    })
    .select('*')
    .single();
  if (insError) {
    if (insError.code === UNIQUE_VIOLATION) throw new Error(DUPLICATE_CHARGE_MESSAGE);
    throw new Error(`Could not start the charge: ${insError.message}`);
  }
  const payment = inserted as CardPayment;

  // 2. Stripe. The idempotency key makes a repeated request return the same charge.
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: toCents(eligibility.amount),
        currency: 'usd',
        customer: stripeCustomerId,
        payment_method: card.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        ...(email ? { receipt_email: email } : {}),
        description: `Invoice ${invoice.invoiceNumber}`,
        metadata: {
          organization_id: deps.orgId,
          bc_customer_number: customerNumber,
          card_payment_id: payment.id,
          invoice_number: invoice.invoiceNumber,
        },
      },
      { idempotencyKey: payment.id },
    );
  } catch (e) {
    const failure = definiteFailure(e);
    if (failure) await settleFailed(deps, payment.id, failure.message, failure.intentId);
    else console.error(`[chargeInvoice] Stripe outcome unknown for card payment ${payment.id}; left processing:`, e);
    return rowById(deps, payment.id);
  }

  // 3. Save the outcome, then (on success) Bill.com.
  await applyIntent(deps, payment, pi);
  return rowById(deps, payment.id);
}

/**
 * The PaymentIntent of a card payment, read with strongly consistent calls
 * (never Search, which lags): by the stored intent id, else the Stripe
 * customer's intents created since just before the charge, matched on
 * metadata card_payment_id. Uses the connection the charge was made in.
 */
async function findIntent(deps: ChargeDeps, p: CardPayment): Promise<Stripe.PaymentIntent | null> {
  const stripe = await deps.stripeClient(p.stripe_connection_id);
  if (p.stripe_payment_intent_id) return stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);

  const { data: sc, error } = await deps.supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('organization_id', deps.orgId)
    .eq('stripe_connection_id', p.stripe_connection_id)
    .eq('bc_customer_number', p.bc_customer_number)
    .maybeSingle();
  if (error) throw new Error(`Could not read the Stripe customer: ${error.message}`);
  const customer = (sc as { stripe_customer_id: string } | null)?.stripe_customer_id;
  // chargeInvoice never calls Stripe without a Stripe customer, so none means no charge was sent.
  if (!customer) return null;

  const gte = Math.floor(new Date(p.charged_at).getTime() / 1000) - LIST_LOOKBACK_SECONDS;
  const matches: Stripe.PaymentIntent[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; ; page++) {
    if (page === LIST_MAX_PAGES) throw new Error('Too many Stripe payments to check; look this charge up in the Stripe dashboard.');
    const res = await stripe.paymentIntents.list({
      customer,
      created: { gte },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const list = res.data ?? [];
    matches.push(...list.filter((i) => i.metadata?.card_payment_id === p.id));
    if (!res.has_more || list.length === 0) break;
    startingAfter = list[list.length - 1].id;
  }
  return matches.find((i) => i.status === 'succeeded') ?? matches[0] ?? null;
}

/**
 * Settles a `processing` row from Stripe. Never charges and never fails a
 * charge on its own: when Stripe has no matching payment the row stays
 * `processing` (stripeLookup 'not_found') until staff use markNotCharged.
 */
export async function checkChargeStatus(deps: ChargeDeps, cardPaymentId: string): Promise<CardPaymentRow> {
  const p = await readPayment(deps, cardPaymentId);

  // Measured from the current Bill.com attempt, so a fresh Retry is never cut off.
  if (isBillcomStuck(deps, p)) {
    // Only the attempt this check looked at: a Retry started since then is left alone.
    await transition(deps, p.id, { status: 'succeeded', billcomStates: ['not_started'], attemptAt: p.billcom_attempt_at ?? null }, {
      billcom_state: 'failed',
      billcom_error: BILLCOM_INTERRUPTED,
    });
    return rowById(deps, p.id);
  }
  if (p.status !== 'processing') return toRow(deps, p);

  const pi = await findIntent(deps, p);
  if (!pi) return { ...(await toRow(deps, p)), stripeLookup: 'not_found' };
  await applyIntent(deps, p, pi);
  return rowById(deps, p.id);
}

/**
 * Staff confirm a `processing` charge never happened. Checks Stripe first:
 * if a payment exists the row is settled from it and this refuses.
 */
export async function markNotCharged(deps: ChargeDeps, cardPaymentId: string, userId: string): Promise<CardPaymentRow> {
  const p = await readPayment(deps, cardPaymentId);
  if (p.status !== 'processing') throw new Error(NOT_PROCESSING);
  if (deps.now().getTime() - new Date(p.charged_at).getTime() < NOT_CHARGED_MIN_AGE_MS) throw new Error(TOO_SOON_FOR_NOT_CHARGED);
  const pi = await findIntent(deps, p);
  if (pi) {
    await applyIntent(deps, p, pi);
    const settled = await rowById(deps, p.id);
    // Stripe itself says it failed: that is the answer staff wanted.
    if (settled.status === 'failed') return settled;
    throw new Error(INTENT_EXISTS);
  }
  const done = await transition(deps, p.id, { status: 'processing' }, {
    status: 'failed',
    failure_message: MARKED_NOT_CHARGED_MESSAGE,
    not_charged_by: userId,
    not_charged_at: deps.now().toISOString(),
  });
  if (!done) throw new Error(NOT_PROCESSING);
  return rowById(deps, p.id);
}

export async function retryBillcomRecord(deps: ChargeDeps, cardPaymentId: string): Promise<CardPaymentRow> {
  const p = await readPayment(deps, cardPaymentId);
  if (p.status !== 'succeeded' || p.billcom_state !== 'failed') throw new Error(NOT_RETRYABLE);
  if (p.billcom_payment_id) throw new Error(billcomAlreadyHas(p.billcom_payment_id));
  const client = await deps.billcom().catch(() => null);
  if (!client) throw new Error(BILLCOM_OFF);
  // Bill.com may already have it (recorded, then Nexus failed to save): only record while
  // Bill.com still shows at least this payment owing on this exact invoice.
  const lookup = await deps
    .findBillcomInvoice({
      customerNumber: p.bc_customer_number,
      invoiceNumbers: [p.invoice_number],
      billcomInvoiceId: p.billcom_invoice_id,
      // This payment's own invoice, found by a checked lookup when it was charged.
      trustBillcomInvoiceId: true,
    })
    .catch(() => null);
  const due = lookup?.kind === 'found' && lookup.status.id === p.billcom_invoice_id ? lookup.status.dueAmount : null;
  if (due === null || due === undefined) throw new Error(RETRY_CANNOT_CHECK);
  if (toCents(due) < toCents(Number(p.amount))) {
    throw new Error(p.billcom_error?.startsWith(LATE_CHARGE_PREFIX) ? RETRY_LESS_OWING_LATE : RETRY_LESS_OWING);
  }
  // Claim it (failed → not_started) so two clicks cannot both record it.
  const attemptAt = deps.now().toISOString();
  const claimed = await transition(deps, p.id, { status: 'succeeded', billcomStates: ['failed'] }, {
    billcom_state: 'not_started',
    billcom_error: null,
    billcom_attempt_at: attemptAt,
  });
  if (!claimed) throw new Error(NOT_RETRYABLE);
  await recordInBillcom(deps, { ...p, billcom_state: 'not_started' }, p.stripe_payment_intent_id ?? '', attemptAt);
  return rowById(deps, p.id);
}

export async function markRecordedManually(deps: ChargeDeps, cardPaymentId: string, userId: string): Promise<CardPaymentRow> {
  const p = await readPayment(deps, cardPaymentId);
  if (p.status !== 'succeeded' || p.billcom_state !== 'failed') throw new Error(NOT_MANUAL);
  const done = await transition(deps, p.id, { status: 'succeeded', billcomStates: ['failed'] }, {
    billcom_state: 'recorded_manually',
    recorded_manually_by: userId,
    billcom_recorded_at: deps.now().toISOString(),
  });
  if (!done) throw new Error(NOT_MANUAL);
  return rowById(deps, p.id);
}
