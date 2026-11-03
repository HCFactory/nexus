import { describe, expect, it } from 'vitest';
import { getFriendsFamilyUnitPrice, normalizeFriendsFamilyQuantityDeals } from './pricing';

const giftBox = {
  unit_price: 12,
  quantity_deals: [
    { min_quantity: 5, unit_price: 10 },
    { min_quantity: 10, unit_price: 9 },
  ],
};

describe('getFriendsFamilyUnitPrice', () => {
  it('uses the standard price below every deal', () => {
    expect(getFriendsFamilyUnitPrice(giftBox, 4)).toBe(12);
  });

  it('applies a deal once its minimum quantity is reached', () => {
    expect(getFriendsFamilyUnitPrice(giftBox, 5)).toBe(10);
    expect(getFriendsFamilyUnitPrice(giftBox, 9)).toBe(10);
  });

  it('uses the deal with the highest minimum reached', () => {
    expect(getFriendsFamilyUnitPrice(giftBox, 12)).toBe(9);
  });

  it('falls back to the standard price without deals', () => {
    expect(getFriendsFamilyUnitPrice({ unit_price: 12, quantity_deals: [] }, 50)).toBe(12);
  });
});

describe('normalizeFriendsFamilyQuantityDeals', () => {
  it('converts stored values to sorted numeric deals', () => {
    expect(normalizeFriendsFamilyQuantityDeals([
      { min_quantity: '10', unit_price: '9.00' },
      { min_quantity: 5, unit_price: 10 },
    ])).toEqual([
      { min_quantity: 5, unit_price: 10 },
      { min_quantity: 10, unit_price: 9 },
    ]);
  });

  it('treats a missing value as no deals', () => {
    expect(normalizeFriendsFamilyQuantityDeals(null)).toEqual([]);
  });
});
