// Business Central side of "Change invoice": read and cancel the old posted
// invoice, build the corrected one as a draft, check it, post it. Measured
// calls are in docs/superpowers/notes/2026-11-17-change-invoice-discovery.md.
//
// The draft is created through API v2 `salesInvoices` and its header is
// completed through the table-based `salesDocuments` service (tax area,
// location, posting groups, terms, dates, ship-to), which API v2 can't set.
// Lines go through API v2 `salesInvoiceLines`: they take the header's
// location and tax, so the header is completed before lines are added.
import type { BcRecord, ReferenceSource } from '@/lib/businessCentral/customerReferences/transport'
import type { ChangeLine } from '@/types/invoiceChanges'
import type { SalesOrderRow } from '@/types/salesOrders'
import { SALES_DOCUMENT_SOURCE, toSalesDocShipToAddress } from './bcOrderMapping'
import { invokePostingAction, quote, toPostedInvoice, type BcInvoicingDeps, type PostedInvoice } from './bcInvoicing'
import { changeSubtotalCents } from './invoiceChangeLines'

const INVOICES: ReferenceSource = { kind: 'api', resource: 'salesInvoices' }
const linesOf = (invoiceId: string): ReferenceSource => ({ kind: 'api', resource: `salesInvoices(${invoiceId})/salesInvoiceLines` })

/** BC statuses of an invoice that isn't a live posted invoice. */
const NOT_POSTED = new Set(['Draft', 'In Review'])
export const CANCELED = 'Canceled'

export interface BcInvoiceState extends PostedInvoice {
  /** BC's status: 'Draft', 'Open', 'Paid', 'Canceled', … */
  status: string
  externalDocumentNumber: string
  customerNumber: string
}

export interface DraftInvoice {
  /** API v2 id (= the Sales Header SystemId). */
  id: string
  no: string
}

function toState(r: BcRecord): BcInvoiceState {
  return {
    ...toPostedInvoice(r),
    status: String(r.fields.status ?? ''),
    externalDocumentNumber: String(r.fields.externalDocumentNumber ?? ''),
    customerNumber: String(r.fields.customerNumber ?? ''),
  }
}

/** The invoice (posted or draft) with this id, or null. `id` must be a GUID (it goes into the filter unquoted). */
export async function readBcInvoice(deps: BcInvoicingDeps, id: string): Promise<BcInvoiceState | null> {
  const found = await deps.transport.list(INVOICES, { filter: `id eq ${id}` })
  return found[0] ? toState(found[0]) : null
}

/** Cancels a posted invoice (BC posts a corrective credit memo). Can't be undone. */
export async function cancelBcInvoice(deps: BcInvoicingDeps, id: string): Promise<void> {
  await invokePostingAction(deps, `/salesInvoices(${id})/Microsoft.NAV.cancel`)
}

/** A live posted invoice with this Invoice # and customer other than `excludeId` (the corrected one). */
export async function findReplacementInvoice(
  deps: BcInvoicingDeps,
  q: { externalDocumentNumber: string; customerNumber: string; excludeId: string },
): Promise<BcInvoiceState | null> {
  const found = await deps.transport.list(INVOICES, {
    filter: `externalDocumentNumber eq ${quote(q.externalDocumentNumber)} and customerNumber eq ${quote(q.customerNumber)}`,
  })
  const match = found
    .map(toState)
    .find((i) => i.id !== q.excludeId && i.status !== CANCELED && !NOT_POSTED.has(i.status))
  return match ?? null
}

/** The change's draft: the saved id while it is still a draft, else a draft with this Invoice # and customer. */
export async function findDraftInvoice(
  deps: BcInvoicingDeps,
  q: { draftId: string | null; externalDocumentNumber: string; customerNumber: string },
): Promise<DraftInvoice | null> {
  if (q.draftId) {
    const saved = await readBcInvoice(deps, q.draftId)
    if (saved && saved.status === 'Draft') return { id: saved.id, no: saved.number }
  }
  const found = await deps.transport.list(INVOICES, {
    filter: `externalDocumentNumber eq ${quote(q.externalDocumentNumber)} and customerNumber eq ${quote(q.customerNumber)} and status eq 'Draft'`,
  })
  return found[0] ? { id: String(found[0].fields.id), no: String(found[0].fields.number) } : null
}

