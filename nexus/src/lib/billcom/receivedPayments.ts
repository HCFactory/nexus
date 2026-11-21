// Bill.com payments received (GET /v3/receivable-payments): stored in Nexus so
// each invoice can list its payments and how they were paid. Read in pages of
// payments changed since the last run, like the payment-status step.
import type { SyncEntityResult } from '@/lib/businessCentral/syncRunner';

import { BillcomRateLimitError } from './errors';

/** A payment as Bill.com lists it (fields seen on production). */
export interface BillcomReceivedPayment {
  id: string;
  customerId?: string | null;
  paymentDate?: string | null;
  amount?: number | null;
  unappliedAmount?: number | null;
  convenienceFeeAmount?: number | null;
  /** ACH, CHECK, CASH, CREDIT_CARD, OTHER… */
  receivablesType?: string | null;
  /** PAID or CANCELED. */
  status?: string | null;
  referenceNumber?: string | null;
  onlinePayment?: boolean | null;
  receivablesAccount?: { id?: string; type?: string; bankName?: string | null; accountNumber?: string | null } | null;
  invoicePayments?: { invoiceId: string; amount?: number | null; paymentDate?: string | null; status?: string | null; receivedPaymentId?: string | null }[] | null;
  createdTime?: string | null;
  updatedTime?: string | null;
}

export interface StoredPaymentRow {
  billcom_payment_id: string;
  billcom_customer_id: string | null;
  payment_date: string | null;
  amount: number | null;
  unapplied_amount: number | null;
  convenience_fee: number | null;
  receivables_type: string | null;
  online_payment: boolean | null;
  reference_number: string | null;
  status: string | null;
  deposit_bank_name: string | null;
  deposit_account_last4: string | null;
  billcom_created_time: string | null;
  billcom_updated_time: string | null;
}

export interface StoredApplicationRow {
  billcom_invoice_id: string;
  amount: number | null;
  payment_date: string | null;
  status: string | null;
  received_payment_id: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const date = (v: unknown): string | null => text(v)?.slice(0, 10) ?? null;

/** A Bill.com payment as Nexus stores it; only the last 4 digits of the deposit account. */
export function toStoredPayment(p: BillcomReceivedPayment): { payment: StoredPaymentRow; applications: StoredApplicationRow[] } {
  const digits = (p.receivablesAccount?.accountNumber ?? '').replace(/\D/g, '');
  return {
    payment: {
      billcom_payment_id: p.id,
      billcom_customer_id: text(p.customerId),
      payment_date: date(p.paymentDate),
      amount: num(p.amount),
      unapplied_amount: num(p.unappliedAmount),
      convenience_fee: num(p.convenienceFeeAmount),
      receivables_type: text(p.receivablesType),
      online_payment: typeof p.onlinePayment === 'boolean' ? p.onlinePayment : null,
      reference_number: text(p.referenceNumber),
      status: text(p.status),
      deposit_bank_name: text(p.receivablesAccount?.bankName),
      deposit_account_last4: digits ? digits.slice(-4) : null,
      billcom_created_time: text(p.createdTime),
      billcom_updated_time: text(p.updatedTime),
    },
    applications: (p.invoicePayments ?? [])
      .filter((a) => text(a?.invoiceId))
      .map((a) => ({
        billcom_invoice_id: a.invoiceId,
        amount: num(a.amount),
        payment_date: date(a.paymentDate),
        status: text(a.status),
        received_payment_id: text(a.receivedPaymentId),
      })),
  };
}

export interface BillcomReceivedPaymentsSyncDeps {
  listChanged(since: string | null, page: string | undefined): Promise<{ results?: BillcomReceivedPayment[]; nextPage?: string }>;
  /** Saves payments and replaces each one's invoice applications. */
  save(rows: ReturnType<typeof toStoredPayment>[]): Promise<void>;
  readCheckpoint(): Promise<{ cursor_value: string | null; records_synced: number } | null>;
  writeCheckpoint(patch: { cursor_value: string | null; records_synced: number; last_error: string | null; complete: boolean }): Promise<void>;
  nowMs(): number;
}

const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** One round: payments changed since the saved cursor, within the time budget. Never throws. */
export async function syncBillcomReceivedPayments(deps: BillcomReceivedPaymentsSyncDeps, budgetMs: number): Promise<SyncEntityResult> {
  const started = deps.nowMs();
  let saved: { cursor_value: string | null; records_synced: number } | null = null;
  let cursor: string | null = null;
  let stored = 0;
  const result = (complete: boolean, error: string | null): SyncEntityResult => ({ entityType: 'billcom_received_payment', recordsSynced: stored, complete, cursor, error });
  const checkpoint = (complete: boolean, error: string | null) =>
    deps.writeCheckpoint({ cursor_value: cursor, records_synced: (saved?.records_synced ?? 0) + stored, last_error: error, complete });
  // Never further than a day ago: recent changes are read again next run.
  const capped = (t: string) => {
    const limit = deps.nowMs() - LOOKBACK_MS;
    const at = Date.parse(t);
    return Number.isFinite(at) && at > limit ? new Date(limit).toISOString() : t;
  };

  try {
    saved = await deps.readCheckpoint();
    cursor = saved?.cursor_value ?? null;
    const since = cursor;
    let page: string | undefined;
    for (;;) {
      if (deps.nowMs() - started >= budgetMs) return result(false, null);
      const res = await deps.listChanged(since, page);
      const payments = (res.results ?? []).filter((p) => p?.id);
      if (payments.length > 0) {
        await deps.save(payments.map(toStoredPayment));
        stored += payments.length;
      }
      const last = payments.at(-1)?.updatedTime;
      if (last) cursor = capped(last);
      page = res.nextPage || undefined;
      if (!page) {
        await checkpoint(true, null);
        return result(true, null);
      }
      await checkpoint(false, null);
    }
  } catch (e) {
    if (e instanceof BillcomRateLimitError) {
      await checkpoint(false, null).catch(() => undefined);
      return result(false, null);
    }
    const message = e instanceof Error ? e.message : String(e);
    await checkpoint(false, message).catch(() => undefined);
    return result(false, message);
  }
}
