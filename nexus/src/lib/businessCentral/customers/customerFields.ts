import type { FieldSpec } from '@/types/customerReferences';

type Opts = Partial<FieldSpec>;

function f(name: string, bcName: string, label: string, type: FieldSpec['type'], opts: Opts = {}): FieldSpec {
  return { name, bcName, label, type, editable: true, ...opts };
}

/** Customer fields editable from Nexus. `name` = business_central_customers column; `bcName` = Customer_Card_Excel field. */
export const CUSTOMER_FIELDS: FieldSpec[] = [
  f('display_name', 'Name', 'Name', 'text', { required: true, maxLength: 100 }),
  f('email', 'E_Mail', 'Email', 'text', { required: true, maxLength: 80 }),
  f('email_cc', 'EMailCCHCABG', 'Invoice email CC', 'text', { listHidden: true }),
  f('phone_number', 'Phone_No', 'Phone', 'text', { required: true, maxLength: 30 }),
  f('address_line_1', 'Address', 'Address', 'text', { maxLength: 100, listHidden: true }),
  f('address_line_2', 'Address_2', 'Address 2', 'text', { maxLength: 50, listHidden: true }),
  f('city', 'City', 'City', 'text', { maxLength: 30 }),
  f('state', 'County', 'State', 'text', { maxLength: 30, listHidden: true }),
  f('postal_code', 'Post_Code', 'Postal code', 'text', { maxLength: 20, listHidden: true }),
  f('country', 'Country_Region_Code', 'Country/region code', 'text', { maxLength: 10, listHidden: true }),
  f('payment_terms_code', 'Payment_Terms_Code', 'Payment terms', 'select', { required: true, optionsFrom: 'paymentTerms' }),
  f('tax_area_code', 'Tax_Area_Code', 'Tax area', 'select', { required: true, optionsFrom: 'taxAreas' }),
  f('tax_liable', 'Tax_Liable', 'Tax liable', 'boolean', { listHidden: true }),
  f('tax_identification_type', 'Tax_Identification_Type', 'Tax identification type', 'select', {
    listHidden: true,
    options: [
      { value: 'Legal Entity', label: 'Legal Entity' },
      { value: 'Natural Person', label: 'Natural Person' },
    ],
  }),
  f('customer_price_group', 'Customer_Price_Group', 'Customer price group', 'select', { optionsFrom: 'customerPriceGroups' }),
  f('customer_posting_group', 'Customer_Posting_Group', 'Customer posting group', 'select', { listHidden: true, optionsFrom: 'customerPostingGroups' }),
  f('gen_bus_posting_group', 'Gen_Bus_Posting_Group', 'Gen. business posting group', 'select', { listHidden: true, optionsFrom: 'generalBusinessPostingGroups' }),
  f('application_method', 'Application_Method', 'Application method', 'select', {
    listHidden: true,
    options: [
      { value: 'Manual', label: 'Manual' },
      { value: 'Apply to Oldest', label: 'Apply to Oldest' },
    ],
  }),
  f('location_code', 'Location_Code', 'Location', 'select', { listHidden: true, optionsFrom: 'locations' }),
  f('blocked', 'Blocked', 'Blocked', 'select', {
    options: [
      { value: ' ', label: 'Not blocked' },
      { value: 'Ship', label: 'Ship' },
      { value: 'Invoice', label: 'Invoice' },
      { value: 'All', label: 'All' },
    ],
  }),
  f('credit_limit', 'Credit_Limit_LCY', 'Credit limit', 'number', { listHidden: true }),
];

/** Customer template column -> customer column it pre-fills. */
export const TEMPLATE_TO_CUSTOMER: Record<string, string> = {
  customer_posting_group: 'customer_posting_group',
  gen_bus_posting_group: 'gen_bus_posting_group',
  customer_price_group: 'customer_price_group',
  payment_terms_code: 'payment_terms_code',
  tax_area_code: 'tax_area_code',
  tax_liable: 'tax_liable',
  tax_identification_type: 'tax_identification_type',
  application_method: 'application_method',
  location_code: 'location_code',
};
