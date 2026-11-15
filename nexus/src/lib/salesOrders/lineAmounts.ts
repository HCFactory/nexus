import type { LineDraft } from '@/types/salesOrders';

export interface TaxAreaLine {
  tax_area_code: string;
  tax_jurisdiction_code: string;
}

export interface TaxDetail {
  tax_jurisdiction_code: string;
  tax_group_code: string;
  tax_type: string;
  effective_date: string;
  tax_below_maximum: number;
}

export interface TaxRateQuery {
  taxAreaCode: string;
  taxGroupCode: string;
  date: string; // YYYY-MM-DD
  taxLiable: boolean;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The sales tax % BC would likely charge: for each jurisdiction in the tax
 * area, the latest detail for the item's tax group (per tax type) in effect on
 * the date. 0 when the order is not tax liable.
 */
export function taxRatePercent(q: TaxRateQuery, areaLines: TaxAreaLine[], details: TaxDetail[]): number {
  if (!q.taxLiable) return 0;
  let rate = 0;
  for (const area of areaLines) {
    if (area.tax_area_code !== q.taxAreaCode) continue;
    const latest = new Map<string, TaxDetail>();
    for (const d of details) {
      if (d.tax_jurisdiction_code !== area.tax_jurisdiction_code) continue;
      if (d.tax_group_code !== q.taxGroupCode) continue;
      if (d.effective_date > q.date) continue;
      const seen = latest.get(d.tax_type);
      if (!seen || d.effective_date > seen.effective_date) latest.set(d.tax_type, d);
    }
    for (const d of latest.values()) rate += d.tax_below_maximum;
  }
  return rate;
}

/** The price the line will use: typed, else BC's from the last sync, else the estimate. */
export const effectivePrice = (l: LineDraft): number | null => l.unit_price ?? l.bc_unit_price ?? l.estimate_price;

/** The discount the line will use: typed, else BC's, else the estimate, else 0. */
export const effectiveDiscount = (l: LineDraft): number =>
  l.discount_percent ?? l.bc_line_discount_percent ?? l.estimate_discount_percent ?? 0;

/** Line amount excluding tax (rounded), its unrounded tax, and the amount including tax (rounded). */
export function lineAmounts(l: LineDraft, ratePercent: number): { excl: number; taxRaw: number; incl: number } {
  const excl = round2(l.quantity * (effectivePrice(l) ?? 0) * (1 - effectiveDiscount(l) / 100));
  const taxRaw = (excl * ratePercent) / 100;
  return { excl, taxRaw, incl: round2(excl + taxRaw) };
}

/** Order totals; tax is rounded once over the whole order. */
export function orderTotals(rows: { excl: number; taxRaw: number }[]): { subtotal: number; tax: number; total: number } {
  const subtotal = round2(rows.reduce((s, r) => s + r.excl, 0));
  const tax = round2(rows.reduce((s, r) => s + r.taxRaw, 0));
  return { subtotal, tax, total: round2(subtotal + tax) };
}
