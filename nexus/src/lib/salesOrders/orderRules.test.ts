import { describe, it, expect } from 'vitest'
import { canChangeStatus, editableFields, canDelete, todayIn, autoInvoiceNumber } from './orderRules'

describe('orderRules', () => {
  it('moves freely between draft, final and pulled', () => {
    expect(canChangeStatus('final', 'draft')).toBe(true)
    expect(canChangeStatus('pulled', 'final')).toBe(true)
  })
  it('never moves to or from shipped/invoiced by hand', () => {
    expect(canChangeStatus('draft', 'shipped')).toBe(false)
    expect(canChangeStatus('invoiced', 'draft')).toBe(false)
    expect(canChangeStatus('shipped', 'final')).toBe(false)
  })
  it('locks fields after draft', () => {
    expect(editableFields('final')).toEqual(['status', 'notes'])
    expect(editableFields('draft')).toBe('all')
  })
  it('only deletes draft and final', () => {
    expect(canDelete('pulled')).toBe(false)
    expect(canDelete('final')).toBe(true)
    expect(canDelete('draft')).toBe(true)
    expect(canDelete('shipped')).toBe(false)
  })
  it('todayIn formats in the given zone', () => {
    const now = new Date('2026-11-13T03:00:00Z')
    expect(todayIn('Pacific/Honolulu', now)).toBe('2026-11-12')
    expect(todayIn('UTC', now)).toBe('2026-11-13')
    expect(todayIn(null, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('autoInvoiceNumber is the order number, plus the trimmed PO when there is one', () => {
    expect(autoInvoiceNumber('W-100531', '')).toBe('W-100531')
    expect(autoInvoiceNumber('W-100531', ' PO-889 ')).toBe('W-100531 / PO-889')
    expect(autoInvoiceNumber(null, 'X')).toBe('')
    expect(autoInvoiceNumber('W-100531', 'P'.repeat(40))).toHaveLength(35)
  })
})
