// Invoice change records (spec: docs/superpowers/specs/2026-11-17-change-invoice-design.md).
// Rows mirror migration 066_sales_invoice_changes.sql.

export const CHANGE_STATES = [
  'pending', 'cancelling', 'cancel_failed', 'cancelled', 'posting', 'post_failed',
  'posted', 'billcom_updating', 'billcom_failed', 'done', 'discarded',
] as const
export type ChangeState = (typeof CHANGE_STATES)[number]

/** Mid-step states a sweep or page open resumes. */
export const RESUMABLE_CHANGE_STATES: readonly ChangeState[] = ['pending', 'cancelling', 'cancelled', 'posting', 'posted', 'billcom_updating']
/** States where BC hasn't cancelled the old invoice yet, so the change can be dropped. */
export const DISCARDABLE_CHANGE_STATES: readonly ChangeState[] = ['pending', 'cancel_failed']
/** Failed states with a Retry. */
export const FAILED_CHANGE_STATES: readonly ChangeState[] = ['cancel_failed', 'post_failed', 'billcom_failed']

export const isChangeOpen = (s: ChangeState) => s !== 'done' && s !== 'discarded'

/** One invoice line as the change sees it: price and discount always resolved. */
export interface ChangeLine {
  item_number: string
  description: string
  unit_of_measure_code: string
  quantity: number
  unit_price: number
  discount_percent: number
}

export interface InvoiceChangeRow {
  id: string
  organization_id: string
  bc_connection_id: string
  sales_order_id: string
  state: ChangeState
  error: string | null
  reason: string
  changed_by: string | null
  changed_by_name: string
  created_at: string
  updated_at: string
  finished_at: string | null
  old_bc_invoice_id: string
  old_bc_invoice_number: string
  old_total: number | null
  cancelled_at: string | null
  draft_bc_invoice_id: string | null
  new_bc_invoice_id: string | null
  new_bc_invoice_number: string | null
  new_total: number | null
  lines_before: ChangeLine[]
  lines_after: ChangeLine[]
}

/** Start of the post step's error when BC has several drafts with the Invoice # (the page offers "Delete extra drafts"). */
export const DUPLICATE_DRAFTS_PREFIX = 'BC has more than one draft'

/** A BC draft invoice as the "Delete extra drafts" box shows it. */
export interface DraftSummary {
  id: string
  no: string
  totalExclTax: number
}
