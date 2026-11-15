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

/**
 * Bill.com invoice payload from BC's posted invoice. Bill.com has no PO field
 * (the Invoice # carries it) and takes tax only as a rate item, so tax is a
 * non-taxable "Sales tax" line at BC's posted amount. Each line is cent-exact:
 * qty x unit when the rounded unit price reproduces BC's line amount, else a
 * single line at the amount with the real qty and unit price in the description.
 */
export function buildBillcomInvoice(input: BillcomInvoiceInput): BillcomInvoiceBuild {
  const { posted } = input;
  const items: Array<{ description: string; quantity: number; price: number }> = [];
  let sumCents = 0;

  for (const l of input.lines) {
    const price = effectivePrice(l) ?? 0;
    const disc = effectiveDiscount(l);
    const amount = round2(l.quantity * price * (1 - disc / 100));
    const unit = round2(price * (1 - disc / 100));
    const base = `${l.item_number} ${l.description}`.trim();
    sumCents += cents(amount);
    if (cents(unit * l.quantity) === cents(amount)) {
      items.push({ description: base, quantity: l.quantity, price: unit });
    } else {
      const unitText = String(Number((price * (1 - disc / 100)).toFixed(4)));
      items.push({ description: `${base} (Qty ${l.quantity} @ $${unitText})`.trim(), quantity: 1, price: amount });
    }
  }

  if (posted.totalTax !== 0) {
    items.push({ description: 'Sales tax', quantity: 1, price: posted.totalTax });
    sumCents += cents(posted.totalTax);
  }

  if (sumCents !== cents(posted.totalInclTax)) {
    return {
      ok: false,
      error: `Bill.com total $${(sumCents / 100).toFixed(2)} doesn't match BC's posted total $${round2(posted.totalInclTax).toFixed(2)}.`,
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
