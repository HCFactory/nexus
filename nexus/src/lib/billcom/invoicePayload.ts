import { effectiveDiscount, effectivePrice } from '@/lib/salesOrders/lineAmounts';
import type { PostedInvoice } from '@/lib/salesOrders/bcInvoicing';
import type { LineDraft } from '@/types/salesOrders';

export type InvoiceSourceLine = Pick<
  LineDraft,
  'item_number' | 'description' | 'quantity' | 'unit_price' | 'bc_unit_price' | 'discount_percent' | 'bc_line_discount_percent'
> &
  Partial<Pick<LineDraft, 'estimate_price' | 'estimate_discount_percent'>>;

export interface BillcomInvoiceInput {
  billcomCustomerId: string;
  invoiceNumber: string;
  posted: PostedInvoice;
  lines: InvoiceSourceLine[];
}

export type BillcomInvoiceBuild = { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const cents = (n: number) => Math.round(n * 100);
/** Up to the next whole cent; float noise (e.g. 4.5 * 100 = 450.00000000000006) is removed first. */
const ceil2 = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;

/**
 * Bill.com invoice payload from BC's posted invoice. Bill.com has no PO field
 * (the Invoice # carries it) and takes tax only as a rate item, so tax is a
 * non-taxable "Sales tax" line at BC's posted amount.
 *
 * Each line is the real quantity at the unit price after discount, rounded UP
 * to the next cent (user decision 2026-11-15). When the discounted unit price
 * has fractions of a cent (3 @ $1.0925), Bill.com's line ($3.30) is then a few
 * cents above BC's ($3.28), so the Bill.com total can be above BC's posted
 * total by that rounding only. The safety check is on the order's own line
 * amounts as BC computes them: they plus tax must equal BC's posted total.
 */
export function buildBillcomInvoice(input: BillcomInvoiceInput): BillcomInvoiceBuild {
  const { posted } = input;
  const items: Array<{ description: string; quantity: number; price: number }> = [];
  let bcSumCents = 0;

  for (const l of input.lines) {
    const price = effectivePrice(l) ?? 0;
    const disc = effectiveDiscount(l);
    // As BC computes a line: gross rounded to the cent, less the discount amount rounded on its own.
    const gross = round2(l.quantity * price);
    bcSumCents += cents(gross) - cents(round2((gross * disc) / 100));
    items.push({
      description: `${l.item_number} ${l.description}`.trim(),
      quantity: l.quantity,
      price: ceil2(price * (1 - disc / 100)),
    });
  }

  if (posted.totalTax !== 0) {
    items.push({ description: 'Sales tax', quantity: 1, price: posted.totalTax });
    bcSumCents += cents(posted.totalTax);
  }

  if (bcSumCents !== cents(posted.totalInclTax)) {
    return {
      ok: false,
      error: `The order's lines and tax total $${(bcSumCents / 100).toFixed(2)}, but BC's posted total is $${round2(posted.totalInclTax).toFixed(2)}.`,
    };
  }

  const payload: Record<string, unknown> = {
    customer: { id: input.billcomCustomerId },
    invoiceNumber: input.invoiceNumber,
    invoiceDate: posted.invoiceDate,
    ...(posted.dueDate ? { dueDate: posted.dueDate } : {}),
    processingOptions: { sendEmail: false },
    invoiceLineItems: items,
  };
  return { ok: true, payload };
}
