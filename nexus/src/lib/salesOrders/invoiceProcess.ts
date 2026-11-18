// The "Create invoice" process for one sales order (spec:
// docs/superpowers/specs/2026-11-15-create-invoice-design.md).
//
//   none -> posting -> posted -> billcom_sending -> done
//              |                      |
//         post_failed           billcom_failed      (Retry resumes the step)
//
// Safety rules:
// - Posting in BC can't be undone. The posting step always asks BC for a
//   posted invoice first, and after a post whose outcome is unknown, so a
//   crash or lost response never leads to a second post.
// - The Bill.com step always looks for the invoice by number first, and a
//   "duplicate invoice number" answer is resolved by looking it up. A found or
//   created invoice only counts when its total and line count match.
// - Every step runs under the order's lease, so two triggers can't overlap.
//   The lease is extended to cover the post (BC can take minutes) and renewed
//   at each later step; a lost lease stops the run without writing.
// - Every state change is a compare-and-set on the expected current state, so
//   a runner that lost ownership can never overwrite a newer state.
import { INVOKE_ACTION_TIMEOUT_MS } from '@/lib/businessCentral/client'
import type { BillcomClient } from '@/lib/billcom/client'
import { buildBillcomInvoice } from '@/lib/billcom/invoicePayload'
import { billcomInvoiceMismatch, findOrCreateBillcomInvoice } from '@/lib/billcom/invoicePush'
import type { InvoiceState, SalesOrderRow } from '@/types/salesOrders'
import {
  BcPostRefusedError,
  findPostedInvoice,
  postShipAndInvoice,
  setInvoiceDates,
  type BcInvoicingDeps,
  type PostedInvoice,
} from './bcInvoicing'
import { LEASE_MS, SWEEP_BATCH, withOrderLease, type OrderLease } from './orderClaim'
import { autoInvoiceNumber, canStartInvoice, invoiceBlockReason, isInvoiceResumable, RESUMABLE_INVOICE_STATES, todayIn } from './orderRules'
import { loadLines, loadOrder, orderChangedInBc, readBcOrder } from './orderSync'

export interface InvoiceDeps extends BcInvoicingDeps {
  /** null = Bill.com is off or not set up. */
  billcom: BillcomClient | null
  billcomConnectionId: string | null
  /** Bill.com is turned on but its client couldn't be built: Bill.com work fails visibly, never skipped as "off". */
  billcomUnavailable?: boolean
  /** The BC connection's time zone; invoice date = today there. */
  timeZone: string | null
  userId?: string
  /**
   * Copies a just-posted BC invoice into Receivables' invoice list, so it
   * shows there without waiting for the next Receivables sync.
   */
  mirrorPostedInvoice?: (raw: Record<string, unknown>) => Promise<void>
}

export type InvoiceResult = { ok: true } | { ok: false; error: string }
export type RetryResult = { ok: true; state: InvoiceState } | { ok: false; error: string }

const ORDERS = 'sales_orders'
const LINKS = 'billcom_customer_links'
const BUSY = 'This order is busy. Try again in a moment.'
const NOT_FOUND = 'Sales order not found.'
const NOT_STARTABLE = "This order can't be invoiced right now."
const NOTHING_TO_RETRY = 'Nothing to retry.'
const CHANGED_IN_BC = 'Changed in BC'
export const POST_NOT_CONFIRMED = "BC didn't confirm the posting. Retry checks BC first, so it won't post twice."
export const NOT_IN_SYNC = "Save the order so it's In BC (Final or Pulled) before retrying."
/** Lease held across the post: BC's action timeout plus a margin. */
export const POST_LEASE_MS = INVOKE_ACTION_TIMEOUT_MS + 60_000

/** Another runner took the order (lease lost, or the state moved on): stop without writing. */
export class InvoiceOwnershipLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvoiceOwnershipLostError'
  }
}

const isOwnershipLost = (e: unknown) => e instanceof InvoiceOwnershipLostError

type Link = { status: string; billcom_customer_id: string | null }

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Every invoice state change: a compare-and-set on the `expected` current
 * state, scoped to the order's org and connection, stamped updated_at.
 * Throws InvoiceOwnershipLostError when the state is no longer `expected`.
 */
async function updateInvoice(
  deps: InvoiceDeps,
  orderId: string,
  expected: InvoiceState,
  values: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await deps.supabase
    .from(ORDERS)
    .update({ ...values, updated_at: deps.now() })
    .eq('id', orderId)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .eq('invoice_state', expected)
    .select('id')
  if (error) throw new Error(`Could not save the invoice state: ${error.message}`)
  if (!Array.isArray(data) || data.length === 0) {
    throw new InvoiceOwnershipLostError(`Invoice state of ${orderId} is no longer ${expected}.`)
  }
}

