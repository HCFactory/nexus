// The "Change invoice" process for one invoice change record (spec:
// docs/superpowers/specs/2026-11-17-change-invoice-design.md).
//
//   pending -> cancelling -> cancelled -> posting -> posted -> billcom_updating -> done
//                  |                         |                       |
//            cancel_failed              post_failed            billcom_failed   (Retry resumes the step)
//   pending / cancel_failed -> discarded   (only while BC hasn't cancelled the old invoice)
//
// Safety rules (same as Create invoice):
// - Cancelling and posting in BC can't be undone. Each step asks BC first
//   (old invoice already Canceled? corrected invoice already posted? a draft
//   already made?) and re-reads BC after an unknown outcome, so a crash or a
//   lost response never cancels or posts twice.
// - Every step runs under the order's lease, renewed before each write; a
//   lost lease stops the run without writing.
// - Every state change is a compare-and-set on the expected current state.
// - The order's lines change only at `done`, so until then the order still
//   matches the live BC invoice (or, after the cancel, the one being made).
import { buildBillcomInvoice } from '@/lib/billcom/invoicePayload'
import {
  billcomInvoiceMismatch,
  findBillcomInvoice,
  findOrCreateBillcomInvoice,
  replaceBillcomInvoice,
} from '@/lib/billcom/invoicePush'
import {
  DISCARDABLE_CHANGE_STATES,
  isChangeOpen,
  RESUMABLE_CHANGE_STATES,
  CHANGE_STATES,
  type ChangeLine,
  type ChangeState,
  type InvoiceChangeRow,
} from '@/types/invoiceChanges'
import type { SalesOrderRow } from '@/types/salesOrders'
import {
  applyDraftHeader,
  CANCELED,
  cancelBcInvoice,
  checkDraft,
  createDraftInvoice,
  findDraftInvoice,
  findReplacementInvoice,
  postDraftInvoice,
  readBcInvoice,
  setDraftLines,
  type BcInvoiceState,
} from './bcInvoiceChange'
import { BcPostRefusedError } from './bcInvoicing'
import { toChangeLines, toInvoiceSourceLines, validateChange } from './invoiceChangeLines'
import { InvoiceOwnershipLostError, POST_LEASE_MS, POST_NOT_CONFIRMED, type InvoiceDeps } from './invoiceProcess'
import { LEASE_MS, SWEEP_BATCH, withOrderLease, type OrderLease } from './orderClaim'
import { invoiceBlockReason } from './orderRules'
import { loadLines, loadOrder } from './orderSync'

const CHANGES = 'sales_invoice_changes'
const ORDERS = 'sales_orders'
const LINES = 'sales_order_lines'
const LINKS = 'billcom_customer_links'

export const NOT_CHANGEABLE = "This invoice can't be changed right now."
export const ALREADY_OPEN = 'A change is already open for this invoice.'
export const CANCEL_NOT_CONFIRMED = "BC didn't confirm the cancel. Retry checks BC first, so it won't cancel twice."
const BUSY = 'This order is busy. Try again in a moment.'
const NOT_FOUND = 'Sales order not found.'
const CHANGE_NOT_FOUND = 'Invoice change not found.'
const NOTHING_TO_RETRY = 'Nothing to retry.'

export type ChangeResult = { ok: true } | { ok: false; error: string }

const OPEN_STATES = CHANGE_STATES.filter(isChangeOpen)
const RETRY_NEXT: Partial<Record<ChangeState, ChangeState>> = {
  cancel_failed: 'cancelling',
  post_failed: 'posting',
  billcom_failed: 'billcom_updating',
}

