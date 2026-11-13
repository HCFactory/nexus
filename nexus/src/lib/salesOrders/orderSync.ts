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
// - Before writing to an existing order, BC's etags are compared with the
//   stored ones; a mismatch stops the sync as a conflict unless overwrite.
import type { SupabaseClient } from '@supabase/supabase-js'
import { BcReferenceError } from '@/lib/businessCentral/customerReferences/errors'
import type { BcKey, BcRecord, ReferenceTransport } from '@/lib/businessCentral/customerReferences/transport'
import type { SalesOrderLineRow, SalesOrderRow, SyncState } from '@/types/salesOrders'
import {
  SALES_LINE_SOURCE,
  SALES_ORDER_SOURCE,
  bcChangedOutsideNexus,
  createMarker,
  readBack,
  toBcCreate,
  toBcHeaderPatch,
  toBcLine,
  toBcShipToPatch,
} from './bcOrderMapping'

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

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`

const orderKey = (no: string): BcKey => ({ values: { Document_Type: 'Order', No: no } })
const lineKey = (no: string, lineNo: number): BcKey => ({
  values: { Document_Type: 'Order', Document_No: no, Line_No: String(lineNo) },
})

function bcLineNo(r: BcRecord): number {
  const n = r.fields.Line_No
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('BC returned a sales line without Line_No')
  return n
}

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

async function updateLine(
  deps: OrderSyncDeps,
  orderId: string,
  lineId: string,
  values: Record<string, unknown>,
): Promise<void> {
  check(
    await deps.supabase
      .from(LINES)
      .update(values)
      .eq('id', lineId)
      .eq('sales_order_id', orderId)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.connectionId),
    'Could not save the sales order line',
  )
}

async function loadOrder(deps: OrderSyncDeps, orderId: string): Promise<SalesOrderRow> {
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

async function loadLines(deps: OrderSyncDeps, orderId: string): Promise<SalesOrderLineRow[]> {
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

function listBcLines(deps: OrderSyncDeps, no: string): Promise<BcRecord[]> {
  return deps.transport.list(SALES_LINE_SOURCE, {
    filter: `Document_Type eq 'Order' and Document_No eq ${quote(no)}`,
  })
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

/** Steps 2.1-2.3: find or create the BC order and store its number right away. */
async function ensureBcOrder(deps: OrderSyncDeps, order: SalesOrderRow): Promise<string> {
  const marker = order.bc_create_marker ?? createMarker(order.id)
  const found = await deps.transport.list(SALES_ORDER_SOURCE, {
    filter: `Document_Type eq 'Order' and External_Document_No eq ${quote(marker)}`,
  })
  let no: string
  if (found.length > 0) {
    no = String(found[0].fields.No ?? '')
  } else {
    if (order.bc_create_marker === null) await updateOrder(deps, order.id, { bc_create_marker: marker })
    const created = await deps.transport.create(SALES_ORDER_SOURCE, toBcCreate(order))
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
  const version = order.local_version
  try {
    const lines = await loadLines(deps, orderId)
    let no: string
    let headerEtag: string
    let bcLines: BcRecord[]

    if (!order.bc_order_number) {
      no = await ensureBcOrder(deps, order)
      // Read back for the current etag: BC may touch the record after the POST.
      headerEtag = (await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))).etag
      bcLines = []
    } else {
      no = order.bc_order_number
      const header = await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))
      bcLines = await listBcLines(deps, no)
      // bc_etag stays null until Nexus's first header patch is stored, so there
      // is nothing of Nexus's in BC to compare yet (create succeeded, patch did not).
      const checkable = order.bc_etag !== null
      if (!opts.overwrite && checkable && bcChangedOutsideNexus({ bc_etag: order.bc_etag, lines }, { header, lines: bcLines })) {
        await updateOrder(deps, order.id, { sync_state: 'conflict', sync_error: CHANGED_IN_BC })
        return 'conflict'
      }
      headerEtag = header.etag
    }

    // Step 4: ship-to first (BC refills address/tax/location from it), then the header.
    headerEtag = (await deps.transport.patch(SALES_ORDER_SOURCE, orderKey(no), headerEtag, toBcShipToPatch(order))).etag
    headerEtag = (await deps.transport.patch(SALES_ORDER_SOURCE, orderKey(no), headerEtag, toBcHeaderPatch(order, no))).etag
    await updateOrder(deps, order.id, { bc_etag: headerEtag })

    // Step 5: lines.
    const bcByNo = new Map(bcLines.map((l) => [bcLineNo(l), l]))
    if (opts.overwrite) {
      const known = new Set(lines.map((l) => l.bc_line_no).filter((n): n is number => n !== null))
      for (const [n, rec] of bcByNo) {
        if (known.has(n)) continue
        await removeBcLine(deps, no, n, rec.etag)
        bcByNo.delete(n)
      }
    }
    for (const line of lines) {
      if (line.removed) {
        if (line.bc_line_no !== null) {
          const rec = bcByNo.get(line.bc_line_no)
          if (rec) await removeBcLine(deps, no, line.bc_line_no, rec.etag)
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
      if (line.bc_line_no === null) {
        const created = await deps.transport.create(SALES_LINE_SOURCE, wanted)
        await updateLine(deps, orderId, line.id, { bc_line_no: bcLineNo(created), bc_etag: created.etag })
        continue
      }
      const rec = bcByNo.get(line.bc_line_no)
      if (!rec) throw new Error(`Line ${line.position} (BC line ${line.bc_line_no}) is missing in BC`)
      const diff = changedLineFields(wanted, rec.fields)
      if (Object.keys(diff).length === 0) continue
      const patched = await deps.transport.patch(SALES_LINE_SOURCE, lineKey(no, line.bc_line_no), rec.etag, diff)
      await updateLine(deps, orderId, line.id, { bc_etag: patched.etag })
    }

    // Step 6: read back BC's values.
    const header = await deps.transport.get(SALES_ORDER_SOURCE, orderKey(no))
    const rb = readBack(header, await listBcLines(deps, no))
    const stored = await loadLines(deps, orderId)
    for (const l of rb.lines) {
      const row = stored.find((s) => s.bc_line_no === l.bc_line_no)
      if (!row) continue
      await updateLine(deps, orderId, row.id, {
        bc_etag: l.bc_etag,
        bc_unit_price: l.bc_unit_price,
        amount_incl_tax: l.amount_incl_tax,
      })
    }
    const done = {
      bc_order_number: rb.bc_order_number,
      bc_etag: rb.bc_etag,
      bc_due_date: rb.bc_due_date,
      bc_document_date: rb.bc_document_date,
      bc_posting_date: rb.bc_posting_date,
      total_excl_tax: rb.total_excl_tax,
      total_tax: rb.total_tax,
      total_incl_tax: rb.total_incl_tax,
      synced_version: version,
      last_synced_at: deps.now(),
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
    const message = err instanceof BcReferenceError ? err.bcMessage : err instanceof Error ? err.message : String(err)
    await updateOrder(deps, order.id, {
      sync_state: 'failed',
      sync_error: message,
      sync_attempts: order.sync_attempts + 1,
    })
    return 'failed'
  }
}

async function removeBcLine(deps: OrderSyncDeps, no: string, lineNo: number, etag: string): Promise<void> {
  try {
    await deps.transport.remove(SALES_LINE_SOURCE, lineKey(no, lineNo), etag)
  } catch (err) {
    if (!is404(err)) throw err
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
