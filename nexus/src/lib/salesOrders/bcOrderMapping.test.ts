import { describe, it, expect } from 'vitest'
import type { BcRecord } from '@/lib/businessCentral/customerReferences/transport'
import type { SalesOrderRow, SalesOrderLineRow } from '@/types/salesOrders'
import {
  SALES_ORDER_SOURCE,
  SALES_LINE_SOURCE,
  SALES_DOCUMENT_SOURCE,
  createMarker,
  toBcCreate,
  toSalesDocShipToAddress,
  toBcHeaderPatch,
  toBcLine,
  readBack,
  bcChangedOutsideNexus,
  parseLineNo,
} from './bcOrderMapping'

function order(over: Partial<SalesOrderRow> = {}): SalesOrderRow {
  return {
    id: 'abcdef12-3456-7890-abcd-ef1234567890',
    organization_id: 'o', bc_connection_id: 'c', status: 'final',
    customer_id: 'cu', customer_number: 'C100',
    order_date: '2026-11-01', requested_delivery_date: '2026-11-10',
    invoice_number: null, customer_po: 'PO-SECRET', notes: 'NOTE-SECRET',
    bill_name: 'Bill', bill_address: 'a1', bill_address_2: 'a2', bill_city: 'bc',
    bill_state: 'bs', bill_post_code: 'bp', bill_country: 'US', bill_contact_no: 'CT1',
    bill_phone: 'ph', bill_mobile: 'mo', bill_email: 'e@x.com', bill_email_cc: 'cc@x.com',
    ship_to_code: 'WH1', ship_to_name: 'sn', ship_to_address: 'sa', ship_to_address_2: 'sa2',
    ship_to_city: 'sc', ship_to_state: 'ss', ship_to_post_code: 'sp', ship_to_country: 'CA',
    ship_to_contact: 'sct', ship_to_phone: 'sph',
    payment_terms_code: 'NET30', tax_area_code: 'TX', gen_bus_posting_group: 'DOM',
    customer_posting_group: 'CP', shipment_method_code: 'UPS', location_code: 'MAIN',
    tax_liable: true, bc_order_number: null, bc_etag: null, bc_create_marker: null,
    bc_due_date: null, bc_document_date: null, bc_posting_date: null,
    total_excl_tax: null, total_tax: null, total_incl_tax: null,
    sync_state: 'pending', sync_error: null, sync_attempts: 0, claimed_until: null,
    last_synced_at: null, local_version: 1, synced_version: 0, created_by: null,
    created_at: '', updated_at: '',
    ...over,
  }
}

function line(over: Partial<SalesOrderLineRow> = {}): SalesOrderLineRow {
  return {
    id: 'l1', organization_id: 'o', bc_connection_id: 'c', sales_order_id: 'x', position: 1,
    item_number: 'ITEM1', description: 'd', unit_of_measure_code: 'PCS', quantity: 3,
    unit_price: 2.5, discount_percent: 10, removed: false, bc_line_no: null, bc_etag: null,
    bc_unit_price: null, amount_incl_tax: null, created_at: '', updated_at: '',
    ...over,
  }
}

const rec = (fields: Record<string, unknown>, etag = 'e'): BcRecord => ({ key: { values: {} }, etag, fields })

describe('sources and marker', () => {
  it('declares the OData sources', () => {
    expect(SALES_ORDER_SOURCE).toEqual({ kind: 'odata', service: 'SalesOrder', pageNumber: 42, keyFields: ['Document_Type', 'No'] })
    expect(SALES_LINE_SOURCE).toEqual({ kind: 'odata', service: 'SalesOrderSalesLines', pageNumber: 46, keyFields: ['Document_Type', 'Document_No', 'Line_No'], integerKeyFields: ['Line_No'] })
  })
  it('declares the salesDocuments source with a GUID id key', () => {
    expect(SALES_DOCUMENT_SOURCE).toMatchObject({ kind: 'odata', service: 'salesDocuments', keyFields: ['id'], guidKeyFields: ['id'] })
  })
  it('builds the marker', () => {
    expect(createMarker('abcdef12-3456-7890-abcd-ef1234567890')).toBe('NX-ABCDEF123456')
  })
})