/** The failed state of each step that talks to BC or Bill.com. */
const STEP_FAILURE: Partial<Record<ChangeState, 'cancel_failed' | 'post_failed' | 'billcom_failed'>> = {
  cancelling: 'cancel_failed',
  posting: 'post_failed',
  billcom_updating: 'billcom_failed',
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isOwnershipLost = (e: unknown) => e instanceof InvoiceOwnershipLostError
const isUniqueViolation = (err: { message: string; code?: string }) => err.code === '23505' || /duplicate key|unique constraint/i.test(err.message)

// ---------- records ----------

async function loadChange(deps: InvoiceDeps, changeId: string): Promise<InvoiceChangeRow | null> {
  const { data, error } = await deps.supabase
    .from(CHANGES)
    .select('*')
    .eq('id', changeId)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .maybeSingle()
  if (error) throw new Error(`Could not load the invoice change: ${error.message}`)
  return (data as InvoiceChangeRow | null) ?? null
}

/** The order's open change (not done or discarded), or null. */
export async function loadOpenChange(deps: InvoiceDeps, orderId: string): Promise<InvoiceChangeRow | null> {
  const { data, error } = await deps.supabase
    .from(CHANGES)
    .select('*')
    .eq('sales_order_id', orderId)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .in('state', OPEN_STATES)
    .limit(1)
  if (error) throw new Error(`Could not load the invoice change: ${error.message}`)
  return ((data ?? [])[0] as InvoiceChangeRow | undefined) ?? null
}

/** A compare-and-set on the change's state; throws InvoiceOwnershipLostError when it moved on. */
async function updateChange(deps: InvoiceDeps, changeId: string, expected: ChangeState, values: Record<string, unknown>): Promise<void> {
  const { data, error } = await deps.supabase
    .from(CHANGES)
    .update({ ...values, updated_at: deps.now() })
    .eq('id', changeId)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .eq('state', expected)
    .select('id')
  if (error) throw new Error(`Could not save the invoice change: ${error.message}`)
  if (!Array.isArray(data) || data.length === 0) {
    throw new InvoiceOwnershipLostError(`Invoice change ${changeId} is no longer ${expected}.`)
  }
}

/** Moves the order from one invoice state to another; false when it isn't in `from`. */
async function setOrderState(deps: InvoiceDeps, orderId: string, from: string, values: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await deps.supabase
    .from(ORDERS)
    .update({ ...values, updated_at: deps.now() })
    .eq('id', orderId)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .eq('invoice_state', from)
    .select('id')
  if (error) throw new Error(`Could not save the sales order: ${error.message}`)
  return Array.isArray(data) && data.length > 0
}

async function renewOrStop(lease: OrderLease, ms: number): Promise<void> {
  if (!(await lease.renew(ms))) throw new InvoiceOwnershipLostError('Lost the order lease.')
}

async function fail(deps: InvoiceDeps, c: InvoiceChangeRow, state: 'cancel_failed' | 'post_failed' | 'billcom_failed', error: string): Promise<ChangeState> {
  await updateChange(deps, c.id, c.state, { state, error })
  return state
}

async function mirror(deps: InvoiceDeps, inv: BcInvoiceState | null, what: string): Promise<void> {
  if (!inv?.raw || !deps.mirrorPostedInvoice) return
  try {
    await deps.mirrorPostedInvoice(inv.raw)
  } catch (e) {
    console.error(`[invoice change] could not copy ${what} into Receivables:`, e)
  }
}

// ---------- start ----------

export interface StartChangeInput {
  orderId: string
  reason: string
  lines: ChangeLine[]
  userId: string
  userName: string
  /** The Bill.com check, made by the caller just before (null = allowed). */
  blockedReason: string | null
}

/**
 * Opens a change: checks the order and the change, writes a `pending` record
 * and sets the order to `changing`. It doesn't run the steps; the caller
 * schedules runInvoiceChange (in `after()`).
 */
export async function startInvoiceChange(
  deps: InvoiceDeps,
  input: StartChangeInput,
): Promise<{ ok: true; changeId: string } | { ok: false; error: string }> {
  const res = await withOrderLease(deps, input.orderId, async () => {
    let order: SalesOrderRow
    try {
      order = await loadOrder(deps, input.orderId)
    } catch (e) {
      if (message(e) === 'Sales order not found') return { ok: false as const, error: NOT_FOUND }
      throw e
    }
    if (order.invoice_state !== 'done' || !order.bc_posted_invoice_id) return { ok: false as const, error: NOT_CHANGEABLE }
    if (input.blockedReason) return { ok: false as const, error: input.blockedReason }
    const before = toChangeLines(await loadLines(deps, order.id))
    const invalid = validateChange(before, input.lines, input.reason)
    if (invalid) return { ok: false as const, error: invalid }

    const now = deps.now()
    // The order is flipped first, so an open change never exists on an order that isn't `changing`.
    if (!(await setOrderState(deps, order.id, 'done', { invoice_state: 'changing', invoice_error: null }))) {
      return { ok: false as const, error: BUSY }
    }
    const revert = () => setOrderState(deps, order.id, 'changing', { invoice_state: 'done' })
    const { data, error } = await deps.supabase
      .from(CHANGES)
      .insert({
        organization_id: deps.orgId,
        bc_connection_id: deps.connectionId,
        sales_order_id: order.id,
        state: 'pending',
        reason: input.reason.trim(),
        changed_by: input.userId,
        changed_by_name: input.userName,
        old_bc_invoice_id: order.bc_posted_invoice_id,
        old_bc_invoice_number: order.bc_posted_invoice_number ?? '',
        old_total: order.posted_total_incl_tax,
        lines_before: before,
        lines_after: input.lines,
        created_at: now,
        updated_at: now,
      })
      .select('id')
    if (error) {
      await revert()
      if (isUniqueViolation(error)) return { ok: false as const, error: ALREADY_OPEN }
      throw new Error(`Could not save the invoice change: ${error.message}`)
    }
    return { ok: true as const, changeId: String((data as { id: string }[])[0].id) }
  })
  if (res.claimed) return res.value
  try {
    await loadOrder(deps, input.orderId)
    return { ok: false, error: BUSY }
  } catch {
    return { ok: false, error: NOT_FOUND }
  }
}

// ---------- steps ----------

/** The old invoice as BC has it now (it keeps its number, dates and customer after the cancel). */
async function readOld(deps: InvoiceDeps, c: InvoiceChangeRow): Promise<BcInvoiceState | null> {
  return readBcInvoice(deps, c.old_bc_invoice_id)
}

async function recordCancelled(deps: InvoiceDeps, c: InvoiceChangeRow, oldNow: BcInvoiceState | null): Promise<void> {
  await updateChange(deps, c.id, 'cancelling', { state: 'cancelled', error: null, cancelled_at: deps.now() })
  await mirror(deps, oldNow, `the cancelled ${c.old_bc_invoice_number}`)
}

async function cancelStep(deps: InvoiceDeps, c: InvoiceChangeRow, lease: OrderLease): Promise<ChangeState | void> {
  const oldInv = await readOld(deps, c)
  if (!oldInv) return fail(deps, c, 'cancel_failed', `BC has no invoice ${c.old_bc_invoice_number}.`)
  if (oldInv.status === CANCELED) return recordCancelled(deps, c, oldInv)
  if (oldInv.status !== 'Open') {
    return fail(deps, c, 'cancel_failed', `BC shows ${c.old_bc_invoice_number} as ${oldInv.status}; it can't be cancelled.`)
  }
  await renewOrStop(lease, POST_LEASE_MS)
  try {
    await cancelBcInvoice(deps, c.old_bc_invoice_id)
  } catch (e) {
    await renewOrStop(lease, LEASE_MS)
    if (e instanceof BcPostRefusedError) return fail(deps, c, 'cancel_failed', e.message)
    // Unknown outcome: BC may have cancelled. Ask before deciding.
    const now = await readOld(deps, c).catch(() => null)
    if (now?.status === CANCELED) return recordCancelled(deps, c, now)
    return fail(deps, c, 'cancel_failed', CANCEL_NOT_CONFIRMED)
  }
  await renewOrStop(lease, LEASE_MS)
  return recordCancelled(deps, c, await readOld(deps, c).catch(() => null))
}

async function recordPosted(deps: InvoiceDeps, c: InvoiceChangeRow, inv: BcInvoiceState): Promise<void> {
  await updateChange(deps, c.id, 'posting', {
    state: 'posted',
    error: null,
    new_bc_invoice_id: inv.id,
    new_bc_invoice_number: inv.number,
    new_total: inv.totalInclTax,
  })
  await mirror(deps, inv, inv.number)
}

async function postStep(deps: InvoiceDeps, c: InvoiceChangeRow, lease: OrderLease): Promise<ChangeState | void> {
  const oldInv = await readOld(deps, c)
  if (!oldInv) return fail(deps, c, 'post_failed', `BC has no invoice ${c.old_bc_invoice_number}.`)
  const q = { externalDocumentNumber: oldInv.externalDocumentNumber, customerNumber: oldInv.customerNumber }

  // Posted already (a crash or lost response after the post)? Record it, never post again.
  const posted = await findReplacementInvoice(deps, { ...q, excludeId: c.old_bc_invoice_id })
  if (posted) return recordPosted(deps, c, posted)

  const order = await loadOrder(deps, c.sales_order_id)
  let draft = await findDraftInvoice(deps, { draftId: c.draft_bc_invoice_id, ...q })
  if (!draft) draft = await createDraftInvoice(deps, order, oldInv, q.externalDocumentNumber)
  if (draft.id !== c.draft_bc_invoice_id) await updateChange(deps, c.id, 'posting', { draft_bc_invoice_id: draft.id })
  // Every run: a draft from a run that crashed may still have BC's customer defaults.
  await applyDraftHeader(deps, draft, order, oldInv)
  await setDraftLines(deps, draft, c.lines_after)
  const mismatch = await checkDraft(deps, draft, c.lines_after)
  if (mismatch) return fail(deps, c, 'post_failed', mismatch)

  await renewOrStop(lease, POST_LEASE_MS)
  try {
    await postDraftInvoice(deps, draft)
  } catch (e) {
    await renewOrStop(lease, LEASE_MS)
    if (e instanceof BcPostRefusedError) return fail(deps, c, 'post_failed', e.message)
    const found = await findReplacementInvoice(deps, { ...q, excludeId: c.old_bc_invoice_id }).catch(() => null)
    if (found) return recordPosted(deps, c, found)
    return fail(deps, c, 'post_failed', POST_NOT_CONFIRMED)
  }
  await renewOrStop(lease, LEASE_MS)
  const found = await findReplacementInvoice(deps, { ...q, excludeId: c.old_bc_invoice_id })
  if (!found) return fail(deps, c, 'post_failed', POST_NOT_CONFIRMED)
  return recordPosted(deps, c, found)
}

async function billcomCustomerId(deps: InvoiceDeps, customerNumber: string): Promise<{ id: string } | { reason: string }> {
  const { data, error } = await deps.supabase
    .from(LINKS)
    .select('status, billcom_customer_id')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .eq('billcom_connection_id', deps.billcomConnectionId ?? '')
    .eq('bc_customer_number', customerNumber)
    .maybeSingle()
  if (error) throw new Error(`Could not load the Bill.com customer link: ${error.message}`)
  const link = (data as { status: string; billcom_customer_id: string | null } | null) ?? null
  const reason = invoiceBlockReason(link, true)
  return reason || !link?.billcom_customer_id ? { reason: reason ?? 'Bill.com customer missing.' } : { id: link.billcom_customer_id }
}

/** Puts the corrected invoice on the order: lines (Nexus only), BC invoice, totals; state back to `done`. */
async function finishOrder(deps: InvoiceDeps, c: InvoiceChangeRow, inv: BcInvoiceState): Promise<void> {
  const order = await loadOrder(deps, c.sales_order_id)
  const moved = await setOrderState(deps, order.id, 'changing', {
    invoice_state: 'done',
    invoice_error: null,
    bc_posted_invoice_id: inv.id,
    bc_posted_invoice_number: inv.number,
    posted_total_excl_tax: inv.totalExclTax,
    posted_total_tax: inv.totalTax,
    posted_total_incl_tax: inv.totalInclTax,
    total_excl_tax: inv.totalExclTax,
    total_tax: inv.totalTax,
    total_incl_tax: inv.totalInclTax,
  })
  // Already finished by a run that crashed before closing the change: fine.
  if (!moved && !(order.invoice_state === 'done' && order.bc_posted_invoice_id === inv.id)) {
    throw new Error(`Sales order ${order.id} is ${order.invoice_state}, not changing.`)
  }
  await writeOrderLines(deps, order.id, c.lines_after)
}

/** The order's lines become `lines` (rows reused in order; extras deleted: the BC order is gone, nothing syncs). */
async function writeOrderLines(deps: InvoiceDeps, orderId: string, lines: ChangeLine[]): Promise<void> {
  const rows = (await loadLines(deps, orderId)).filter((r) => !r.removed)
  const now = deps.now()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const values = {
      position: i + 1,
      item_number: l.item_number,
      description: l.description,
      unit_of_measure_code: l.unit_of_measure_code,
      quantity: l.quantity,
      unit_price: l.unit_price,
      discount_percent: l.discount_percent,
      bc_unit_price: l.unit_price,
      bc_line_discount_percent: l.discount_percent,
      amount_incl_tax: null,
      removed: false,
      updated_at: now,
    }
    const row = rows[i]
    const q = row
      ? deps.supabase.from(LINES).update(values).eq('id', row.id)
      : deps.supabase.from(LINES).insert({
          ...values,
          organization_id: deps.orgId,
          bc_connection_id: deps.connectionId,
          sales_order_id: orderId,
          created_at: now,
        })
    const { error } = await q
    if (error) throw new Error(`Could not save the order lines: ${error.message}`)
  }
  for (const extra of rows.slice(lines.length)) {
    const { error } = await deps.supabase.from(LINES).delete().eq('id', extra.id).eq('organization_id', deps.orgId)
    if (error) throw new Error(`Could not remove an order line: ${error.message}`)
  }
}

