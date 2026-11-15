import type { OrderStatus } from '@/types/salesOrders'

const HAND_STATUSES: readonly OrderStatus[] = ['draft', 'final', 'pulled']

/** Draft, final and pulled can move between each other; shipped/invoiced are set by BC only. */
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
