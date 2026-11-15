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

/** Id of the customer's Bill.com invoice with exactly this invoice number, or null. */
export async function findBillcomInvoice(
  client: BillcomClient,
  customerId: string,
  invoiceNumber: string,
): Promise<string | null> {
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ filters: `customerId:eq:${customerId}`, max: String(PAGE) });
    if (page) qs.set('page', page);
    const res = await client.request<{ results?: Array<{ id: string; invoiceNumber?: string }>; nextPage?: string }>(
      `/v3/invoices?${qs.toString()}`,
    );
    const hit = (res.results ?? []).find((r) => r.invoiceNumber === invoiceNumber);
    if (hit) return hit.id;
    page = res.nextPage || undefined;
    if (!page) return null;
  }
  throw new Error(`Bill.com invoice list has more than ${MAX_PAGES} pages.`);
}

/** Creates the invoice and returns its Bill.com id. Throws BillcomDuplicateInvoiceError on BDC_1171. */
export async function createBillcomInvoice(client: BillcomClient, payload: Record<string, unknown>): Promise<string> {
  try {
    const res = await client.request<{ id: string }>('/v3/invoices', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return res.id;
  } catch (err) {
    if (err instanceof BillcomApiError && err.details.status === 422 && err.details.code === 'BDC_1171') {
      throw new BillcomDuplicateInvoiceError(err);
    }
    throw err;
  }
}