async function billcomStep(deps: InvoiceDeps, c: InvoiceChangeRow): Promise<ChangeState | void> {
  const inv = c.new_bc_invoice_id ? await readBcInvoice(deps, c.new_bc_invoice_id) : null
  if (!inv) return fail(deps, c, 'billcom_failed', `BC has no corrected invoice${c.new_bc_invoice_number ? ` ${c.new_bc_invoice_number}` : ''}.`)

  if (deps.billcom) {
    try {
      const order = await loadOrder(deps, c.sales_order_id)
      const customer = await billcomCustomerId(deps, order.customer_number)
      if ('reason' in customer) return fail(deps, c, 'billcom_failed', customer.reason)
      const built = buildBillcomInvoice({
        billcomCustomerId: customer.id,
        invoiceNumber: inv.externalDocumentNumber,
        posted: inv,
        lines: toInvoiceSourceLines(c.lines_after),
      })
      if (!built.ok) return fail(deps, c, 'billcom_failed', built.error)
      const existingId =
        order.billcom_invoice_id ?? (await findBillcomInvoice(deps.billcom, customer.id, inv.externalDocumentNumber))?.id ?? null
      const saved = existingId
        ? await replaceBillcomInvoice(deps.billcom, existingId, built.payload)
        : await findOrCreateBillcomInvoice(deps.billcom, customer.id, built.payload)
      if (saved.id !== order.billcom_invoice_id) {
        const { error } = await deps.supabase
          .from(ORDERS)
          .update({ billcom_invoice_id: saved.id, billcom_invoiced_at: deps.now() })
          .eq('id', order.id)
          .eq('organization_id', deps.orgId)
          .eq('bc_connection_id', deps.connectionId)
        if (error) throw new Error(`Could not save the Bill.com invoice id: ${error.message}`)
      }
      const mismatch = billcomInvoiceMismatch(saved, built.payload)
      if (mismatch) return fail(deps, c, 'billcom_failed', mismatch)
    } catch (e) {
      if (isOwnershipLost(e)) throw e
      return fail(deps, c, 'billcom_failed', message(e))
    }
  }

  await finishOrder(deps, c, inv)
  await updateChange(deps, c.id, 'billcom_updating', { state: 'done', error: null, finished_at: deps.now() })
  return 'done'
}

