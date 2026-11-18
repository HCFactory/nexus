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

/** The invoice page's Bill.com panel: what was found, or why nothing is shown. */
export type BillcomPanel =
  | { kind: 'found'; status: BillcomInvoiceStatus }
  | { kind: 'off' }
  | { kind: 'not_linked' }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' }
  | { kind: 'error'; message: string };
