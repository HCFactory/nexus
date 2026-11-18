import type { SalesPriceListLineRow } from '@/types/salesOrders';
import {
  LIST_STATUS_ACTIVE,
  SOURCE_ALL_CUSTOMERS,
  SOURCE_CUSTOMER,
  SOURCE_PRICE_GROUP,
} from '@/lib/businessCentral/priceLists/constants';

export interface BestPriceQuery {
  customerNumber: string;
  priceGroup: string;
  itemNumber: string;
  uom: string;
  quantity: number;
  orderDate: string; // YYYY-MM-DD
}

function sourceMatches(l: SalesPriceListLineRow, q: BestPriceQuery): boolean {
  if (l.source_type === SOURCE_ALL_CUSTOMERS) return true;
  if (l.source_type === SOURCE_CUSTOMER) return l.source_no === q.customerNumber;
  if (l.source_type === SOURCE_PRICE_GROUP) return q.priceGroup !== '' && l.source_no === q.priceGroup;
  return false;
}

/** Mirrors BC's best-price rule: lowest applicable price, highest applicable discount. */
export function bestPrice(
  lines: SalesPriceListLineRow[],
  q: BestPriceQuery,
  fallback: number | null,
): { unitPrice: number | null; discountPercent: number | null } {
  let price: number | null = null;
  let discount: number | null = null;
  const uom = q.uom.toLowerCase();
  for (const l of lines) {
    if (l.list_status !== LIST_STATUS_ACTIVE) continue;
    if (!sourceMatches(l, q)) continue;
    if (l.item_number !== q.itemNumber) continue;
    if (l.unit_of_measure_code !== '' && l.unit_of_measure_code.toLowerCase() !== uom) continue;
    if (q.quantity < l.minimum_quantity) continue;
    if (l.starting_date && q.orderDate < l.starting_date) continue;
    if (l.ending_date && q.orderDate > l.ending_date) continue;
    if (l.amount_type.includes('Price') && (price === null || l.unit_price < price)) price = l.unit_price;
    if (l.amount_type.includes('Discount') && (discount === null || l.line_discount_percent > discount)) {
      discount = l.line_discount_percent;
    }
  }
  return { unitPrice: price ?? fallback, discountPercent: discount };
}