/** Runs steps until the change stops in a state with nothing to run, under `lease`. */
async function runSteps(deps: InvoiceDeps, changeId: string, lease: OrderLease): Promise<ChangeState> {
  for (let step = 0; step < 20; step++) {
    const c = await loadChange(deps, changeId)
    if (!c) throw new InvoiceOwnershipLostError(`Invoice change ${changeId} is gone.`)
    if (!(RESUMABLE_CHANGE_STATES as readonly string[]).includes(c.state)) return c.state
    await renewOrStop(lease, LEASE_MS)
    const failedAs = STEP_FAILURE[c.state]
    if (failedAs) {
      // Any error in a BC or Bill.com step stops it with a visible message and Retry,
      // never a silent stop (the old invoice may already be cancelled).
      try {
        if (c.state === 'cancelling') await cancelStep(deps, c, lease)
        else if (c.state === 'posting') await postStep(deps, c, lease)
        else await billcomStep(deps, c)
      } catch (e) {
        if (isOwnershipLost(e)) throw e
        console.error(`[invoice change] ${c.state} of ${c.id} failed:`, e)
        await fail(deps, c, failedAs, message(e))
      }
      continue
    }
    // The hand-offs between steps.
    const next: Partial<Record<ChangeState, ChangeState>> = { pending: 'cancelling', cancelled: 'posting', posted: 'billcom_updating' }
    const to = next[c.state]
    if (to) await updateChange(deps, c.id, c.state, { state: to })
  }
  throw new Error(`Invoice change ${changeId} did not settle.`)
}

