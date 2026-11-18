import type { CustomerRow, OrderHeaderDefaults, ShipToRow } from '@/types/salesOrders'

const s = (v: string | null | undefined): string => v ?? ''

type ShipFields = Pick<
  OrderHeaderDefaults,
  | 'ship_to_code' | 'ship_to_name' | 'ship_to_address' | 'ship_to_address_2' | 'ship_to_city'
  | 'ship_to_state' | 'ship_to_post_code' | 'ship_to_country' | 'ship_to_contact' | 'ship_to_phone'
  | 'shipment_method_code' | 'tax_area_code' | 'tax_liable' | 'location_code'
>

function billingFrom(c: CustomerRow) {
  return {
    bill_name: s(c.display_name),
    bill_address: s(c.address_line_1),
    bill_address_2: s(c.address_line_2),
    bill_city: s(c.city),
    bill_state: s(c.state),
    bill_post_code: s(c.postal_code),
    bill_country: s(c.country),
    bill_contact_no: s(c.contact_no),
    bill_phone: s(c.phone_number),
    bill_mobile: s(c.mobile_phone_no),
    bill_email: s(c.email),
    bill_email_cc: s(c.email_cc),
  }
}

function shipFields(c: CustomerRow, shipTo: ShipToRow | null, companyLocation: string): ShipFields {
  const bill = billingFrom(c)
  const location = (shipTo && shipTo.location_code) || c.location_code || companyLocation || ''
  if (!shipTo) {
    return {
      ship_to_code: '',
      ship_to_name: bill.bill_name,
      ship_to_address: bill.bill_address,
      ship_to_address_2: bill.bill_address_2,
      ship_to_city: bill.bill_city,
      ship_to_state: bill.bill_state,
      ship_to_post_code: bill.bill_post_code,
      ship_to_country: bill.bill_country,
      ship_to_contact: '',
      ship_to_phone: bill.bill_phone,
      shipment_method_code: s(c.shipment_method_code),
      tax_area_code: s(c.tax_area_code),
      tax_liable: c.tax_liable,
      location_code: location,
    }
  }
  const ownTax = !!shipTo.tax_area_code
  return {
    ship_to_code: shipTo.code,
    ship_to_name: s(shipTo.name),
    ship_to_address: s(shipTo.address),
    ship_to_address_2: s(shipTo.address_2),
    ship_to_city: s(shipTo.city),
    ship_to_state: s(shipTo.state),
    ship_to_post_code: s(shipTo.post_code),
    ship_to_country: s(shipTo.country),
    ship_to_contact: s(shipTo.contact),
    ship_to_phone: s(shipTo.phone),
    shipment_method_code: shipTo.shipment_method_code || s(c.shipment_method_code),
    tax_area_code: ownTax ? shipTo.tax_area_code : s(c.tax_area_code),
    tax_liable: ownTax ? shipTo.tax_liable : c.tax_liable,
    location_code: location,
  }
}

/** Header values for a new order: customer billing, optional default ship-to, terms. */
export function customerDefaults(
  customer: CustomerRow,
  defaultShipTo: ShipToRow | null,
  companyLocation: string,
): OrderHeaderDefaults {
  return {
    ...billingFrom(customer),
    ...shipFields(customer, defaultShipTo, companyLocation),
    payment_terms_code: s(customer.payment_terms_code),
    gen_bus_posting_group: s(customer.gen_bus_posting_group),
    customer_posting_group: s(customer.customer_posting_group),
  }
}

/** Switch the header to a ship-to (or back to the billing address with null); billing is untouched. */
export function applyShipTo(
  header: OrderHeaderDefaults,
  customer: CustomerRow,
  shipTo: ShipToRow | null,
  companyLocation: string,
): OrderHeaderDefaults {
  return { ...header, ...shipFields(customer, shipTo, companyLocation) }
}