describe('toBcCreate / toSalesDocShipToAddress', () => {
  it('creates with marker', () => {
    expect(toBcCreate(order(), 'NX-ABCDEF123456')).toEqual({ Document_Type: 'Order', Sell_to_Customer_No: 'C100', External_Document_No: 'NX-ABCDEF123456' })
    expect(toBcCreate(order(), 'NX-OTHER').External_Document_No).toBe('NX-OTHER')
  })
  it('ship-to address maps null values to empty strings', () => {
    const out = toSalesDocShipToAddress(order({ ship_to_address_2: null, ship_to_contact: null } as unknown as Partial<SalesOrderRow>))
    expect(out.shipToAddress2).toBe('')
    expect(out.shipToContact).toBe('')
  })
  it('ship-to address in salesDocuments (camelCase) field names', () => {
    expect(toSalesDocShipToAddress(order())).toEqual({
      shipToName: 'sn', shipToAddress: 'sa', shipToAddress2: 'sa2', shipToCity: 'sc', shipToCounty: 'ss',
      shipToPostCode: 'sp', shipToCountryRegionCode: 'CA', shipToContact: 'sct', shipToPhoneNo: 'sph',
    })
  })
})

describe('toBcHeaderPatch', () => {
  it('maps every field', () => {
    expect(toBcHeaderPatch(order(), 'SO-1001')).toEqual({
      Order_Date: '2026-11-01', Requested_Delivery_Date: '2026-11-10', External_Document_No: 'SO-1001',
      Sell_to_Address: 'a1', Sell_to_Address_2: 'a2', Sell_to_City: 'bc', Sell_to_County: 'bs',
      Sell_to_Post_Code: 'bp', Sell_to_Country_Region_Code: 'US', Sell_to_Contact_No: 'CT1',
      Sell_to_Phone_No: 'ph', SellToMobilePhoneNo: 'mo', Sell_to_E_Mail: 'e@x.com', EMailCCHCABG: 'cc@x.com',
      Payment_Terms_Code: 'NET30', Tax_Area_Code: 'TX', Tax_Liable: true, Gen_Bus_Posting_Group: 'DOM',
      Customer_Posting_Group: 'CP', Shipment_Method_Code: 'UPS', Location_Code: 'MAIN',
    })
  })
  it('sends no Ship_to_* field (read-only on page 42; they go through salesDocuments)', () => {
    expect(Object.keys(toBcHeaderPatch(order(), 'SO-1')).filter((k) => k.startsWith('Ship_to_'))).toEqual([])
  })
  it('uses invoice number when present', () => {
    expect(toBcHeaderPatch(order({ invoice_number: 'INV-9' }), 'SO-1001').External_Document_No).toBe('INV-9')
  })
  it('sends a null date and an empty location so clearing them reaches BC', () => {
    const p = toBcHeaderPatch(order({ requested_delivery_date: null, location_code: '' }), 'SO-1')
    expect(p).toHaveProperty('Requested_Delivery_Date', null)
    expect(p).toHaveProperty('Location_Code', '')
  })
  it('never sends customer PO or notes', () => {
    const outs = [toBcCreate(order(), 'NX-1'), toSalesDocShipToAddress(order()), toBcHeaderPatch(order(), 'SO-1'), toBcLine('SO-1', line(), 'MAIN')]
    for (const o of outs) {
      const json = JSON.stringify(o)
      for (const k of ['Customer_PO', 'notes', 'customer_po', 'PO-SECRET', 'NOTE-SECRET']) expect(json).not.toContain(k)
    }
  })
})

describe('toBcLine', () => {
  it('maps a line', () => {
    expect(toBcLine('SO-1', line(), 'MAIN')).toEqual({
      Document_Type: 'Order', Document_No: 'SO-1', Type: 'Item', No: 'ITEM1', Quantity: 3,
      Line_Discount_Percent: 10, Unit_of_Measure_Code: 'PCS', Unit_Price: 2.5, Location_Code: 'MAIN',
    })
  })
  it('omits Unit_Price when null, but always sends the header location (empty allowed)', () => {
    const l = toBcLine('SO-1', line({ unit_price: null }), '')
    expect(l).not.toHaveProperty('Unit_Price')
    expect(l).toHaveProperty('Location_Code', '')
  })
  it('omits Unit_of_Measure_Code when empty', () => {
    expect(toBcLine('SO-1', line({ unit_of_measure_code: '' }), 'MAIN')).not.toHaveProperty('Unit_of_Measure_Code')
  })
})

