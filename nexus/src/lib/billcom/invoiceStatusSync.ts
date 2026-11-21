import type { SyncEntityResult } from '@/lib/businessCentral/syncRunner';

import { BillcomRateLimitError } from './errors';
import { sameName, toCents } from './invoiceStatus';

/** A Bill.com invoice as `GET /v3/invoices` lists it (only the fields used here). */
export interface BillcomListInvoice {
  id: string;
  invoiceNumber?: string;
  customerName?: string;
  totalAmount?: unknown;
  dueAmount?: unknown;
  dueDate?: string | null;
  status?: string;
  updatedTime?: string;
  archived?: boolean;
}

/** A Nexus (BC) sales invoice, as much as matching needs. */
export interface NexusInvoiceRef {
  bc_invoice_id: string;
  external_document_number: string | null;
  bc_invoice_number: string | null;
  customer_name: string | null;
  total_amount_including_tax: number | null;
}

export interface StoredStatusRow {
  bc_invoice_id: string;
  match: 'found' | 'mismatch';
  billcom_invoice_id: string;
  status: string | null;
  total_amount: number | null;
  due_amount: number | null;
  due_date: string | null;
  billcom_updated_time: string | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const trim = (v: string | null | undefined) => (v ?? '').trim();

/**
 * Match Bill.com invoices (copied there by Bill.com's BC connector) to Nexus
 * invoices: Bill.com invoice number = BC External Doc. No. (else the BC invoice
 * no.), with the same total to the cent and the same customer name.
 * - Exactly one qualifying Nexus invoice: 'found' with Bill.com's status.
 * - Several BC invoices share the number (a partly invoiced order): each one
 *   matches by its own total and name; still unclear (equal totals) = skipped.
 * - The number's only Nexus invoice fails the checks: 'mismatch', so a stale
 *   "Paid" never lingers after an edit in Bill.com.
 * Archived Bill.com invoices are skipped.
 */
export function matchBillcomInvoices(bills: BillcomListInvoice[], invoices: NexusInvoiceRef[]): StoredStatusRow[] {
  const proposed = new Map<string, { bill: BillcomListInvoice; match: 'found' | 'mismatch' }[]>();
  for (const b of bills) {
    const n = trim(b.invoiceNumber);
    if (!n || b.archived) continue;
    let candidates = invoices.filter((i) => trim(i.external_document_number) === n);
    if (candidates.length === 0) candidates = invoices.filter((i) => trim(i.bc_invoice_number) === n);
    if (candidates.length === 0) continue;
    const qualifying = candidates.filter(
      (i) => i.total_amount_including_tax !== null && toCents(i.total_amount_including_tax) === toCents(b.totalAmount) && sameName(i.customer_name ?? '', b.customerName ?? ''),
    );
    const target = qualifying.length === 1 ? { inv: qualifying[0], match: 'found' as const } : qualifying.length === 0 && candidates.length === 1 ? { inv: candidates[0], match: 'mismatch' as const } : null;
    if (!target) continue;
    const list = proposed.get(target.inv.bc_invoice_id) ?? [];
    list.push({ bill: b, match: target.match });
    proposed.set(target.inv.bc_invoice_id, list);
  }
  const rows: StoredStatusRow[] = [];
  for (const [bcInvoiceId, list] of proposed) {
    const found = list.filter((x) => x.match === 'found');
    // Two Bill.com invoices both claiming one Nexus invoice: unclear, leave it to the live check.
    if (found.length > 1) continue;
    const pick = found[0] ?? (list.length === 1 ? list[0] : null);
    if (!pick) continue;
    const b = pick.bill;
    rows.push(
      pick.match === 'found'
        ? { bc_invoice_id: bcInvoiceId, match: 'found', billcom_invoice_id: b.id, status: b.status ?? null, total_amount: num(b.totalAmount), due_amount: num(b.dueAmount), due_date: b.dueDate ?? null, billcom_updated_time: b.updatedTime ?? null }
        : { bc_invoice_id: bcInvoiceId, match: 'mismatch', billcom_invoice_id: b.id, status: null, total_amount: null, due_amount: null, due_date: null, billcom_updated_time: b.updatedTime ?? null },
    );
  }
  return rows;
}

export interface StoredRef {
  bc_invoice_id: string;
  match: 'found' | 'mismatch';
  billcom_invoice_id: string | null;
}

/**
 * A 'mismatch' never replaces a 'found' match that came from a different
 * Bill.com invoice: another Bill.com invoice that merely shares the number (a
 * duplicate, a void copy, another customer's PO) must not hide a good match.
 */
export function guardMismatches(rows: StoredStatusRow[], existing: StoredRef[]): StoredStatusRow[] {
  const byInvoice = new Map(existing.map((e) => [e.bc_invoice_id, e]));
  return rows.filter((r) => {
    if (r.match === 'found') return true;
    const prev = byInvoice.get(r.bc_invoice_id);
    return !(prev && prev.match === 'found' && prev.billcom_invoice_id !== r.billcom_invoice_id);
  });
}

/** Changes are re-read for this long, so an invoice that reached Nexus after its Bill.com copy changed still gets matched. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface BillcomInvoiceStatusSyncDeps {
  /** Bill.com invoices changed at or after `since` (null = from the start), oldest first; `page` continues a listing. */
  listChanged(since: string | null, page: string | undefined): Promise<{ results: BillcomListInvoice[]; nextPage?: string }>;
  /** Nexus invoices of this environment whose External Doc. No. or BC invoice no. is one of `numbers`; truncated = cut off at the row cap. */
  findNexusInvoices(numbers: string[]): Promise<{ invoices: NexusInvoiceRef[]; truncated: boolean }>;
  /** What is stored now for these BC invoices. */
  readStored(bcInvoiceIds: string[]): Promise<StoredRef[]>;
  upsert(rows: StoredStatusRow[]): Promise<void>;
  /** Remove stored statuses that came from these Bill.com invoices (archived there). */
  removeByBillcomIds(billcomInvoiceIds: string[]): Promise<void>;
  readCheckpoint(): Promise<{ cursor_value: string | null; records_synced: number } | null>;
  writeCheckpoint(patch: { cursor_value: string | null; records_synced: number; last_error: string | null; complete: boolean }): Promise<void>;
  nowMs(): number;
}

