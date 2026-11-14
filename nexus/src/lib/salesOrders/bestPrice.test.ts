import { describe, it, expect } from 'vitest';
import { bestPrice } from './bestPrice';
import type { SalesPriceListLineRow } from '@/types/salesOrders';

let n = 0;
function line(o: Partial<SalesPriceListLineRow>): SalesPriceListLineRow {
  return {
    id: String(++n), organization_id: 'o', bc_connection_id: 'c',
    price_list_code: 'PL', line_no: n, list_status: 'Active',
    source_type: 'Customer Price Group', source_no: 'GRP', item_number: 'ITEM',
    unit_of_measure_code: '', minimum_quantity: 0, starting_date: null, ending_date: null,
    unit_price: 10, line_discount_percent: 0, amount_type: 'Price', ...o,
  } as SalesPriceListLineRow;
}
const q = { customerNumber: 'C1', priceGroup: 'GRP', itemNumber: 'ITEM', uom: 'PCS', quantity: 5, orderDate: '2026-06-15' };

describe('bestPrice', () => {
  it('falls back when nothing applies', () => {
    expect(bestPrice([], q, 7)).toEqual({ unitPrice: 7, discountPercent: null });
    expect(bestPrice([], q, null)).toEqual({ unitPrice: null, discountPercent: null });
  });
  it('picks the lowest price', () => {
    const r = bestPrice([line({ unit_price: 9 }), line({ unit_price: 6 }), line({ unit_price: 8 })], q, 99);
    expect(r.unitPrice).toBe(6);
  });
  it('customer-specific list beats group list on price when lower', () => {
    const r = bestPrice([line({ unit_price: 9 }), line({ source_type: 'Customer', source_no: 'C1', unit_price: 5 })], q, null);
    expect(r.unitPrice).toBe(5);
  });
  it('applies All Customers, ignores other customers and groups', () => {
    expect(bestPrice([line({ source_type: 'All Customers', source_no: '', unit_price: 4 })], q, null).unitPrice).toBe(4);
    expect(bestPrice([line({ source_type: 'Customer', source_no: 'C2' })], q, 1).unitPrice).toBe(1);
    expect(bestPrice([line({ source_no: 'OTHER' })], q, 1).unitPrice).toBe(1);
  });
  it('ignores inactive lists and other items', () => {
    expect(bestPrice([line({ list_status: 'Draft' })], q, 1).unitPrice).toBe(1);
    expect(bestPrice([line({ item_number: 'ITEM2' })], q, 1).unitPrice).toBe(1);
  });
  it('UoM: blank or case-insensitive match applies, mismatch does not', () => {
    expect(bestPrice([line({ unit_of_measure_code: 'pcs', unit_price: 3 })], q, 1).unitPrice).toBe(3);
    expect(bestPrice([line({ unit_of_measure_code: 'BOX', unit_price: 3 })], q, 1).unitPrice).toBe(1);
  });
  it('respects minimum quantity', () => {
    expect(bestPrice([line({ minimum_quantity: 5, unit_price: 3 })], q, 1).unitPrice).toBe(3);
    expect(bestPrice([line({ minimum_quantity: 6, unit_price: 3 })], q, 1).unitPrice).toBe(1);
  });
  it('respects the date window, inclusive, null = open', () => {
    expect(bestPrice([line({ starting_date: '2026-06-15', ending_date: '2026-06-15', unit_price: 3 })], q, 1).unitPrice).toBe(3);
    expect(bestPrice([line({ starting_date: '2026-06-16', unit_price: 3 })], q, 1).unitPrice).toBe(1);
    expect(bestPrice([line({ ending_date: '2026-06-14', unit_price: 3 })], q, 1).unitPrice).toBe(1);
  });
  it('discount: highest among lines with Discount in amount type', () => {
    const r = bestPrice([
      line({ amount_type: 'Price & Discount', unit_price: 8, line_discount_percent: 5 }),
      line({ amount_type: 'Discount', unit_price: 0, line_discount_percent: 12 }),
      line({ amount_type: 'Price', line_discount_percent: 50 }),
    ], q, null);
    expect(r).toEqual({ unitPrice: 8, discountPercent: 12 });
  });
  it('discount-only lines do not set a price', () => {
    const r = bestPrice([line({ amount_type: 'Discount', unit_price: 0, line_discount_percent: 10 })], q, 7);
    expect(r).toEqual({ unitPrice: 7, discountPercent: 10 });
  });
  it('no discount returns null', () => {
    expect(bestPrice([line({})], q, null).discountPercent).toBeNull();
  });
});
