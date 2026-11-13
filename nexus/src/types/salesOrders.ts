// Shared types for Sales Orders and customer ship-to addresses.
// Row interfaces mirror migration 060_add_sales_orders_and_ship_tos.sql.

export const ORDER_STATUSES = ['draft', 'final', 'pulled', 'shipped', 'invoiced'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export type SyncState = 'pending' | 'synced' | 'failed' | 'conflict'

export interface ShipToValues {
  code: string
  name: string
  address: string
  address_2: string
  city: string
  state: string
  post_code: string
  country: string
  contact: string
  phone: string
  email: string
  tax_area_code: string
  location_code: string
  shipment_method_code: string
  tax_liable: boolean
}

export interface ShipToRow extends ShipToValues {
  id: string
  organization_id: string
  bc_connection_id: string
  customer_number: string
  bc_etag: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

/** The business_central_customers columns a sales order uses. */
export interface CustomerRow {
  id: string
  bc_customer_number: string | null
  display_name: string
  address_line_1: string | null
  address_line_2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
  phone_number: string | null
  email: string | null
  email_cc: string
  contact_no: string
  mobile_phone_no: string
  ship_to_code: string
  shipment_method_code: string
  payment_terms_code: string
  tax_area_code: string
  tax_liable: boolean
  customer_posting_group: string
  gen_bus_posting_group: string
  location_code: string
}

export interface SalesOrderRow {
  id: string
  organization_id: string
  bc_connection_id: string
  status: OrderStatus
  customer_id: string
  customer_number: string
  order_date: string
  requested_delivery_date: string | null
  invoice_number: string | null
  customer_po: string
  notes: string
  bill_name: string
  bill_address: string
  bill_address_2: string
  bill_city: string
  bill_state: string
  bill_post_code: string
  bill_country: string
  bill_contact_no: string
  bill_phone: string
  bill_mobile: string
  bill_email: string
  bill_email_cc: string
  ship_to_code: string
  ship_to_name: string
  ship_to_address: string
  ship_to_address_2: string
  ship_to_city: string
  ship_to_state: string
  ship_to_post_code: string
  ship_to_country: string
  ship_to_contact: string
  ship_to_phone: string
  payment_terms_code: string
  tax_area_code: string
  gen_bus_posting_group: string
  customer_posting_group: string
  shipment_method_code: string
  location_code: string
  tax_liable: boolean
  bc_order_number: string | null
  bc_etag: string | null
  bc_create_marker: string | null
  bc_due_date: string | null
  bc_document_date: string | null
  bc_posting_date: string | null
  total_excl_tax: number | null
  total_tax: number | null
  total_incl_tax: number | null
  sync_state: SyncState
  sync_error: string | null
  sync_attempts: number
  claimed_until: string | null
  last_synced_at: string | null
  local_version: number
  synced_version: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface SalesOrderLineRow {
  id: string
  organization_id: string
  bc_connection_id: string
  sales_order_id: string
  position: number
  item_number: string
  description: string
  unit_of_measure_code: string
  quantity: number
  unit_price: number | null
  discount_percent: number
  removed: boolean
  bc_line_no: number | null
  bc_etag: string | null
  bc_unit_price: number | null
  amount_incl_tax: number | null
  created_at: string
  updated_at: string
}

/** Header values copied from the customer when an order is started. */
export interface OrderHeaderDefaults {
  bill_name: string
  bill_address: string
  bill_address_2: string
  bill_city: string
  bill_state: string
  bill_post_code: string
  bill_country: string
  bill_contact_no: string
  bill_phone: string
  bill_mobile: string
  bill_email: string
  bill_email_cc: string
  ship_to_code: string
  ship_to_name: string
  ship_to_address: string
  ship_to_address_2: string
  ship_to_city: string
  ship_to_state: string
  ship_to_post_code: string
  ship_to_country: string
  ship_to_contact: string
  ship_to_phone: string
  payment_terms_code: string
  tax_area_code: string
  gen_bus_posting_group: string
  customer_posting_group: string
  shipment_method_code: string
  location_code: string
  tax_liable: boolean
}

/** A line as edited in the order form (not yet saved, or loaded for editing). */
export interface LineDraft {
  key: string
  id?: string
  item_number: string
  description: string
  quantity: number
  unit_price: number | null
  discount_percent: number
  unit_of_measure_code: string
  amount_incl_tax: number | null
  estimate_price: number | null
  /** BC's unit price from the last sync; shown for a blank price once synced. */
  bc_unit_price: number | null
}

/**
 * Input for creating/updating an order. A one-off ship-to travels as the
 * ship_to_* header fields with ship_to_code ''.
 */
export interface SalesOrderInput extends OrderHeaderDefaults {
  customer_id: string
  customer_number: string
  status: OrderStatus
  order_date: string
  requested_delivery_date: string | null
  invoice_number: string | null
  customer_po: string
  notes: string
  lines: LineDraft[]
}

/** A row in the sales orders list. */
export interface SalesOrderListRow {
  id: string
  status: OrderStatus
  customer_id: string
  customer_number: string
  customer_name: string
  order_date: string
  requested_delivery_date: string | null
  invoice_number: string | null
  bc_order_number: string | null
  customer_po: string
  total_incl_tax: number | null
  sync_state: SyncState
  sync_error: string | null
}