/**
 * A draft invoice for the order's customer with the old invoice's dates and
 * the order's header values (they matched BC when the order was invoiced).
 */
export async function createDraftInvoice(
  deps: BcInvoicingDeps,
  order: SalesOrderRow,
  old: PostedInvoice,
  externalDocumentNumber: string,
): Promise<DraftInvoice> {
  const dates = { postingDate: old.invoiceDate, documentDate: old.invoiceDate, ...(old.dueDate ? { dueDate: old.dueDate } : {}) }
  const created = await deps.transport.create(INVOICES, {
    customerNumber: order.customer_number,
    externalDocumentNumber,
    invoiceDate: old.invoiceDate,
    postingDate: old.invoiceDate,
    ...(old.dueDate ? { dueDate: old.dueDate } : {}),
  })
  const draft: DraftInvoice = { id: String(created.fields.id), no: String(created.fields.number) }

  // Ship-to first: BC refills tax area and location from it, so Nexus's values go after.
  const key = { values: { id: draft.id } }
  const doc = await deps.transport.get(SALES_DOCUMENT_SOURCE, key)
  const shipTo = order.ship_to_code ? { shipToCode: order.ship_to_code } : toSalesDocShipToAddress(order)
  const afterShipTo = await deps.transport.patch(SALES_DOCUMENT_SOURCE, key, doc.etag, shipTo)
  await deps.transport.patch(SALES_DOCUMENT_SOURCE, key, afterShipTo.etag, {
    taxAreaCode: order.tax_area_code,
    taxLiable: order.tax_liable,
    locationCode: order.location_code,
    genBusPostingGroup: order.gen_bus_posting_group,
    customerPostingGroup: order.customer_posting_group,
    paymentTermsCode: order.payment_terms_code,
    shipmentMethodCode: order.shipment_method_code,
    ...dates,
  })
  return draft
}

/** Makes the draft's lines exactly `lines` (removes what is there first, so it is safe to re-run). */
export async function setDraftLines(deps: BcInvoicingDeps, draft: DraftInvoice, lines: ChangeLine[]): Promise<void> {
  const source = linesOf(draft.id)
  for (const existing of await deps.transport.list(source)) {
    await deps.transport.remove(source, existing.key, existing.etag)
  }
  for (const l of lines) {
    await deps.transport.create(source, {
      lineType: 'Item',
      lineObjectNumber: l.item_number,
      description: l.description,
      ...(l.unit_of_measure_code ? { unitOfMeasureCode: l.unit_of_measure_code } : {}),
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discountPercent: l.discount_percent,
    })
  }
}

const plural = (n: number) => `${n} line${n === 1 ? '' : 's'}`
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`

/** Why the draft isn't the change's lines (count or subtotal before tax), or null. */
export async function checkDraft(deps: BcInvoicingDeps, draft: DraftInvoice, lines: ChangeLine[]): Promise<string | null> {
  const [header, bcLines] = await Promise.all([readBcInvoice(deps, draft.id), deps.transport.list(linesOf(draft.id))])
  if (!header) return `BC's draft ${draft.no} is gone.`
  const hasCents = Math.round(header.totalExclTax * 100)
  const wantCents = changeSubtotalCents(lines)
  if (bcLines.length === lines.length && hasCents === wantCents) return null
  return `BC's draft has ${plural(bcLines.length)} totalling ${dollars(hasCents)}, expected ${plural(lines.length)} totalling ${dollars(wantCents)}.`
}

/** Posts the draft. Same errors as invokePostingAction. */
export async function postDraftInvoice(deps: BcInvoicingDeps, draft: DraftInvoice): Promise<void> {
  await invokePostingAction(deps, `/salesInvoices(${draft.id})/Microsoft.NAV.post`)
}