async function renewOrStop(lease: OrderLease, orderId: string, ms: number): Promise<void> {
  if (!(await lease.renew(ms))) throw new InvoiceOwnershipLostError(`Lost the lease on ${orderId}.`)
}

/** Posting needs an order that is In BC and Final or Pulled (BC's content = Nexus's). */
const inSyncForPosting = (o: SalesOrderRow) => o.sync_state === 'synced' && (o.status === 'final' || o.status === 'pulled')

/** The order, or null when it doesn't exist (in this org and connection). */
async function findOrder(deps: InvoiceDeps, orderId: string): Promise<SalesOrderRow | null> {
  try {
    return await loadOrder(deps, orderId)
  } catch (e) {
    if (message(e) === 'Sales order not found') return null
    throw e
  }
}

async function loadLink(deps: InvoiceDeps, customerNumber: string): Promise<Link | null> {
  if (!deps.billcomConnectionId) return null
  const { data, error } = await deps.supabase
    .from(LINKS)
    .select('status, billcom_customer_id')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .eq('billcom_connection_id', deps.billcomConnectionId)
    .eq('bc_customer_number', customerNumber)
    .maybeSingle()
  if (error) throw new Error(`Could not load the Bill.com customer link: ${error.message}`)
  return (data as Link | null) ?? null
}

/** Why Bill.com can't take this customer's invoice, or null with the Bill.com customer id. */
async function customerBlock(
  deps: InvoiceDeps,
  order: SalesOrderRow,
): Promise<{ reason: string } | { reason: null; customerId: string }> {
  if (!deps.billcom) return { reason: invoiceBlockReason(null, false)! }
  const link = await loadLink(deps, order.customer_number)
  const reason = invoiceBlockReason(link, true)
  if (reason || !link?.billcom_customer_id) return { reason: reason ?? invoiceBlockReason(null, true)! }
  return { reason: null, customerId: link.billcom_customer_id }
}

const invoiceNumberOf = (o: SalesOrderRow) => o.invoice_number ?? autoInvoiceNumber(o.bc_order_number, o.customer_po)

function postedQuery(o: SalesOrderRow) {
  return { orderNumber: o.bc_order_number ?? '', externalDocumentNumber: invoiceNumberOf(o), customerNumber: o.customer_number }
}

/** `posted` and the Invoiced status in one update, with the posted invoice's fields. */
async function recordPosted(deps: InvoiceDeps, orderId: string, inv: PostedInvoice): Promise<InvoiceState> {
  await updateInvoice(deps, orderId, 'posting', {
    invoice_state: 'posted',
    status: 'invoiced',
    bc_posted_invoice_id: inv.id,
    bc_posted_invoice_number: inv.number,
    posted_at: deps.now(),
    invoice_date: inv.invoiceDate,
    invoice_due_date: inv.dueDate,
    posted_total_excl_tax: inv.totalExclTax,
    posted_total_tax: inv.totalTax,
    posted_total_incl_tax: inv.totalInclTax,
    invoice_error: null,
  })
  // Best effort: the next Receivables sync copies it anyway.
  if (inv.raw && deps.mirrorPostedInvoice) {
    try {
      await deps.mirrorPostedInvoice(inv.raw)
    } catch (e) {
      console.error(`[invoice] could not copy ${inv.number} into Receivables:`, e)
    }
  }
  return 'posted'
}

async function fail(deps: InvoiceDeps, orderId: string, state: 'post_failed' | 'billcom_failed', error: string) {
  await updateInvoice(deps, orderId, state === 'post_failed' ? 'posting' : 'billcom_sending', {
    invoice_state: state,
    invoice_error: error,
  })
  return state
}

