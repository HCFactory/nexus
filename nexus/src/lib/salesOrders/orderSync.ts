// Pushes one Nexus sales order to Business Central through the published
// OData pages (SalesOrder 42, SalesOrderSalesLines 46). The caller already
// holds the order's lease (claimed_until).
//
// Safety rules:
// - Creates are duplicate-safe: a marker is saved before the create and looked
//   up first, so a create whose response was lost is adopted, not repeated.
// - Every BC write that succeeds is stored right away (order number, header
//   etag, each line's number/etag), so a retry after a failure continues
//   where it stopped.
// - Before writing to an existing order, BC's values for the fields Nexus
//   manages are compared with the snapshot stored after Nexus's last write
//   (lines without a snapshot: their etag); a difference stops the sync as a
//   conflict unless overwrite. The header etag is not compared: BC re-saves
//   headers in the background (measured on TEST).
import type { SupabaseClient } from '@supabase/supabase-js'
import { BcReferenceError } from '@/lib/businessCentral/customerReferences/errors'
import type { BcKey, BcRecord, ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import type { SalesOrderLineRow, SalesOrderRow, SyncState } from '@/types/salesOrders'
import {
  HEADER_SNAPSHOT_FIELDS,
  LINE_SNAPSHOT_FIELDS,
  SALES_DOCUMENT_SOURCE,
  SALES_LINE_SOURCE,
  SALES_ORDER_SOURCE,
  bcChangedOutsideNexus,
  createMarker,
  parseLineNo,
  readBack,
  snapshotOf,
  toBcCreate,
  toBcHeaderPatch,
  toBcLine,
  toSalesDocShipToAddress,
} from './bcOrderMapping'
import { isUnfinishedSave } from './saveMarker'

export interface OrderSyncDeps {
  supabase: SupabaseClient
  transport: ReferenceTransport
  orgId: string
  connectionId: string
  now(): string
}

const ORDERS = 'sales_orders'
const LINES = 'sales_order_lines'
const CHANGED_IN_BC = 'Changed in BC'

const headerSnapshot = (r: BcRecord) => snapshotOf(r, HEADER_SNAPSHOT_FIELDS)
const lineSnapshot = (r: BcRecord) => snapshotOf(r, LINE_SNAPSHOT_FIELDS)

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`

const orderKey = (no: string): BcKey => ({ values: { Document_Type: 'Order', No: no } })
const lineKey = (no: string, lineNo: number): BcKey => ({
  values: { Document_Type: 'Order', Document_No: no, Line_No: String(lineNo) },
})

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data
}

function ordersQuery(deps: OrderSyncDeps) {
  return deps.supabase.from(ORDERS)
}

async function updateOrder(deps: OrderSyncDeps, id: string, values: Record<string, unknown>): Promise<void> {
  check(
    await ordersQuery(deps)
      .update(values)
      .eq('id', id)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.connectionId),
    'Could not save the sales order',
  )
}

/** Returns how many rows were updated (0 when the row was deleted meanwhile). */
async function updateLine(
  deps: OrderSyncDeps,
  orderId: string,
  lineId: string,
  values: Record<string, unknown>,
): Promise<number> {
  const rows = check(
    await deps.supabase
      .from(LINES)
      .update(values)
      .eq('id', lineId)
      .eq('sales_order_id', orderId)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.connectionId)
      .select('id'),
    'Could not save the sales order line',
  ) as { id: string }[] | null
  return rows?.length ?? 0
}

/**
 * The Ship_to_Code to send: the order's code while that ship-to still exists
 * for the customer, else '' (the copied address fields still go in the header).
 */
async function shipToCodeToSend(deps: OrderSyncDeps, order: SalesOrderRow): Promise<string> {
  if (!order.ship_to_code) return ''
  const row = check(
    await deps.supabase
      .from('customer_ship_to_addresses')
      .select('code')
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.connectionId)
      .eq('customer_number', order.customer_number)
      .eq('code', order.ship_to_code)
      .maybeSingle(),
    'Could not load the ship-to address',
  )
  return row ? order.ship_to_code : ''
}

export async function loadOrder(deps: OrderSyncDeps, orderId: string): Promise<SalesOrderRow> {
  const row = check(
    await ordersQuery(deps)
      .select('*')
      .eq('id', orderId)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.connectionId)
      .maybeSingle(),
    'Could not load the sales order',
  ) as SalesOrderRow | null
  if (!row) throw new Error('Sales order not found')
  return row
}

export async function loadLines(deps: OrderSyncDeps, orderId: string): Promise<SalesOrderLineRow[]> {
  const rows = check(
    await deps.supabase
      .from(LINES)
      .select('*')
      .eq('sales_order_id', orderId)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.connectionId)
      .order('position'),
    'Could not load the sales order lines',
  ) as SalesOrderLineRow[] | null
  return rows ?? []
}

function listBcLines(deps: Pick<OrderSyncDeps, 'transport'>, no: string): Promise<BcRecord[]> {
  return deps.transport.list(SALES_LINE_SOURCE, {
    filter: `Document_Type eq 'Order' and Document_No eq ${quote(no)}`,
  })
}

/** BC's current header and lines of order `no`. */
export async function readBcOrder(
  deps: Pick<OrderSyncDeps, 'transport'>,
  no: string,
): Promise<{ header: BcRecord; lines: BcRecord[] }> {
  const header = await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))
  const lines = await listBcLines(deps, no)
  return { header, lines }
}

/**
 * The "Changed in BC" check: BC's order differs from what Nexus last wrote.
 * A removed row whose BC line is already gone is finished work, not a change
 * in BC; removed rows still in BC keep their check. bc_snapshot is null until
 * Nexus's first header write is stored: the header has nothing of Nexus's to
 * protect yet, so only the lines are compared (any BC line unknown to Nexus
 * is still a conflict).
 */
export function orderChangedInBc(
  order: Pick<SalesOrderRow, 'bc_snapshot'>,
  lines: SalesOrderLineRow[],
  bc: { header: BcRecord; lines: BcRecord[] },
): boolean {
  const inBc = new Set(bc.lines.map(parseLineNo))
  const compared = lines.filter((l) => !l.removed || (l.bc_line_no !== null && inBc.has(l.bc_line_no)))
  return bcChangedOutsideNexus({ bc_snapshot: order.bc_snapshot, lines: compared }, bc)
}

/** The fields of `wanted` whose value differs from BC's current value. */
function changedLineFields(wanted: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(wanted)) {
    const cur = current[k]
    const same = typeof v === 'number' ? Number(cur) === v : String(cur ?? '') === String(v ?? '')
    if (!same) out[k] = v
  }
  return out
}

const is404 = (err: unknown) => err instanceof BcReferenceError && err.status === 404

/**
 * The BC order created for this Nexus order (found by its create marker in
 * External_Document_No), or null. More than one match is an error to resolve in BC.
 */
export async function findBcOrderByMarker(
  deps: Pick<OrderSyncDeps, 'transport'>,
  marker: string,
): Promise<BcRecord | null> {
  const found = await deps.transport.list(SALES_ORDER_SOURCE, {
    filter: `Document_Type eq 'Order' and External_Document_No eq ${quote(marker)}`,
  })
  if (found.length > 1) throw new Error(`Found ${found.length} BC orders with marker ${marker}; resolve in BC`)
  return found[0] ?? null
}

/** Steps 2.1-2.3: find or create the BC order and store its number right away. */
async function ensureBcOrder(deps: OrderSyncDeps, order: SalesOrderRow): Promise<string> {
  const marker = order.bc_create_marker ?? createMarker(order.id)
  const found = await findBcOrderByMarker(deps, marker)
  let no: string
  if (found) {
    no = String(found.fields.No ?? '')
  } else {
    if (order.bc_create_marker === null) await updateOrder(deps, order.id, { bc_create_marker: marker })
    const created = await deps.transport.create(SALES_ORDER_SOURCE, toBcCreate(order, marker))
    no = String(created.fields.No ?? '')
  }
  if (!no) throw new Error('BC did not return a sales order number')
  await updateOrder(deps, order.id, { bc_order_number: no, bc_create_marker: marker })
  return no
}

export async function syncSalesOrder(
  deps: OrderSyncDeps,
  orderId: string,
  opts: { overwrite?: boolean } = {},
): Promise<SyncState> {
  const order = await loadOrder(deps, orderId)
  // Half-written lines: wait for a re-save. Covers the background retry loop
  // and a sweep that read the order before the save marked it.
  if (!opts.overwrite && isUnfinishedSave(order)) return 'failed'
  const version = order.local_version
  try {
    const lines = await loadLines(deps, orderId)
    let no: string
    let bcHeader: BcRecord
    let bcLines: BcRecord[]

    if (!order.bc_order_number) {
      no = await ensureBcOrder(deps, order)
      // Read back for the current etag: BC may touch the record after the POST.
      bcHeader = await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))
      bcLines = []
    } else {
      no = order.bc_order_number
      const current = await readBcOrder(deps, no)
      const header = current.header
      bcLines = current.lines
      if (!opts.overwrite) {
        if (orderChangedInBc(order, lines, current)) {
          await updateOrder(deps, order.id, { sync_state: 'conflict', sync_error: CHANGED_IN_BC, updated_at: deps.now() })
          return 'conflict'
        }
      }
      bcHeader = header
    }

    // Each header write is stored right away, so a failure after one of our
    // own writes isn't read as a change in BC on the retry.
    const patchHeader = async (fields: Record<string, unknown>) => {
      bcHeader = await deps.transport.patch(SALES_ORDER_SOURCE, orderKey(no), bcHeader.etag, fields)
      await updateOrder(deps, order.id, { bc_etag: bcHeader.etag, bc_snapshot: headerSnapshot(bcHeader) })
    }

    // Step 4: customer first (BC refills its defaults; measured: works on an
    // order with lines and keeps them), then the ship-to through
    // salesDocuments (page 42 keeps Ship_to_* read-only), then the header,
    // whose Nexus values (tax area, location, shipment method...) overwrite
    // whatever BC refilled.
    if (String(bcHeader.fields.Sell_to_Customer_No ?? '') !== order.customer_number) {
      await patchHeader({ Sell_to_Customer_No: order.customer_number })
    }
    // Same record: each salesDocuments write changes the SalesOrder etag, so
    // it is read and stored after every one (a later failure can't leave a
    // pre-write etag that the retry reads as a change in BC).
    const shipTo = await syncShipTo(deps, order, no, async () => {
      bcHeader = await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))
      await updateOrder(deps, order.id, { bc_etag: bcHeader.etag, bc_snapshot: headerSnapshot(bcHeader) })
    })
    await patchHeader(toBcHeaderPatch(order, no))

    // A header patch can change the lines' etags (measured: Tax_Area_Code is
    // pushed to the lines), so read them again before any line write and
    // store the new etags (and snapshots) of the lines Nexus knows.
    bcLines = await listBcLines(deps, no)
    for (const rec of bcLines) {
      const n = parseLineNo(rec)
      const known = lines.find((l) => l.bc_line_no === n)
      if (known && (known.bc_etag !== rec.etag || known.bc_snapshot === null)) {
        const snap = lineSnapshot(rec)
        await updateLine(deps, orderId, known.id, { bc_etag: rec.etag, bc_snapshot: snap })
        known.bc_etag = rec.etag
        known.bc_snapshot = snap
      }
    }

    // Inserting or deleting a line changes the header's etag in BC (a line
    // patch does not). Store the new one right away so a failure later in the
    // loop doesn't leave a stale bc_etag that the retry reads as a conflict.
    const refreshHeaderEtag = async () => {
      const h = await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))
      await updateOrder(deps, order.id, { bc_etag: h.etag, bc_snapshot: headerSnapshot(h) })
    }

    // Step 5: lines.
    const bcByNo = new Map(bcLines.map((l) => [parseLineNo(l), l]))
    if (opts.overwrite) {
      const known = new Set(lines.map((l) => l.bc_line_no).filter((n): n is number => n !== null))
      for (const [n, rec] of [...bcByNo]) {
        if (known.has(n)) continue
        await removeBcLine(deps, no, n, rec.etag)
        bcByNo.delete(n)
        await refreshHeaderEtag()
      }
    }
    for (const line of lines) {
      if (line.removed) {
        if (line.bc_line_no !== null) {
          const rec = bcByNo.get(line.bc_line_no)
          if (rec) {
            await removeBcLine(deps, no, line.bc_line_no, rec.etag)
            await refreshHeaderEtag()
          }
        }
        check(
          await deps.supabase
            .from(LINES)
            .delete()
            .eq('id', line.id)
            .eq('sales_order_id', orderId)
            .eq('organization_id', deps.orgId)
            .eq('bc_connection_id', deps.connectionId),
          'Could not delete the removed line',
        )
        continue
      }
      const wanted = toBcLine(no, line, order.location_code)
      let rec = line.bc_line_no === null ? undefined : bcByNo.get(line.bc_line_no)
      if (line.bc_line_no !== null && !rec) {
        // Without overwrite the conflict check already stopped on this.
        if (!opts.overwrite) throw new Error(`Line ${line.position} (BC line ${line.bc_line_no}) is missing in BC`)
        // Overwrite: Nexus's version wins, so the line is sent again as new.
        await updateLine(deps, orderId, line.id, { bc_line_no: null, bc_etag: null, bc_snapshot: null })
        rec = undefined
      }
      if (!rec) {
        const created = await deps.transport.create(SALES_LINE_SOURCE, wanted)
        const createdNo = parseLineNo(created)
        const saved = await updateLine(deps, orderId, line.id, {
          bc_line_no: createdNo,
          bc_etag: created.etag,
          bc_snapshot: lineSnapshot(created),
        })
        if (saved === 0) {
          // The row was deleted while we were creating its BC line: take the
          // BC line out again (fresh etag) so BC doesn't keep an orphan.
          const fresh = await deps.transport.get(SALES_LINE_SOURCE, lineKey(no, createdNo))
          await removeBcLine(deps, no, createdNo, fresh.etag)
        }
        await refreshHeaderEtag()
        continue
      }
      const diff = changedLineFields(wanted, rec.fields)
      if (Object.keys(diff).length === 0) continue
      const patched = await deps.transport.patch(SALES_LINE_SOURCE, lineKey(no, parseLineNo(rec)), rec.etag, diff)
      await updateLine(deps, orderId, line.id, { bc_etag: patched.etag, bc_snapshot: lineSnapshot(patched) })
    }

    // Step 6: read back BC's values.
    const header = await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))
    const finalLines = await listBcLines(deps, no)
    // Totals: the salesDocuments row read again now, after every write.
    const salesDocument = await deps.transport.get(SALES_DOCUMENT_SOURCE, { values: { id: shipTo.docId } })
    const rb = readBack(header, finalLines, salesDocument)
    const stored = await loadLines(deps, orderId)
    const finalByNo = new Map(finalLines.map((r) => [parseLineNo(r), r]))
    for (const l of rb.lines) {
      const row = stored.find((s) => s.bc_line_no === l.bc_line_no)
      if (!row) continue
      await updateLine(deps, orderId, row.id, {
        bc_etag: l.bc_etag,
        bc_snapshot: lineSnapshot(finalByNo.get(l.bc_line_no)!),
        bc_unit_price: l.bc_unit_price,
        bc_line_discount_percent: l.bc_line_discount_percent,
        amount_incl_tax: l.amount_incl_tax,
      })
    }
    const done = {
      bc_order_number: rb.bc_order_number,
      bc_etag: rb.bc_etag,
      bc_snapshot: headerSnapshot(header),
      bc_due_date: rb.bc_due_date,
      bc_document_date: rb.bc_document_date,
      bc_posting_date: rb.bc_posting_date,
      total_excl_tax: rb.total_excl_tax,
      total_tax: rb.total_tax,
      total_incl_tax: rb.total_incl_tax,
      synced_version: version,
      last_synced_at: deps.now(),
      updated_at: deps.now(),
      sync_error: null,
      sync_attempts: 0,
    }
    // 'synced' only if nobody edited the order since we loaded it; the version
    // check is part of the update itself so an edit can't slip in between.
    const syncedRows = check(
      await ordersQuery(deps)
        .update({ ...done, sync_state: 'synced' })
        .eq('id', order.id)
        .eq('organization_id', deps.orgId)
        .eq('bc_connection_id', deps.connectionId)
        .eq('local_version', version)
        .select('id'),
      'Could not save the sales order',
    ) as { id: string }[] | null
    if (syncedRows && syncedRows.length > 0) return 'synced'
    await updateOrder(deps, order.id, { ...done, sync_state: 'pending' })
    return 'pending'
  } catch (err) {
    const raw = err instanceof BcReferenceError ? err.bcMessage || err.message : err instanceof Error ? err.message : String(err)
    const message = raw || 'BC error'
    await updateOrder(deps, order.id, {
      sync_state: 'failed',
      sync_error: message,
      sync_attempts: order.sync_attempts + 1,
      updated_at: deps.now(),
    })
    return 'failed'
  }
}

/**
 * Writes the order's ship-to through the salesDocuments service (read once
 * per sync, after any customer switch). A saved code that still exists is
 * sent alone (BC fills the address from it); otherwise the code is made ''
 * and the one-off / billing-copy address fields that differ are sent.
 * `afterWrite` runs after each successful write. Returns the row's id (for the read-back).
 */
async function syncShipTo(
  deps: OrderSyncDeps,
  order: SalesOrderRow,
  no: string,
  afterWrite: () => Promise<void>,
): Promise<{ docId: string }> {
  const found = await deps.transport.list(SALES_DOCUMENT_SOURCE, {
    filter: `documentType eq 'Order' and number eq ${quote(no)}`,
  })
  let doc = found[0]
  const docId = doc ? String(doc.fields.id ?? '') : ''
  if (!doc || !docId) throw new Error(`BC sales document for order ${no} not found`)
  const docKey: BcKey = { values: { id: docId } }
  const patchDoc = async (fields: Record<string, unknown>) => {
    doc = await deps.transport.patch(SALES_DOCUMENT_SOURCE, docKey, doc.etag, fields)
    await afterWrite()
  }

  const code = await shipToCodeToSend(deps, order)
  const current = String(doc.fields.shipToCode ?? '')
  if (code !== '') {
    if (code !== current) await patchDoc({ shipToCode: code })
    return { docId }
  }
  if (current !== '') await patchDoc({ shipToCode: '' })
  const diff = changedLineFields(toSalesDocShipToAddress(order), doc.fields)
  if (Object.keys(diff).length > 0) await patchDoc(diff)
  return { docId }
}

/** A 404 counts as already removed only when a re-list confirms the line is gone. */
async function removeBcLine(deps: OrderSyncDeps, no: string, lineNo: number, etag: string): Promise<void> {
  try {
    await deps.transport.remove(SALES_LINE_SOURCE, lineKey(no, lineNo), etag)
  } catch (err) {
    if (!is404(err)) throw err
    const still = (await listBcLines(deps, no)).some((l) => parseLineNo(l) === lineNo)
    if (still) throw err
  }
}

/** Deletes the order in BC (fresh etag first). A missing BC order counts as already deleted. */
export async function deleteSalesOrderInBc(deps: OrderSyncDeps, order: SalesOrderRow): Promise<void> {
  if (order.organization_id !== deps.orgId || order.bc_connection_id !== deps.connectionId) {
    throw new Error('Sales order belongs to another organization or connection')
  }
  if (!order.bc_order_number) return
  const key = orderKey(order.bc_order_number)
  try {
    const current = await deps.transport.get(SALES_ORDER_SOURCE, key)
    await deps.transport.remove(SALES_ORDER_SOURCE, key, current.etag)
  } catch (err) {
    if (!is404(err)) throw err
  }
}
