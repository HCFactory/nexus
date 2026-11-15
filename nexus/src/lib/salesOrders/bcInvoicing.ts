// Business Central side of "Create invoice": date the order, post it
// (ship and invoice), and read back the posted sales invoice. Measured calls
// are in docs/superpowers/notes/2026-11-15-invoice-discovery.md.
import { BcApiError } from '@/lib/businessCentral/client'
import type { BcKey, BcRecord } from '@/lib/businessCentral/customerReferences/transport'
import { SALES_ORDER_SOURCE } from './bcOrderMapping'
import type { OrderSyncDeps } from './orderSync'

export interface PostedInvoice {
  id: string
  number: string
  invoiceDate: string
  dueDate: string | null
  totalExclTax: number
  totalTax: number
  totalInclTax: number
}

export interface BcInvoicingDeps extends OrderSyncDeps {
  /** POST a company-relative bound action path (no body, 204 expected). */
  invokeAction(path: string): Promise<void>
}

/** BC refused the post (4xx): nothing was posted. `message` is BC's error.message. */
export class BcPostRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BcPostRefusedError'
  }
}

/** Timeout, network error or 5xx on the post: BC may or may not have posted. */
export class BcPostOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BcPostOutcomeUnknownError'
  }
}

const INVOICES = { kind: 'api', resource: 'salesInvoices' } as const
const ORDERS_API = { kind: 'api', resource: 'salesOrders' } as const

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`

const orderKey = (no: string): BcKey => ({ values: { Document_Type: 'Order', No: no } })

function toPostedInvoice(r: BcRecord): PostedInvoice {
  const f = r.fields
  return {
    id: String(f.id),
    number: String(f.number),
    invoiceDate: String(f.invoiceDate),
    dueDate: f.dueDate ? String(f.dueDate) : null,
    totalExclTax: Number(f.totalAmountExcludingTax),
    totalTax: Number(f.totalTaxAmount),
    totalInclTax: Number(f.totalAmountIncludingTax),
  }
}

export async function findPostedInvoice(
  deps: BcInvoicingDeps,
  q: { orderNumber: string; externalDocumentNumber: string; customerNumber: string },
): Promise<PostedInvoice | null> {
  const byOrder = await deps.transport.list(INVOICES, {
    filter: `orderNumber eq ${quote(q.orderNumber)}`,
  })
  if (byOrder.length > 0) return toPostedInvoice(byOrder[0])
  // A blank External Document No. would match any blank-ext invoice of the customer.
  if (!q.externalDocumentNumber.trim()) return null
  const byExternal = await deps.transport.list(INVOICES, {
    filter: `externalDocumentNumber eq ${quote(q.externalDocumentNumber)} and customerNumber eq ${quote(q.customerNumber)}`,
  })
  // Ignore invoices that belong to a different order.
  const match = byExternal.find((r) => {
    const on = String(r.fields.orderNumber ?? '').trim()
    return on === '' || on === q.orderNumber
  })
  return match ? toPostedInvoice(match) : null
}

export async function setInvoiceDates(deps: BcInvoicingDeps, bcOrderNumber: string, today: string): Promise<void> {
  const key = orderKey(bcOrderNumber)
  const fresh = await deps.transport.get(SALES_ORDER_SOURCE, key)
  await deps.transport.patch(SALES_ORDER_SOURCE, key, fresh.etag, {
    Document_Date: today,
    Posting_Date: today,
  })
}

/**
 * Posts the order. Throws BcPostRefusedError when BC refused (nothing posted)
 * and BcPostOutcomeUnknownError on timeout, network error or 5xx. After an
 * unknown outcome callers MUST call findPostedInvoice before deciding, since
 * BC may have posted.
 */
export async function postShipAndInvoice(deps: BcInvoicingDeps, bcOrderNumber: string): Promise<void> {
  const found = await deps.transport.list(ORDERS_API, { filter: `number eq ${quote(bcOrderNumber)}` })
  const id = found[0]?.fields.id
  if (!id) throw new Error(`Business Central order ${bcOrderNumber} was not found.`)
  try {
    await deps.invokeAction(`/salesOrders(${String(id)})/Microsoft.NAV.shipAndInvoice`)
  } catch (e) {
    if (e instanceof BcApiError) {
      const { status } = e.details
      if (status >= 400 && status < 500) throw new BcPostRefusedError(e.message)
      throw new BcPostOutcomeUnknownError(e.message)
    }
    throw e
  }
}
