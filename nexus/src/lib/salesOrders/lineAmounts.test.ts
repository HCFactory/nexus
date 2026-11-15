import { describe, expect, it } from 'vitest';
import type { LineDraft } from '@/types/salesOrders';
import { effectiveDiscount, effectivePrice, lineAmounts, orderTotals, taxRatePercent } from './lineAmounts';

const areaLines = [
  { tax_area_code: 'HI-HNL-WHSL', tax_jurisdiction_code: 'HI-HN-WHSL' },
  { tax_area_code: 'HI-HNL-RT', tax_jurisdiction_code: 'HI-HN-RT' },
];
const detail = (o: Partial<{ tax_jurisdiction_code: string; tax_group_code: string; tax_type: string; effective_date: string; tax_below_maximum: number }>) => ({
  tax_jurisdiction_code: 'HI-HN-WHSL',
  tax_group_code: 'TAXABLE',
  tax_type: 'Sales Tax',
  effective_date: '2025-03-06',
  tax_below_maximum: 0.5,
  ...o,
});
const details = [detail({}), detail({ tax_jurisdiction_code: 'HI-HN-RT', tax_below_maximum: 4.712 })];
const q = { taxAreaCode: 'HI-HNL-WHSL', taxGroupCode: 'TAXABLE', date: '2026-11-14', taxLiable: true };

const line = (o: Partial<LineDraft> = {}): LineDraft => ({
  key: 'k', item_number: 'P-1007', description: '', quantity: 1, unit_price: null, discount_percent: null,
  unit_of_measure_code: 'EA', amount_incl_tax: null, estimate_price: null, bc_unit_price: null,
  bc_line_discount_percent: null, ...o,
});

describe('taxRatePercent', () => {
  it('HI-HNL-WHSL → HI-HN-WHSL, TAXABLE 0.5 effective 2025-03-06, on 2026-11-14 → 0.5', () => {
    expect(taxRatePercent(q, areaLines, details)).toBe(0.5);
  });

  it('is 0 when the order is not tax liable', () => {
    expect(taxRatePercent({ ...q, taxLiable: false }, areaLines, details)).toBe(0);
  });

  it('is 0 for a tax group with no detail', () => {
    expect(taxRatePercent({ ...q, taxGroupCode: '' }, areaLines, details)).toBe(0);
  });

  it('is 0 for a date before the detail is effective', () => {
    expect(taxRatePercent({ ...q, date: '2025-03-05' }, areaLines, details)).toBe(0);
  });

  it('the latest effective detail for the same key wins', () => {
    const two = [detail({ effective_date: '2024-01-01', tax_below_maximum: 0.25 }), detail({}), detail({ effective_date: '2027-01-01', tax_below_maximum: 9 })];
    expect(taxRatePercent(q, areaLines, two)).toBe(0.5);
    expect(taxRatePercent({ ...q, date: '2024-06-01' }, areaLines, two)).toBe(0.25);
  });

  it('sums over the area’s jurisdictions', () => {
    const lines = [...areaLines, { tax_area_code: 'HI-HNL-WHSL', tax_jurisdiction_code: 'HI-HN-RT' }];
    expect(taxRatePercent(q, lines, details)).toBeCloseTo(5.212);
  });
});

describe('effective price and discount', () => {
  it('a typed price beats the BC price, which beats the estimate', () => {
    expect(effectivePrice(line({ unit_price: 3, bc_unit_price: 2, estimate_price: 1 }))).toBe(3);
    expect(effectivePrice(line({ bc_unit_price: 2, estimate_price: 1 }))).toBe(2);
    expect(effectivePrice(line({ estimate_price: 1 }))).toBe(1);
    expect(effectivePrice(line())).toBeNull();
  });

  it('a typed discount 0 beats a BC discount of 5', () => {
    expect(effectiveDiscount(line({ discount_percent: 0, bc_line_discount_percent: 5 }))).toBe(0);
    expect(effectiveDiscount(line({ bc_line_discount_percent: 5, estimate_discount_percent: 3 }))).toBe(5);
    expect(effectiveDiscount(line({ estimate_discount_percent: 3 }))).toBe(3);
    expect(effectiveDiscount(line())).toBe(0);
  });
});

describe('lineAmounts and orderTotals', () => {
  it('P-1007 qty 1 at 2.73, rate 0.5 → incl 2.74; totals 2.73 / 0.01 / 2.74', () => {
    const a = lineAmounts(line({ estimate_price: 2.73 }), 0.5);
    expect(a.excl).toBe(2.73);
    expect(a.incl).toBe(2.74);
    expect(orderTotals([a])).toEqual({ subtotal: 2.73, tax: 0.01, total: 2.74 });
  });

  it('qty 2 at 10 with a typed 5% discount, rate 0 → excl 19', () => {
    expect(lineAmounts(line({ quantity: 2, unit_price: 10, discount_percent: 5 }), 0)).toEqual({ excl: 19, taxRaw: 0, incl: 19 });
  });

  it('no price → 0', () => {
    expect(lineAmounts(line(), 4)).toEqual({ excl: 0, taxRaw: 0, incl: 0 });
  });

  it('tax is rounded once over the order, not per line', () => {
    const a = lineAmounts(line({ estimate_price: 1.01 }), 0.5);
    expect(orderTotals([a, a, a])).toEqual({ subtotal: 3.03, tax: 0.02, total: 3.05 });
  });
});
