// Pure mapping between Nexus sales orders and BC's published OData pages
// SalesOrder (42) and SalesOrderSalesLines (46). No I/O.
import type { BcRecord, ReferenceSource } from '@/lib/businessCentral/customerReferences/transport'
import type { SalesOrderRow, SalesOrderLineRow } from '@/types/salesOrders'

export const SALES_ORDER_SOURCE: ReferenceSource = {
  kind: 'odata',
  service: 'SalesOrder',
  pageNumber: 42,
  keyFields: ['Document_Type', 'No'],
}

export const SALES_LINE_SOURCE: ReferenceSource = {
  kind: 'odata',
  service: 'SalesOrderSalesLines',
  pageNumber: 46,
  keyFields: ['Document_Type', 'Document_No', 'Line_No'],
}

export function createMarker(orderId: string): string {
  return 'NX-' + orderId.replace(/-/g, '').slice(0, 12).toUpperCase()
}

export function toBcCreate(order: SalesOrderRow): Record<string, unknown> {
  return {
    Document_Type: 'Order',
    Sell_to_Customer_No: order.customer_number,
    External_Document_No: createMarker(order.id),
  }
}

/** Sent first: validating Ship_to_Code refills address, tax area and location in BC. */
export function toBcShipToPatch(order: SalesOrderRow): Record<string, unknown> {
  return { Ship_to_Code: order.ship_to_code ? order.ship_to_code : '' }
}

export function toBcHeaderPatch(order: SalesOrderRow, bcNumber: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    Order_Date: order.order_date,
    External_Document_No: order.invoice_number ?? bcNumber,
    Sell_to_Address: order.bill_address,
    Sell_to_Address_2: order.bill_address_2,
    Sell_to_City: order.bill_city,
    Sell_to_County: order.bill_state,
    Sell_to_Post_Code: order.bill_post_code,
    Sell_to_Country_Region_Code: order.bill_country,
    Sell_to_Contact_No: order.bill_contact_no,
    Sell_to_Phone_No: order.bill_phone,
    SellToMobilePhoneNo: order.bill_mobile,
    Sell_to_E_Mail: order.bill_email,
    EMailCCHCABG: order.bill_email_cc,
    Ship_to_Name: order.ship_to_name,
    Ship_to_Address: order.ship_to_address,
    Ship_to_Address_2: order.ship_to_address_2,
    Ship_to_City: order.ship_to_city,
    Ship_to_County: order.ship_to_state,
    Ship_to_Post_Code: order.ship_to_post_code,
    Ship_to_Country_Region_Code: order.ship_to_country,
    Ship_to_Contact: order.ship_to_contact,
    Ship_to_Phone_No: order.ship_to_phone,
    Payment_Terms_Code: order.payment_terms_code,
    Tax_Area_Code: order.tax_area_code,
    Tax_Liable: order.tax_liable,
    Gen_Bus_Posting_Group: order.gen_bus_posting_group,
    Customer_Posting_Group: order.customer_posting_group,
    Shipment_Method_Code: order.shipment_method_code,
  }
  if (order.requested_delivery_date !== null) patch.Requested_Delivery_Date = order.requested_delivery_date
  if (order.location_code !== '') patch.Location_Code = order.location_code
  return patch
}

export function toBcLine(
  orderNumber: string,
  line: SalesOrderLineRow,
  locationCode: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Document_Type: 'Order',
    Document_No: orderNumber,
    Type: 'Item',
    No: line.item_number,
    Quantity: line.quantity,
    Line_Discount_Percent: line.discount_percent,
    Unit_of_Measure_Code: line.unit_of_measure_code,
  }
  if (line.unit_price !== null) out.Unit_Price = line.unit_price
  if (locationCode !== '') out.Location_Code = locationCode
  return out
}

const BC_EMPTY_DATE = '0001-01-01'

function dateOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v === '' || v === BC_EMPTY_DATE) return null
  return v
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function lineNo(r: BcRecord): number {
  const n = r.fields.Line_No
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error('BC returned a sales line without Line_No')
  }
  return n
}

export interface BcReadBack {
  bc_order_number: string
  bc_etag: string
  bc_due_date: string | null
  bc_document_date: string | null
  bc_posting_date: string | null
  total_excl_tax: number
  total_tax: number
  total_incl_tax: number
  lines: { bc_line_no: number; bc_etag: string; bc_unit_price: number | null; amount_incl_tax: number | null }[]
}

export function readBack(header: BcRecord, lines: BcRecord[]): BcReadBack {
  const first = lines[0]?.fields
  return {
    bc_order_number: String(header.fields.No ?? ''),
    bc_etag: header.etag,
    bc_due_date: dateOrNull(header.fields.Due_Date),
    bc_document_date: dateOrNull(header.fields.Document_Date),
    bc_posting_date: dateOrNull(header.fields.Posting_Date),
    total_excl_tax: numOrNull(first?.Total_Amount_Excl_VAT) ?? 0,
    total_tax: numOrNull(first?.Total_VAT_Amount) ?? 0,
    total_incl_tax: numOrNull(first?.Total_Amount_Incl_VAT) ?? 0,
    lines: lines.map((l) => ({
      bc_line_no: lineNo(l),
      bc_etag: l.etag,
      bc_unit_price: numOrNull(l.fields.Unit_Price),
      amount_incl_tax: numOrNull(l.fields.Amount_Including_VAT),
    })),
  }
}

/** Stored lines without a bc_line_no were never sent to BC, so they are ignored. */
export function bcChangedOutsideNexus(
  stored: { bc_etag: string | null; lines: { bc_line_no: number | null; bc_etag: string | null }[] },
  current: { header: BcRecord; lines: BcRecord[] },
): boolean {
  if (stored.bc_etag !== current.header.etag) return true
  const bcByNo = new Map(current.lines.map((l) => [lineNo(l), l.etag]))
  const known = new Set<number>()
  for (const s of stored.lines) {
    if (s.bc_line_no === null) continue
    known.add(s.bc_line_no)
    if (bcByNo.get(s.bc_line_no) !== s.bc_etag) return true
  }
  for (const no of bcByNo.keys()) if (!known.has(no)) return true
  return false
}
