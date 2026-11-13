import type { FriendsFamilyProduct, FriendsFamilyQuantityDeal } from '@/types/database';

/** Mirrors `friends_family_deal_unit_price` in migration 056: the deal with the
 * highest minimum quantity the line reaches wins, otherwise the base price. */
export function getFriendsFamilyUnitPrice(
  product: Pick<FriendsFamilyProduct, 'unit_price' | 'quantity_deals'>,
  quantity: number
): number {
  let best: FriendsFamilyQuantityDeal | null = null;
  for (const deal of product.quantity_deals ?? []) {
    if (deal.min_quantity <= quantity && (!best || deal.min_quantity > best.min_quantity)) best = deal;
  }
  return best ? best.unit_price : product.unit_price;
}

export function normalizeFriendsFamilyQuantityDeals(value: unknown): FriendsFamilyQuantityDeal[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((deal) => ({ min_quantity: Number(deal?.min_quantity), unit_price: Number(deal?.unit_price) }))
    .filter((deal) => Number.isFinite(deal.min_quantity) && Number.isFinite(deal.unit_price))
    .sort((a, b) => a.min_quantity - b.min_quantity);
}
