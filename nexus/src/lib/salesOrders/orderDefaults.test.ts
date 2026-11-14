import { describe, it, expect } from 'vitest'
import { customerDefaults, applyShipTo } from './orderDefaults'
import type { CustomerRow, ShipToRow } from '@/types/salesOrders'

const customer: CustomerRow = {
  id: 'c1', bc_customer_number: '10000', display_name: 'Acme Co',
  address_line_1: '1 Main St', address_line_2: 'Suite 2', city: 'Honolulu', state: 'HI',
  postal_code: '96813', country: 'US', phone_number: '555-1111', email: 'a@acme.com',
  email_cc: 'cc@acme.com', contact_no: 'CT001', mobile_phone_no: '555-2222',
  ship_to_code: 'DOCK', shipment_method_code: 'GROUND', payment_terms_code: 'NET30',
  tax_area_code: 'HI-STATE', tax_liable: true, customer_posting_group: 'DOM',
  gen_bus_posting_group: 'RETAIL', location_code: 'MAIN', customer_price_group: '',
}
const dock: ShipToRow = {
  id: 's1', organization_id: 'o', bc_connection_id: 'b', customer_number: '10000',
  bc_etag: null, last_synced_at: null, created_at: '', updated_at: '',
  code: 'DOCK', name: 'Acme Dock', address: '9 Pier Rd', address_2: 'Bay 3', city: 'Kapolei',
  state: 'HI', post_code: '96707', country: 'US', contact: 'Bob', phone: '555-3333',
  email: '', tax_area_code: 'HI-OAHU', location_code: 'WH2', shipment_method_code: '', tax_liable: false,
}

describe('customerDefaults', () => {
  it('uses the default ship-to with overrides', () => {
    const d = customerDefaults(customer, dock, 'COMPANY')
    expect(d.ship_to_code).toBe('DOCK')
    expect(d.ship_to_name).toBe('Acme Dock')
    expect(d.ship_to_address).toBe('9 Pier Rd')
    expect(d.ship_to_contact).toBe('Bob')
    expect(d.ship_to_phone).toBe('555-3333')
    expect(d.tax_area_code).toBe('HI-OAHU')
    expect(d.tax_liable).toBe(false)
    expect(d.location_code).toBe('WH2')
    expect(d.shipment_method_code).toBe('GROUND')
    expect(d.payment_terms_code).toBe('NET30')
    expect(d.bill_name).toBe('Acme Co')
    expect(d.bill_address).toBe('1 Main St')
    expect(d.bill_email_cc).toBe('cc@acme.com')
    expect(d.bill_contact_no).toBe('CT001')
    expect(d.bill_mobile).toBe('555-2222')
  })
  it('copies billing into ship-to when there is none', () => {
    const d = customerDefaults(customer, null, 'COMPANY')
    expect(d.ship_to_code).toBe('')
    expect(d.ship_to_name).toBe('Acme Co')
    expect(d.ship_to_address).toBe('1 Main St')
    expect(d.ship_to_address_2).toBe('Suite 2')
    expect(d.ship_to_city).toBe('Honolulu')
    expect(d.ship_to_post_code).toBe('96813')
    expect(d.ship_to_contact).toBe('')
    expect(d.ship_to_phone).toBe('555-1111')
    expect(d.tax_area_code).toBe('HI-STATE')
    expect(d.tax_liable).toBe(true)
    expect(d.location_code).toBe('MAIN')
  })
  it('turns nulls into empty strings', () => {
    const d = customerDefaults({ ...customer, email: null, address_line_2: null, phone_number: null }, null, '')
    expect(d.bill_email).toBe('')
    expect(d.bill_address_2).toBe('')
    expect(d.ship_to_phone).toBe('')
  })
  it('follows the location chain', () => {
    const noLoc = { ...customer, location_code: '' }
    expect(customerDefaults(noLoc, { ...dock, location_code: '' }, 'COMPANY').location_code).toBe('COMPANY')
    expect(customerDefaults(noLoc, { ...dock, location_code: '' }, '').location_code).toBe('')
  })
  it('keeps customer tax_liable when ship-to has no tax area', () => {
    const d = customerDefaults(customer, { ...dock, tax_area_code: '', tax_liable: false }, '')
    expect(d.tax_area_code).toBe('HI-STATE')
    expect(d.tax_liable).toBe(true)
  })
})

describe('applyShipTo', () => {
  it('resets to billing, customer tax area and customer location with null', () => {
    const header = customerDefaults(customer, dock, 'COMPANY')
    const r = applyShipTo(header, customer, null, 'MAIN')
    expect(r.ship_to_code).toBe('')
    expect(r.ship_to_address).toBe('1 Main St')
    expect(r.tax_area_code).toBe('HI-STATE')
    expect(r.location_code).toBe('MAIN')
    expect(r.bill_name).toBe('Acme Co')
  })
  it('keeps edited billing fields when switching ship-to', () => {
    const header = { ...customerDefaults(customer, null, ''), bill_name: 'Edited' }
    const r = applyShipTo(header, customer, dock, '')
    expect(r.bill_name).toBe('Edited')
    expect(r.ship_to_code).toBe('DOCK')
    expect(r.location_code).toBe('WH2')
  })
})
