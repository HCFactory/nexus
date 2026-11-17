import type { BillcomClient } from './client';
import { BillcomApiError } from './errors';

const PAGE = 100;
const MAX_PAGES = 50;

/** Bill.com 422 BDC_1171: an invoice with this number already exists. */
export class BillcomDuplicateInvoiceError extends BillcomApiError {
  constructor(source: BillcomApiError) {
    super(source.details);
    this.name = 'BillcomDuplicateInvoiceError';
  }
}

/** What Nexus checks on a Bill.com invoice: its id, total and number of lines. */
export interface BillcomInvoiceSummary {
  id: string;
  /** null when Bill.com didn't return it. */
  totalAmount: number | null;
  lineCount: number | null;
}

type RawInvoice = { id: string; invoiceNumber?: string; totalAmount?: unknown; invoiceLineItems?: unknown };

const summaryOf = (r: RawInvoice): BillcomInvoiceSummary => ({
  id: r.id,
  totalAmount: typeof r.totalAmount === 'number' && Number.isFinite(r.totalAmount) ? r.totalAmount : null,
  lineCount: Array.isArray(r.invoiceLineItems) ? r.invoiceLineItems.length : null,
});

const cents = (n: number) => Math.round(n * 100);
const plural = (n: number) => `${n} line${n === 1 ? '' : 's'}`;

/**
 * Why `invoice` isn't the invoice `payload` describes (different total or
 * number of lines), or null when it matches. A found or just-created invoice
 * is only accepted when it matches, so a partial or hand-made invoice with the
 * same number is never recorded as done.
 */
export function billcomInvoiceMismatch(invoice: BillcomInvoiceSummary, payload: Record<string, unknown>): string | null {
  const items = (payload.invoiceLineItems as Array<{ quantity: number; price: number }> | undefined) ?? [];
  const expectedCents = items.reduce((sum, i) => sum + cents(i.quantity * i.price), 0);
  if (
    invoice.totalAmount !== null &&
    invoice.lineCount !== null &&
    cents(invoice.totalAmount) === expectedCents &&
    invoice.lineCount === items.length
  ) {
    return null;
  }
  const has = invoice.totalAmount === null ? 'an unknown total' : `$${invoice.totalAmount.toFixed(2)}`;
  const lines = invoice.lineCount === null ? 'unknown lines' : plural(invoice.lineCount);
  return (
    `Bill.com invoice ${String(payload.invoiceNumber)} doesn't match: it has ${has} in ${lines}, ` +
    `expected $${(expectedCents / 100).toFixed(2)} in ${plural(items.length)}. Fix or delete it in Bill.com, then Retry.`
  );
}

/** The customer's Bill.com invoice with exactly this invoice number, or null. */
export async function findBillcomInvoice(
  client: BillcomClient,
  customerId: string,
  invoiceNumber: string,
): Promise<BillcomInvoiceSummary | null> {
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ filters: `customerId:eq:${customerId}`, max: String(PAGE) });
    if (page) qs.set('page', page);
    const res = await client.request<{ results?: RawInvoice[]; nextPage?: string }>(`/v3/invoices?${qs.toString()}`);
    const hit = (res.results ?? []).find((r) => r.invoiceNumber === invoiceNumber);
    if (hit) return summaryOf(hit);
    page = res.nextPage || undefined;
    if (!page) return null;
  }
  throw new Error(`Bill.com invoice list has more than ${MAX_PAGES} pages.`);
}

/** Creates the invoice and returns what Bill.com saved. Throws BillcomDuplicateInvoiceError on BDC_1171. */
export async function createBillcomInvoice(
  client: BillcomClient,
  payload: Record<string, unknown>,
): Promise<BillcomInvoiceSummary> {
  try {
    const res = await client.request<RawInvoice>('/v3/invoices', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return summaryOf(res);
  } catch (err) {
    if (err instanceof BillcomApiError && err.details.status === 422 && err.details.code === 'BDC_1171') {
      throw new BillcomDuplicateInvoiceError(err);
    }
    throw err;
  }
}

/**
 * Replaces the invoice's content (lines, total) keeping its id. Bill.com's PUT
 * needs the full invoice; lines left out are removed (measured, sandbox).
 */
export async function replaceBillcomInvoice(
  client: BillcomClient,
  id: string,
  payload: Record<string, unknown>,
): Promise<BillcomInvoiceSummary> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { processingOptions, ...body } = payload;
  const res = await client.request<RawInvoice>(`/v3/invoices/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return summaryOf(res);
}

/**
 * The customer's invoice with the payload's number, created when there is
 * none. A "duplicate number" answer is resolved by finding it again; if it
 * still can't be found, the duplicate error is thrown.
 */
export async function findOrCreateBillcomInvoice(
  client: BillcomClient,
  customerId: string,
  payload: Record<string, unknown>,
): Promise<BillcomInvoiceSummary> {
  const invoiceNumber = String(payload.invoiceNumber);
  const found = await findBillcomInvoice(client, customerId, invoiceNumber);
  if (found) return found;
  try {
    return await createBillcomInvoice(client, payload);
  } catch (e) {
    if (!(e instanceof BillcomDuplicateInvoiceError)) throw e;
    const raced = await findBillcomInvoice(client, customerId, invoiceNumber);
    if (!raced) throw e;
    return raced;
  }
}
