import type { InvoiceState, OrderStatus, SalesOrderRow } from '@/types/salesOrders'

const HAND_STATUSES: readonly OrderStatus[] = ['draft', 'final', 'pulled']

/** Draft, final and pulled can move between each other; shipped/invoiced are set by the invoice process only. */
export function canChangeStatus(from: OrderStatus, to: OrderStatus): boolean {
  return HAND_STATUSES.includes(from) && HAND_STATUSES.includes(to)
}

/** Draft is fully editable; later statuses only allow the status to change (notes are separate entries). */
export function editableFields(status: OrderStatus): 'all' | readonly ['status'] {
  return status === 'draft' ? 'all' : (['status'] as const)
}

export function canDelete(status: OrderStatus): boolean {
  return status === 'draft' || status === 'final'
}

/** Today's date (YYYY-MM-DD) in the given time zone; the server's zone when none is given. */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', timeZone ? { timeZone } : undefined).format(now)
}

/** Invoice # when none is typed: the BC order number, plus the customer PO when there is one (35 chars max, BC's limit). */
export function autoInvoiceNumber(bcOrderNumber: string | null, customerPo: string): string {
  if (!bcOrderNumber) return ''
  const po = customerPo.trim()
  return (po ? `${bcOrderNumber} / ${po}` : bcOrderNumber).slice(0, 35)
}

/**
 * Invoice states with a step still to run (the runner, the sweep, opening the
 * order and the list all resume these). `posted` is here: a run that stopped
 * right after recording the posted invoice still has the Bill.com step to do.
 */
export const RESUMABLE_INVOICE_STATES: readonly InvoiceState[] = ['posting', 'posted', 'billcom_sending']

export function isInvoiceResumable(state: InvoiceState | string): boolean {
  return (RESUMABLE_INVOICE_STATES as readonly string[]).includes(state)
}

/** True once BC holds the posted invoice (so the order can no longer be restarted). */
export function isPastPosting(state: InvoiceState): boolean {
  return state === 'posted' || state === 'billcom_sending' || state === 'billcom_failed' || state === 'done'
}

export function canStartInvoice(
  o: Pick<SalesOrderRow, 'status' | 'sync_state' | 'invoice_state' | 'bc_order_number'>,
): boolean {
  return (
    (o.status === 'final' || o.status === 'pulled') &&
    o.sync_state === 'synced' &&
    o.invoice_state === 'none' &&
    !!o.bc_order_number
  )
}

/** Why the customer can't be invoiced yet, or null when ready. Bill.com off is checked first. */
export function invoiceBlockReason(
  link: { status: string; billcom_customer_id: string | null } | null,
  billcomOn: boolean,
): string | null {
  if (!billcomOn) return 'Bill.com is turned off. Turn it on in Settings before invoicing.'
  if (link?.status === 'needs_attention') return 'Add a name and email to this customer in Customers before invoicing.'
  if (link?.status === 'failed') return "This customer couldn't be sent to Bill.com. Retry it from Customers first."
  if (!link || link.status !== 'synced' || !link.billcom_customer_id) {
    return "This customer isn't in Bill.com yet. Push it from Customers first."
  }
  return null
}
