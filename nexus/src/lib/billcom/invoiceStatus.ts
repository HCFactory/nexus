import type { BillcomClient } from './client';

const PAGE = 100;
const MAX_PAGES = 50;

/** What the invoice page shows about the Bill.com side of an invoice. */
export interface BillcomInvoiceStatus {
  id: string;
  invoiceNumber: string;
  /** Bill.com's raw status, e.g. "OPEN". */
  status: string;
  statusLabel: string;
  totalAmount: number | null;
  dueAmount: number | null;
  dueDate: string | null;
  /** The Bill.com customer the invoice belongs to, when Bill.com says. */
  customerId?: string | null;
}

type RawInvoice = {
  id: string;
  invoiceNumber?: string;
  status?: string;
  totalAmount?: unknown;
  dueAmount?: unknown;
  dueDate?: string | null;
  customerId?: string | null;
};

const LABELS: Record<string, string> = {
  OPEN: 'Open',
  PARTIALLY_PAID: 'Partially paid',
  PAID_IN_FULL: 'Paid',
  VOID: 'Void',
};

/** A rep-friendly label for a Bill.com invoice status; unknown values are tidied ("SOME_STATE" → "Some state"). */
export function billcomStatusLabel(status: string): string {
  if (LABELS[status]) return LABELS[status];
  const words = status.toLowerCase().replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toStatus(r: RawInvoice): BillcomInvoiceStatus {
  const status = r.status ?? '';
  return {
    id: r.id,
    invoiceNumber: r.invoiceNumber ?? '',
    status,
    statusLabel: status ? billcomStatusLabel(status) : 'Unknown',
    totalAmount: num(r.totalAmount),
    dueAmount: num(r.dueAmount),
    dueDate: r.dueDate ?? null,
    ...(r.customerId ? { customerId: r.customerId } : {}),
  };
}

/**
 * The Bill.com invoice for a BC invoice: by Bill.com id when known; else among
 * the customer's invoices, by exact number in `invoiceNumbers` order (Invoice #,
 * then BC Invoice No.). A number shared by several Bill.com invoices (BC copies
 * the order's Invoice # onto every invoice of a partly invoiced order) is never
 * guessed: the next number is tried, and 'ambiguous' is returned when no number
 * matches exactly one invoice. null when nothing matches.
 */
export async function readBillcomInvoiceStatus(
  client: BillcomClient,
  q: { billcomInvoiceId?: string | null; billcomCustomerId?: string | null; invoiceNumbers: string[] },
): Promise<BillcomInvoiceStatus | 'ambiguous' | null> {
  if (q.billcomInvoiceId) {
    return toStatus(await client.request<RawInvoice>(`/v3/invoices/${encodeURIComponent(q.billcomInvoiceId)}`));
  }
  const numbers = q.invoiceNumbers.map((n) => n.trim()).filter(Boolean);
  if (!q.billcomCustomerId || numbers.length === 0) return null;

  // All pages are read: a duplicate can sit on a later page.
  const matches: RawInvoice[][] = numbers.map(() => []);
  let page: string | undefined;
  for (let i = 0; ; i++) {
    if (i === MAX_PAGES) throw new Error(`Bill.com invoice list has more than ${MAX_PAGES} pages.`);
    const qs = new URLSearchParams({ filters: `customerId:eq:${q.billcomCustomerId}`, max: String(PAGE) });
    if (page) qs.set('page', page);
    const res = await client.request<{ results?: RawInvoice[]; nextPage?: string }>(`/v3/invoices?${qs.toString()}`);
    for (const r of res.results ?? []) {
      const rank = numbers.indexOf((r.invoiceNumber ?? '').trim());
      if (rank >= 0) matches[rank].push(r);
    }
    page = res.nextPage || undefined;
    if (!page) break;
  }

  let ambiguous = false;
  for (const found of matches) {
    if (found.length === 1) return toStatus(found[0]);
    if (found.length > 1) ambiguous = true;
  }
  return ambiguous ? 'ambiguous' : null;
}

const toCents = (n: unknown) => Math.round(Number(n) * 100);
const sameName = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(a) !== '' && norm(a) === norm(b);
};

/**
 * Connector mode (Bill.com's own BC connector copied the invoice): find the
 * Bill.com invoice directly by number, the BC External Doc. No. first, then the
 * BC invoice no. A match needs exactly one invoice with the number AND the same
 * total (to the cent) AND the same customer name (ignoring case, spaces and
 * punctuation); otherwise 'mismatch', which is never charged. Production
 * checks (2026-11-19): numbers, totals and names agreed 15/15.
 */
export async function findConnectorInvoice(
  client: BillcomClient,
  q: { invoiceNumbers: string[]; bcTotal: number | null; customerName: string | null },
): Promise<{ kind: 'found'; status: BillcomInvoiceStatus } | { kind: 'ambiguous' | 'mismatch' | 'not_found' }> {
  let ambiguous = false;
  for (const n of q.invoiceNumbers.map((x) => x.trim()).filter(Boolean)) {
    const qs = new URLSearchParams({ filters: `invoiceNumber:eq:${n}`, max: '5' });
    const res = await client.request<{ results?: RawInvoice[] }>(`/v3/invoices?${qs.toString()}`);
    const hits = (res.results ?? []).filter((r) => (r.invoiceNumber ?? '').trim() === n);
    if (hits.length > 1) {
      ambiguous = true;
      continue;
    }
    if (hits.length === 0) continue;
    const inv = hits[0];
    if (q.bcTotal === null || toCents(inv.totalAmount) !== toCents(q.bcTotal) || !inv.customerId || !q.customerName) return { kind: 'mismatch' };
    const customer = await client.request<{ name?: string }>(`/v3/customers/${encodeURIComponent(inv.customerId)}`);
    if (!sameName(customer.name ?? '', q.customerName)) return { kind: 'mismatch' };
    return { kind: 'found', status: toStatus(inv) };
  }
  return { kind: ambiguous ? 'ambiguous' : 'not_found' };
}

/** The invoice page's Bill.com panel: what was found, or why nothing is shown. */
export type BillcomPanel =
  | { kind: 'found'; status: BillcomInvoiceStatus }
  | { kind: 'off' }
  | { kind: 'not_linked' }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }
  | { kind: 'mismatch' }
  | { kind: 'error'; message: string };
