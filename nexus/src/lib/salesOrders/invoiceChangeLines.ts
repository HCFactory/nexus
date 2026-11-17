// The lines of an invoice change: what was invoiced, what the rep wants, and
// whether that is a valid change. Pure (spec: 2026-11-17-change-invoice-design.md).
import type { InvoiceSourceLine } from '@/lib/billcom/invoicePayload'
import type { ChangeLine } from '@/types/invoiceChanges'
import type { LineDraft, SalesOrderLineRow } from '@/types/salesOrders'
import { effectiveDiscount, effectivePrice } from './lineAmounts'

const REASON_MAX = 1000
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const cents = (n: number) => Math.round(n * 100)

/** The order's lines as they were invoiced: price and discount resolved (typed, else BC's). */
export function toChangeLines(rows: SalesOrderLineRow[]): ChangeLine[] {
  return rows
    .filter((r) => !r.removed)
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      item_number: r.item_number,
      description: r.description,
      unit_of_measure_code: r.unit_of_measure_code,
      quantity: r.quantity,
      unit_price: effectivePrice(r) ?? 0,
      discount_percent: effectiveDiscount(r),
    }))
}

/**
 * The rep's edited lines as change lines. An existing line keeps its invoiced
 * price and discount unless the rep typed one; a new line uses its typed price,
 * else the estimate, and needs one of them.
 */
export function changeLinesFromDrafts(
  drafts: LineDraft[],
  rows: SalesOrderLineRow[],
): { ok: true; lines: ChangeLine[] } | { ok: false; error: string } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const lines: ChangeLine[] = []
  for (const d of drafts) {
    if (!d.item_number.trim()) continue
    const existing = d.id ? byId.get(d.id) : undefined
    // A new line without a typed price uses the estimate the table shows and totals.
    const price = d.unit_price ?? (existing ? effectivePrice(existing) : effectivePrice(d))
    if (price === null) return { ok: false, error: `Enter a unit price for ${d.item_number}.` }
    if (!(d.quantity > 0)) return { ok: false, error: `Quantity must be more than 0 for ${d.item_number}.` }
    if (price < 0) return { ok: false, error: `Unit price can't be negative for ${d.item_number}.` }
    const discount = d.discount_percent ?? (existing ? effectiveDiscount(existing) : effectiveDiscount(d))
    if (discount < 0 || discount > 100) return { ok: false, error: `Discount must be between 0 and 100 for ${d.item_number}.` }
    lines.push({
      item_number: d.item_number,
      description: d.description,
      unit_of_measure_code: d.unit_of_measure_code,
      quantity: d.quantity,
      unit_price: price,
      discount_percent: discount,
    })
  }
  return { ok: true, lines }
}

const key = (l: ChangeLine) =>
  [l.item_number.trim(), l.description.trim(), l.unit_of_measure_code.trim(), l.quantity, Math.round(l.unit_price * 10000), l.discount_percent].join('|')

/** Same lines in the same order (descriptions compared trimmed, prices to 1/100 cent). */
export function sameLines(a: ChangeLine[], b: ChangeLine[]): boolean {
  return a.length === b.length && a.every((l, i) => key(l) === key(b[i]))
}

/** Why this change can't be submitted, or null. */
export function validateChange(before: ChangeLine[], after: ChangeLine[], reason: string): string | null {
  const r = reason.trim()
  if (!r) return 'Enter a reason for the change.'
  if (r.length > REASON_MAX) return 'Keep the reason under 1000 characters.'
  if (after.length === 0) return 'An invoice needs at least one line.'
  if (sameLines(before, after)) return 'Nothing changed.'
  return null
}

/**
 * Subtotal before tax in cents, each line as BC computes it: the gross amount
 * rounded to the cent, less the discount amount rounded on its own
 * (1 × 0.25 at 10% = 0.25 − 0.03 = 0.22).
 */
export function changeSubtotalCents(lines: ChangeLine[]): number {
  return lines.reduce((sum, l) => {
    const gross = round2(l.quantity * l.unit_price)
    return sum + cents(gross) - cents(round2((gross * l.discount_percent) / 100))
  }, 0)
}

/** Lines for the Bill.com payload builder. */
export function toInvoiceSourceLines(lines: ChangeLine[]): InvoiceSourceLine[] {
  return lines.map((l) => ({
    item_number: l.item_number,
    description: l.description,
    quantity: l.quantity,
    unit_price: l.unit_price,
    bc_unit_price: null,
    discount_percent: l.discount_percent,
    bc_line_discount_percent: null,
  }))
}