describe('readBack', () => {
  it('reads header and lines, with totals from salesDocuments (line Total_* fields are 0 over OData)', () => {
    const r = readBack(
      rec({ No: 'SO-1', Due_Date: '2026-12-01', Document_Date: '0001-01-01', Posting_Date: '2026-11-01' }, 'H'),
      [
        rec({ Line_No: 10000, Unit_Price: 2.5, Amount_Including_VAT: 8, Total_Amount_Excl_VAT: 0, Total_VAT_Amount: 0, Total_Amount_Incl_VAT: 0 }, 'L1'),
        rec({ Line_No: 20000 }, 'L2'),
      ],
      rec({ amount: 7, amountIncludingVAT: 8 }),
    )
    expect(r).toEqual({
      bc_order_number: 'SO-1', bc_etag: 'H', bc_due_date: '2026-12-01', bc_document_date: null, bc_posting_date: '2026-11-01',
      total_excl_tax: 7, total_tax: 1, total_incl_tax: 8,
      lines: [
        { bc_line_no: 10000, bc_etag: 'L1', bc_unit_price: 2.5, amount_incl_tax: 8 },
        { bc_line_no: 20000, bc_etag: 'L2', bc_unit_price: null, amount_incl_tax: null },
      ],
    })
  })
  it('tax is incl - excl rounded to cents (W-100528: 24.5 / 24.62)', () => {
    const r = readBack(rec({ No: 'W-100528' }), [], rec({ amount: 24.5, amountIncludingVAT: 24.62 }))
    expect([r.total_excl_tax, r.total_tax, r.total_incl_tax]).toEqual([24.5, 0.12, 24.62])
  })
  it('zero totals with no lines', () => {
    const r = readBack(rec({ No: 'SO-1' }), [], rec({ amount: 0, amountIncludingVAT: 0 }))
    expect([r.total_excl_tax, r.total_tax, r.total_incl_tax]).toEqual([0, 0, 0])
    expect(r.bc_due_date).toBeNull()
  })
})

describe('bcChangedOutsideNexus', () => {
  const stored = { bc_etag: 'H', lines: [{ bc_line_no: 1, bc_etag: 'a' }, { bc_line_no: 2, bc_etag: 'b' }] }
  const cur = (h = 'H', ls: [number, string][] = [[1, 'a'], [2, 'b']]) => ({
    header: rec({}, h), lines: ls.map(([n, e]) => rec({ Line_No: n }, e)),
  })
  it('false when identical', () => expect(bcChangedOutsideNexus(stored, cur())).toBe(false))
  it('true on header etag change', () => expect(bcChangedOutsideNexus(stored, cur('X'))).toBe(true))
  it('true on line etag change', () => expect(bcChangedOutsideNexus(stored, cur('H', [[1, 'a'], [2, 'z']]))).toBe(true))
  it('true when stored line missing in BC', () => expect(bcChangedOutsideNexus(stored, cur('H', [[1, 'a']]))).toBe(true))
  it('true when BC has an extra line', () => expect(bcChangedOutsideNexus(stored, cur('H', [[1, 'a'], [2, 'b'], [3, 'c']]))).toBe(true))
  const withUnsent = { bc_etag: 'H', lines: [...stored.lines, { bc_line_no: null, bc_etag: null }] }
  it('ignores unsent stored lines', () => expect(bcChangedOutsideNexus(withUnsent, cur())).toBe(false))
  it('unsent line present, other etag differs', () =>
    expect(bcChangedOutsideNexus(withUnsent, cur('H', [[1, 'a'], [2, 'z']]))).toBe(true))
  it('unsent line present, BC has unknown line', () =>
    expect(bcChangedOutsideNexus(withUnsent, cur('H', [[1, 'a'], [2, 'b'], [3, 'c']]))).toBe(true))
  it('parseLineNo reads Line_No', () => {
    expect(parseLineNo(rec({ Line_No: 30000 }))).toBe(30000)
    expect(() => parseLineNo(rec({ Line_No: '30000' }))).toThrow('without Line_No')
  })
  it('throws when BC line lacks Line_No', () => {
    expect(() => bcChangedOutsideNexus(stored, { header: rec({}, 'H'), lines: [rec({}, 'a')] })).toThrow('without Line_No')
    expect(() => readBack(rec({ No: 'SO-1' }), [rec({})], rec({ amount: 0, amountIncludingVAT: 0 }))).toThrow('without Line_No')
  })
})