/** Step 1: find or post the BC invoice. */
async function postingStep(deps: InvoiceDeps, order: SalesOrderRow, lease: OrderLease): Promise<InvoiceState> {
  const no = order.bc_order_number
  if (!no) return fail(deps, order.id, 'post_failed', 'This order has no BC order number.')
  const query = postedQuery(order)

  // (a)-(c): nothing has been posted yet, so any error is a plain failure.
  try {
    const existing = await findPostedInvoice(deps, query)
    if (existing) return recordPosted(deps, order.id, existing)

    // A rep may have moved the order back and edited it after post_failed: if
    // that save hasn't reached BC, BC's (old) content would be posted while
    // Bill.com gets Nexus's lines.
    if (!inSyncForPosting(order)) return fail(deps, order.id, 'post_failed', NOT_IN_SYNC)

    const lines = await loadLines(deps, order.id)
    if (orderChangedInBc(order, lines, await readBcOrder(deps, no))) {
      await updateInvoice(deps, order.id, 'posting', { invoice_state: 'none', sync_state: 'conflict', sync_error: CHANGED_IN_BC })
      return 'none'
    }

    await setInvoiceDates(deps, no, todayIn(deps.timeZone, new Date(deps.now())))
  } catch (e) {
    if (isOwnershipLost(e)) throw e
    return fail(deps, order.id, 'post_failed', message(e))
  }

  // The post can take up to BC's action timeout: hold the lease past it, so
  // no other runner can start (and find nothing posted yet) mid-post.
  await renewOrStop(lease, order.id, POST_LEASE_MS)

  // (d): the post. Only a refusal proves nothing was posted; anything else
  // (5xx, timeout, network) may have posted, so BC is asked before deciding.
  try {
    await postShipAndInvoice(deps, no)
  } catch (e) {
    if (e instanceof BcPostRefusedError) return fail(deps, order.id, 'post_failed', e.message)
    console.error(`[invoice] post of ${no} had an unknown outcome:`, e)
  }

  // (e): read back. Not found (yet) = unconfirmed; Retry starts with this lookup.
  let posted: PostedInvoice | null
  try {
    posted = await findPostedInvoice(deps, query)
  } catch (e) {
    console.error(`[invoice] read-back of ${no} failed:`, e)
    posted = null
  }
  if (!posted) return fail(deps, order.id, 'post_failed', POST_NOT_CONFIRMED)
  return recordPosted(deps, order.id, posted)
}

/** The posted invoice as stored on the order (Bill.com step and retries). */
function storedPosted(o: SalesOrderRow): PostedInvoice {
  return {
    id: o.bc_posted_invoice_id ?? '',
    number: o.bc_posted_invoice_number ?? '',
    invoiceDate: o.invoice_date ?? '',
    dueDate: o.invoice_due_date,
    totalExclTax: Number(o.posted_total_excl_tax ?? 0),
    totalTax: Number(o.posted_total_tax ?? 0),
    totalInclTax: Number(o.posted_total_incl_tax ?? 0),
  }
}

async function recordDone(deps: InvoiceDeps, orderId: string, billcomInvoiceId: string): Promise<InvoiceState> {
  await updateInvoice(deps, orderId, 'billcom_sending', {
    invoice_state: 'done',
    billcom_invoice_id: billcomInvoiceId,
    billcom_invoiced_at: deps.now(),
    invoice_error: null,
  })
  return 'done'
}

/** Step 2: find or create the Bill.com invoice. */
async function billcomStep(deps: InvoiceDeps, order: SalesOrderRow): Promise<InvoiceState> {
  try {
    const block = await customerBlock(deps, order)
    if (block.reason !== null) return fail(deps, order.id, 'billcom_failed', block.reason)
    const client = deps.billcom!
    const invoiceNumber = invoiceNumberOf(order)

    // Built first: it is what a found invoice is checked against.
    const lines = (await loadLines(deps, order.id)).filter((l) => !l.removed)
    const built = buildBillcomInvoice({ billcomCustomerId: block.customerId, invoiceNumber, posted: storedPosted(order), lines })
    if (!built.ok) return fail(deps, order.id, 'billcom_failed', built.error)

    const invoice = await findOrCreateBillcomInvoice(client, block.customerId, built.payload)
    // Only an invoice with the expected total and number of lines counts as done.
    const mismatch = billcomInvoiceMismatch(invoice, built.payload)
    if (mismatch) return fail(deps, order.id, 'billcom_failed', mismatch)
    return recordDone(deps, order.id, invoice.id)
  } catch (e) {
    if (isOwnershipLost(e)) throw e
    return fail(deps, order.id, 'billcom_failed', message(e))
  }
}

/** Runs steps until the order stops in a state with nothing to run, under `lease`. */
async function runSteps(deps: InvoiceDeps, orderId: string, lease: OrderLease): Promise<InvoiceState> {
  for (let step = 0; ; step++) {
    const order = await loadOrder(deps, orderId)
    const state = order.invoice_state
    if (!isInvoiceResumable(state)) return state
    // Back to the normal lease (from a long post lease, or after a slow step).
    if (step > 0) await renewOrStop(lease, orderId, LEASE_MS)
    if (state === 'posting') {
      await postingStep(deps, order, lease)
    } else if (state === 'posted') {
      await updateInvoice(deps, orderId, 'posted', { invoice_state: 'billcom_sending' })
    } else {
      await billcomStep(deps, order)
    }
  }
}