/**
 * Claims the order's lease and runs the change to its next stop (done or a
 * failed state). null, with no changes, when the lease is held or lost.
 */
export async function runInvoiceChange(deps: InvoiceDeps, changeId: string): Promise<ChangeState | null> {
  const c = await loadChange(deps, changeId)
  if (!c) return null
  const res = await withOrderLease(deps, c.sales_order_id, async (lease) => {
    try {
      return await runSteps(deps, changeId, lease)
    } catch (e) {
      if (!isOwnershipLost(e)) throw e
      console.warn(`[invoice change] stopped: ${message(e)}`)
      return null
    }
  })
  return res.claimed ? res.value : null
}

/** Retry a failed step: cancel, post or Bill.com. Runs it now. */
export async function retryInvoiceChange(deps: InvoiceDeps, changeId: string): Promise<ChangeResult> {
  const c = await loadChange(deps, changeId)
  if (!c) return { ok: false, error: CHANGE_NOT_FOUND }
  const next = RETRY_NEXT[c.state]
  if (!next) return { ok: false, error: NOTHING_TO_RETRY }
  const res = await withOrderLease(deps, c.sales_order_id, async () => {
    try {
      await updateChange(deps, c.id, c.state, { state: next, error: null })
      return true
    } catch (e) {
      if (isOwnershipLost(e)) return false
      throw e
    }
  })
  if (!res.claimed || !res.value) return { ok: false, error: BUSY }
  await runInvoiceChange(deps, changeId)
  return { ok: true }
}

