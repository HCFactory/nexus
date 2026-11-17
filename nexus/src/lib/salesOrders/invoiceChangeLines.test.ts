import { describe, expect, it } from 'vitest'

import type { ChangeLine } from '@/types/invoiceChanges'
import type { LineDraft, SalesOrderLineRow } from '@/types/salesOrders'
import {
  changeLinesFromDrafts,
  changeSubtotalCents,
  sameLines,
  toChangeLines,
  toInvoiceSourceLines,
  validateChange,
} from './invoiceChangeLines'

function row(over: Partial<SalesOrderLineRow>): SalesOrderLineRow {
  return {
    id: 'r1', organization_id: 'o', bc_connection_id: 'c', sales_order_id: 's', position: 0,
    item_number: 'ING-10', description: 'Sugar', unit_of_measure_code: 'BOX', quantity: 1,
    unit_price: null, discount_percent: null, removed: false, bc_line_no: 10000, bc_etag: null,
    bc_unit_price: 4.5, bc_line_discount_percent: 10, amount_incl_tax: null, bc_snapshot: null,
    created_at: '', updated_at: '', ...over,
  }
}

function draft(over: Partial<LineDraft>): LineDraft {
  return {
    key: 'k', item_number: 'ING-10', description: 'Sugar', quantity: 1, unit_price: null, discount_percent: null,
    unit_of_measure_code: 'BOX', amount_incl_tax: null, estimate_price: null, bc_unit_price: null,
    bc_line_discount_percent: null, ...over,
  }
}

const line = (over: Partial<ChangeLine> = {}): ChangeLine => ({
  item_number: 'ING-10', description: 'Sugar', unit_of_measure_code: 'BOX', quantity: 1, unit_price: 4.5, discount_percent: 0, ...over,
})

describe('toChangeLines', () => {
  it("uses BC's invoiced price and discount when none was typed, drops removed rows, orders by position", () => {
    const out = toChangeLines([
      row({ id: 'b', position: 2, item_number: 'P-10', unit_price: 3, discount_percent: 0 }),
      row({ id: 'gone', position: 1, removed: true }),
      row({ id: 'a', position: 0 }),
    ])
    expect(out).toEqual([
      { item_number: 'ING-10', description: 'Sugar', unit_of_measure_code: 'BOX', quantity: 1, unit_price: 4.5, discount_percent: 10 },
      { item_number: 'P-10', description: 'Sugar', unit_of_measure_code: 'BOX', quantity: 1, unit_price: 3, discount_percent: 0 },
    ])
  })
})

describe('changeLinesFromDrafts', () => {
  const rows = [row({ id: 'a' })]

  it("an existing line with no typed price keeps its invoiced price and discount", () => {
    expect(changeLinesFromDrafts([draft({ id: 'a', quantity: 2 })], rows)).toEqual({
      ok: true,
      lines: [line({ quantity: 2, unit_price: 4.5, discount_percent: 10 })],
    })
  })

  it('a new line with no price and no estimate needs a unit price', () => {
    expect(changeLinesFromDrafts([draft({})], rows)).toEqual({ ok: false, error: 'Enter a unit price for ING-10.' })
  })

  it('a new line with no typed price uses the estimate the table shows', () => {
    expect(changeLinesFromDrafts([draft({ estimate_price: 8.5 })], rows)).toEqual({
      ok: true,
      lines: [line({ unit_price: 8.5 })],
    })
  })

  it('quantity must be more than 0', () => {
    expect(changeLinesFromDrafts([draft({ id: 'a', quantity: 0 })], rows)).toEqual({
      ok: false,
      error: 'Quantity must be more than 0 for ING-10.',
    })
  })

  it('discount must be between 0 and 100', () => {
    expect(changeLinesFromDrafts([draft({ id: 'a', discount_percent: 101 })], rows)).toEqual({
      ok: false,
      error: 'Discount must be between 0 and 100 for ING-10.',
    })
  })

  it('a typed price wins; a blank item number is skipped', () => {
    expect(changeLinesFromDrafts([draft({ unit_price: 5, discount_percent: 0 }), draft({ item_number: '' })], rows)).toEqual({
      ok: true,
      lines: [line({ unit_price: 5 })],
    })
  })
})

describe('validateChange', () => {
  const before = [line()]
  const after = [line({ quantity: 2 })]

  it('needs a reason', () => {
    expect(validateChange(before, after, '')).toBe('Enter a reason for the change.')
    expect(validateChange(before, after, '   ')).toBe('Enter a reason for the change.')
  })

  it('keeps the reason under 1000 characters', () => {
    expect(validateChange(before, after, 'x'.repeat(1001))).toBe('Keep the reason under 1000 characters.')
    expect(validateChange(before, after, 'x'.repeat(1000))).toBeNull()
  })

  it('needs at least one line', () => {
    expect(validateChange(before, [], 'why')).toBe('An invoice needs at least one line.')
  })

  it('needs a real change', () => {
    expect(validateChange(before, [line()], 'why')).toBe('Nothing changed.')
  })

  it('accepts a real change', () => {
    expect(validateChange(before, after, 'Customer got 2')).toBeNull()
  })
})

describe('sameLines', () => {
  it('ignores description whitespace but not a 1 cent price difference', () => {
    expect(sameLines([line({ description: ' Sugar ' })], [line()])).toBe(true)
    expect(sameLines([line({ unit_price: 4.51 })], [line()])).toBe(false)
    expect(sameLines([line(), line({ item_number: 'P-10' })], [line()])).toBe(false)
  })
})

describe('changeSubtotalCents', () => {
  it("adds each line rounded to the cent, as BC does", () => {
    expect(changeSubtotalCents([line({ quantity: 3, unit_price: 1.0925, discount_percent: 0 })])).toBe(328)
    expect(changeSubtotalCents([line({ quantity: 2, unit_price: 24.5, discount_percent: 10 }), line({ unit_price: 3.33 })])).toBe(4743)
  })

  it('rounds the discount amount separately, as BC does (0.25 at 10% is 0.22, not 0.23)', () => {
    expect(changeSubtotalCents([line({ quantity: 1, unit_price: 0.25, discount_percent: 10 })])).toBe(22)
  })
})

describe('toInvoiceSourceLines', () => {
  it('carries price and discount as typed values, BC values null', () => {
    expect(toInvoiceSourceLines([line({ unit_price: 2, discount_percent: 5 })])).toEqual([
      { item_number: 'ING-10', description: 'Sugar', quantity: 1, unit_price: 2, bc_unit_price: null, discount_percent: 5, bc_line_discount_percent: null },
    ])
  })
})