/**
 * Starts the process: checks the order and the customer's Bill.com link and
 * sets `posting`. It does not run the steps; the caller schedules
 * runInvoiceProcess (in `after()`).
 */
export async function startInvoiceProcess(deps: InvoiceDeps, orderId: string): Promise<InvoiceResult> {
  const res = await withOrderLease(deps, orderId, async (): Promise<InvoiceResult> => {
    const order = await findOrder(deps, orderId)
    if (!order) return { ok: false, error: NOT_FOUND }
    if (!canStartInvoice(order)) return { ok: false, error: NOT_STARTABLE }
    const block = await customerBlock(deps, order)
    if (block.reason !== null) return { ok: false, error: block.reason }
    try {
      await updateInvoice(deps, orderId, 'none', {
        invoice_state: 'posting',
        invoice_error: null,
        invoice_started_by: deps.userId ?? null,
      })
    } catch (e) {
      if (isOwnershipLost(e)) return { ok: false, error: BUSY }
      throw e
    }
    return { ok: true }
  })
  if (res.claimed) return res.value
  // No lease taken: either someone holds it or the order isn't ours.
  return (await findOrder(deps, orderId)) ? { ok: false, error: BUSY } : { ok: false, error: NOT_FOUND }
}

/**
 * Claims the lease and runs the process to its next stop: `done`, a failed
 * state, or `none` (changed in BC). null, with no changes, when the lease is held.
 */
export async function runInvoiceProcess(deps: InvoiceDeps, orderId: string): Promise<InvoiceState | null> {
  const res = await withOrderLease(deps, orderId, async (lease) => {
    try {
      return await runSteps(deps, orderId, lease)
    } catch (e) {
      if (!isOwnershipLost(e)) throw e
      console.warn(`[invoice] stopped: ${message(e)}`)
      return null
    }
  })
  return res.claimed ? res.value : null
}

/** Retry: `post_failed` resumes posting, `billcom_failed` resumes the Bill.com step. */
export async function retryInvoiceProcess(deps: InvoiceDeps, orderId: string): Promise<RetryResult> {
  const res = await withOrderLease(deps, orderId, async (): Promise<RetryResult | null> => {
    const order = await findOrder(deps, orderId)
    if (!order) return { ok: false, error: NOT_FOUND }
    const from = order.invoice_state
    const next: InvoiceState | null = from === 'post_failed' ? 'posting' : from === 'billcom_failed' ? 'billcom_sending' : null
    if (!next) return { ok: false, error: NOTHING_TO_RETRY }
    // No in-sync check here: the posting step asks BC for a posted invoice
    // first (BC may have posted before the failure), and only then refuses an
    // order that isn't In BC, with NOT_IN_SYNC saved on the order.
    try {
      await updateInvoice(deps, orderId, from, { invoice_state: next, invoice_error: null })
    } catch (e) {
      if (isOwnershipLost(e)) return { ok: false, error: BUSY }
      throw e
    }
    return null
  })
  if (!res.claimed) return (await findOrder(deps, orderId)) ? { ok: false, error: BUSY } : { ok: false, error: NOT_FOUND }
  if (res.value) return res.value
  const state = await runInvoiceProcess(deps, orderId)
  // Someone took the lease between our release and the run; they run the step.
  return { ok: true, state: state ?? (await loadOrder(deps, orderId)).invoice_state }
}

/**
 * Resume invoice steps that stopped midway (a crash, a closed tab, a time
 * limit): orders in a resumable state (posting, posted, billcom_sending) whose lease is free, oldest first. Each run
 * is safe to repeat (it checks BC / Bill.com before acting). Returns how many
 * runs got the order (non-null result).
 */
export async function sweepInvoiceSteps(deps: InvoiceDeps, limit = SWEEP_BATCH): Promise<number> {
  const nowIso = deps.now()
  const { data, error } = await deps.supabase
    .from(ORDERS)
    .select('id')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .in('invoice_state', [...RESUMABLE_INVOICE_STATES])
    .or(`claimed_until.is.null,claimed_until.lt.${nowIso}`)
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`Could not read stuck invoices: ${error.message}`)
  let handled = 0
  for (const { id } of (data ?? []) as { id: string }[]) {
    try {
      if ((await runInvoiceProcess(deps, id)) !== null) handled += 1
    } catch (e) {
      console.error(`[sales-orders] background invoice step of ${id} failed:`, e)
    }
  }
  return handled
}
