import { describe, it, expect } from 'vitest'
import { canChangeStatus, editableFields, canDelete, todayIn, autoInvoiceNumber, isPastPosting, canStartInvoice, invoiceBlockReason } from './orderRules'

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
    expect(editableFields('final')).toEqual(['status'])
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

  it('isPastPosting is true only once BC has the invoice', () => {
    for (const st of ['posted', 'billcom_sending', 'billcom_failed', 'done', 'changing'] as const) expect(isPastPosting(st)).toBe(true)
    for (const st of ['none', 'posting', 'post_failed'] as const) expect(isPastPosting(st)).toBe(false)
  })
  it('canStartInvoice needs final/pulled, synced, none and an order number', () => {
    const ok = { status: 'final', sync_state: 'synced', invoice_state: 'none', bc_order_number: 'SO1' } as const
    expect(canStartInvoice(ok)).toBe(true)
    expect(canStartInvoice({ ...ok, status: 'pulled' })).toBe(true)
    expect(canStartInvoice({ ...ok, status: 'draft' })).toBe(false)
    expect(canStartInvoice({ ...ok, sync_state: 'pending' })).toBe(false)
    expect(canStartInvoice({ ...ok, sync_state: 'conflict' })).toBe(false)
    expect(canStartInvoice({ ...ok, bc_order_number: null })).toBe(false)
    expect(canStartInvoice({ ...ok, invoice_state: 'posting' })).toBe(false)
    expect(canStartInvoice({ ...ok, invoice_state: 'done' })).toBe(false)
  })
  it('invoiceBlockReason gives the exact copy', () => {
    expect(invoiceBlockReason({ status: 'synced', billcom_customer_id: 'c' }, false)).toBe(
      'Bill.com is turned off. Turn it on in Settings before invoicing.')
    expect(invoiceBlockReason(null, true)).toBe("This customer isn't in Bill.com yet. Push it from Customers first.")
    expect(invoiceBlockReason({ status: 'pending', billcom_customer_id: null }, true)).toBe(
      "This customer isn't in Bill.com yet. Push it from Customers first.")
    expect(invoiceBlockReason({ status: 'needs_attention', billcom_customer_id: null }, true)).toBe(
      'Add a name and email to this customer in Customers before invoicing.')
    expect(invoiceBlockReason({ status: 'failed', billcom_customer_id: null }, true)).toBe(
      "This customer couldn't be sent to Bill.com. Retry it from Customers first.")
    expect(invoiceBlockReason({ status: 'synced', billcom_customer_id: 'c' }, true)).toBeNull()
  })
  it('final to invoiced stays a non-hand change', () => {
    expect(canChangeStatus('final', 'invoiced')).toBe(false)
  })
})