/** Drops a change BC hasn't acted on yet: the record is discarded, the order goes back to `done` unchanged. */
export async function discardInvoiceChange(deps: InvoiceDeps, changeId: string): Promise<ChangeResult> {
  const c = await loadChange(deps, changeId)
  if (!c) return { ok: false, error: CHANGE_NOT_FOUND }
  if (!(DISCARDABLE_CHANGE_STATES as readonly string[]).includes(c.state)) {
    if (c.state === 'done' || c.state === 'discarded') return { ok: false, error: NOTHING_TO_RETRY }
    return { ok: false, error: `BC already cancelled ${c.old_bc_invoice_number}; Retry to finish the change.` }
  }
  const res = await withOrderLease(deps, c.sales_order_id, async (): Promise<ChangeResult> => {
    // Ask BC: after a cancel whose outcome was unknown, BC may have cancelled anyway.
    let oldInv: BcInvoiceState | null
    try {
      oldInv = await readOld(deps, c)
    } catch {
      return { ok: false, error: `Couldn't check BC for ${c.old_bc_invoice_number}. Try again.` }
    }
    if (oldInv && oldInv.status !== 'Open') {
      return { ok: false, error: `BC already cancelled ${c.old_bc_invoice_number}; Retry to finish the change.` }
    }
    try {
      await updateChange(deps, c.id, c.state, { state: 'discarded', finished_at: deps.now() })
    } catch (e) {
      if (isOwnershipLost(e)) return { ok: false, error: BUSY }
      throw e
    }
    await setOrderState(deps, c.sales_order_id, 'changing', { invoice_state: 'done', invoice_error: null })
    return { ok: true }
  })
  return res.claimed ? res.value : { ok: false, error: BUSY }
}

/**
 * Resume changes that stopped midway (a crash, a closed tab, a time limit):
 * records in a resumable state, oldest first. Each run is safe to repeat.
 * Returns how many runs got the order.
 */
export async function sweepInvoiceChanges(deps: InvoiceDeps, limit = SWEEP_BATCH): Promise<number> {
  const { data, error } = await deps.supabase
    .from(CHANGES)
    .select('id')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .in('state', [...RESUMABLE_CHANGE_STATES])
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`Could not read stuck invoice changes: ${error.message}`)
  let handled = 0
  for (const { id } of (data ?? []) as { id: string }[]) {
    try {
      if ((await runInvoiceChange(deps, id)) !== null) handled += 1
    } catch (e) {
      console.error(`[sales-orders] background invoice change ${id} failed:`, e)
    }
  }
  return handled
}
