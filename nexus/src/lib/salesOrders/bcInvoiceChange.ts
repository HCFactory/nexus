// Business Central side of "Change invoice": read and cancel the old posted
// invoice, build the corrected one as a draft, check it, post it. Measured
// calls are in docs/superpowers/notes/2026-11-17-change-invoice-discovery.md.
//
// The draft is created through API v2 `salesInvoices` and its header is
// completed through the table-based `salesDocuments` service (tax area,
// location, posting groups, terms, dates, ship-to), which API v2 can't set.
// Lines go through API v2 `salesInvoiceLines`: they take the header's
// location and tax, so the header is completed before lines are added.
import type { BcKey, BcRecord, ReferenceSource } from '@/lib/businessCentral/customerReferences/transport'
import type { ChangeLine } from '@/types/invoiceChanges'
import type { SalesOrderRow } from '@/types/salesOrders'
import { SALES_DOCUMENT_SOURCE, toSalesDocShipToAddress } from './bcOrderMapping'
import { invokePostingAction, quote, toPostedInvoice, type BcInvoicingDeps, type PostedInvoice } from './bcInvoicing'
import { changeSubtotalCents } from './invoiceChangeLines'

const INVOICES: ReferenceSource = { kind: 'api', resource: 'salesInvoices' }
const linesOf = (invoiceId: string): ReferenceSource => ({ kind: 'api', resource: `salesInvoices(${invoiceId})/salesInvoiceLines` })

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

/** The change's draft: the saved id while it is still a draft, else a draft with this Invoice # and customer. */
export async function findDraftInvoice(
  deps: BcInvoicingDeps,
  q: { draftId: string | null; externalDocumentNumber: string; customerNumber: string },
): Promise<DraftInvoice | null> {
  if (q.draftId) {
    const saved = await readBcInvoice(deps, q.draftId)
    if (saved && saved.status === 'Draft') return { id: saved.id, no: saved.number }
  }
  // A blank Invoice # would match any blank-numbered draft of the customer.
  if (!q.externalDocumentNumber.trim()) return null
  const found = await deps.transport.list(INVOICES, {
    filter: `externalDocumentNumber eq ${quote(q.externalDocumentNumber)} and customerNumber eq ${quote(q.customerNumber)} and status eq 'Draft'`,
  })
  return found[0] ? { id: String(found[0].fields.id), no: String(found[0].fields.number) } : null
}

/** A draft as listed for the duplicate check: enough to show it and to delete it. */
export interface ListedDraft extends DraftInvoice {
  totalExclTax: number
  key: BcKey
  etag: string
}

/** Every draft with this Invoice # and customer (more than one = duplicates; nothing may be posted). */
export async function listChangeDrafts(
  deps: BcInvoicingDeps,
  q: { externalDocumentNumber: string; customerNumber: string },
): Promise<ListedDraft[]> {
  if (!q.externalDocumentNumber.trim()) return []
  const found = await deps.transport.list(INVOICES, {
    filter: `externalDocumentNumber eq ${quote(q.externalDocumentNumber)} and customerNumber eq ${quote(q.customerNumber)} and status eq 'Draft'`,
  })
  return found.map((r) => ({
    id: String(r.fields.id),
    no: String(r.fields.number),
    totalExclTax: Number(r.fields.totalAmountExcludingTax ?? 0),
    key: r.key,
    etag: r.etag,
  }))
}

/** Deletes a draft invoice (never a posted one: BC refuses that). */
export async function deleteDraftInvoice(deps: BcInvoicingDeps, draft: ListedDraft): Promise<void> {
  await deps.transport.remove(INVOICES, draft.key, draft.etag)
}

/**
 * A draft invoice for the order's customer with the old invoice's dates. Its
 * other header values come from applyDraftHeader, which callers run every
 * time the draft is used (a crash between the two must not leave BC's
 * customer defaults in place).
 */
export async function createDraftInvoice(
  deps: BcInvoicingDeps,
  order: SalesOrderRow,
  old: PostedInvoice,
  externalDocumentNumber: string,
): Promise<DraftInvoice> {
  const created = await deps.transport.create(INVOICES, {
    customerNumber: order.customer_number,
    externalDocumentNumber,
    invoiceDate: old.invoiceDate,
    postingDate: old.invoiceDate,
    ...(old.dueDate ? { dueDate: old.dueDate } : {}),
  })
  return { id: String(created.fields.id), no: String(created.fields.number) }
}

/**
 * The draft's header from the order (ship-to, tax area, location, posting
 * groups, terms, shipment method; they matched BC when the order was
 * invoiced) and the old invoice's dates. Safe to repeat.
 */
export async function applyDraftHeader(deps: BcInvoicingDeps, draft: DraftInvoice, order: SalesOrderRow, old: PostedInvoice): Promise<void> {
  const dates = { postingDate: old.invoiceDate, documentDate: old.invoiceDate, ...(old.dueDate ? { dueDate: old.dueDate } : {}) }
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

/**
 * Why the draft isn't the change's lines (count, or subtotal before tax off
 * by more than 1 cent per line for rounding), or null.
 */
export async function checkDraft(deps: BcInvoicingDeps, draft: DraftInvoice, lines: ChangeLine[]): Promise<string | null> {
  const [header, bcLines] = await Promise.all([readBcInvoice(deps, draft.id), deps.transport.list(linesOf(draft.id))])
  if (!header) return `BC's draft ${draft.no} is gone.`
  const hasCents = Math.round(header.totalExclTax * 100)
  const wantCents = changeSubtotalCents(lines)
  if (bcLines.length === lines.length && Math.abs(hasCents - wantCents) <= lines.length) return null
  return `BC's draft has ${plural(bcLines.length)} totalling ${dollars(hasCents)}, expected ${plural(lines.length)} totalling ${dollars(wantCents)}.`
}

/** Posts the draft. Same errors as invokePostingAction. */
export async function postDraftInvoice(deps: BcInvoicingDeps, draft: DraftInvoice): Promise<void> {
  await invokePostingAction(deps, `/salesInvoices(${draft.id})/Microsoft.NAV.post`)
}