/**
 * The Customers & Receivables step that stores Bill.com payment status: reads
 * Bill.com invoices changed since the last run (the first run walks them all;
 * every run re-reads the last day), matches them and saves the result. Checks
 * the clock before each Bill.com request; stops when out of time or
 * rate-limited (progress kept; the next sync continues). Never throws.
 */
export async function syncBillcomInvoiceStatus(deps: BillcomInvoiceStatusSyncDeps, budgetMs: number): Promise<SyncEntityResult> {
  const started = deps.nowMs();
  let saved: { cursor_value: string | null; records_synced: number } | null = null;
  let cursor: string | null = null;
  let stored = 0;
  const result = (complete: boolean, error: string | null): SyncEntityResult => ({ entityType: 'billcom_invoice_status', recordsSynced: stored, complete, cursor, error });
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
      const bills = res.results ?? [];
      const archived = bills.filter((b) => b.archived).map((b) => b.id);
      if (archived.length > 0) await deps.removeByBillcomIds(archived);
      const numbers = [...new Set(bills.map((b) => trim(b.invoiceNumber)).filter(Boolean))];
      if (numbers.length > 0) {
        const found = await deps.findNexusInvoices(numbers);
        let rows = matchBillcomInvoices(bills, found.invoices);
        // A cut-off lookup may have left out the right invoice: only store matches then.
        if (found.truncated) rows = rows.filter((r) => r.match === 'found');
        if (rows.some((r) => r.match === 'mismatch')) rows = guardMismatches(rows, await deps.readStored(rows.map((r) => r.bc_invoice_id)));
        if (rows.length > 0) await deps.upsert(rows);
        stored += rows.length;
      }
      const last = bills.at(-1)?.updatedTime;
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
      // Bill.com asked us to slow down: keep the progress, the next sync continues.
      await checkpoint(false, null).catch(() => undefined);
      return result(false, null);
    }
    const message = e instanceof Error ? e.message : String(e);
    await checkpoint(false, message).catch(() => undefined);
    return result(false, message);
  }
}
