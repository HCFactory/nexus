import 'server-only';
import type { FieldSpec, ListKey } from '@/types/customerReferences';
import type { ListDefinition } from './listDefinition';

type Opts = Partial<FieldSpec>;

function f(name: string, bcName: string, label: string, type: FieldSpec['type'], editable: boolean, opts: Opts = {}): FieldSpec {
  return { name, bcName, label, type, editable, ...opts };
}

/** Marks every field read-only (used by the three readOnly lists). */
function readOnly(fields: FieldSpec[]): FieldSpec[] {
  return fields.map((x) => ({ ...x, editable: false }));
}

const odata = (service: string, pageNumber: number, keyFields: string[]) =>
  ({ kind: 'odata', service, pageNumber, keyFields }) as const;

export const LIST_DEFINITIONS: Record<ListKey, ListDefinition> = {
  paymentTerms: {
    key: 'paymentTerms', title: 'Payment terms', table: 'business_central_payment_terms', mode: 'managed',
    source: { kind: 'api', resource: 'paymentTerms' }, renameField: 'code',
    fields: [
      f('code', 'code', 'Code', 'text', true, { required: true, isKey: true, maxLength: 10 }),
      f('display_name', 'displayName', 'Description', 'text', true, { maxLength: 100 }),
      f('due_date_calculation', 'dueDateCalculation', 'Due date calculation', 'dateFormula', true),
      f('discount_date_calculation', 'discountDateCalculation', 'Discount date calculation', 'dateFormula', true),
      f('discount_percent', 'discountPercent', 'Discount %', 'percent', true),
      f('calculate_discount_on_credit_memos', 'calculateDiscountOnCreditMemos', 'Calc. discount on credit memos', 'boolean', true),
    ],
  },
  customerPriceGroups: {
    key: 'customerPriceGroups', title: 'Customer price groups', table: 'business_central_customer_price_groups', mode: 'managed',
    source: odata('CustomerPriceGroups', 7, ['Code']), renameField: 'code',
    fields: [
      f('code', 'Code', 'Code', 'text', true, { required: true, isKey: true, maxLength: 10 }),
      f('display_name', 'Description', 'Description', 'text', true, { maxLength: 100 }),
      f('allow_invoice_disc', 'Allow_Invoice_Disc', 'Allow invoice discount', 'boolean', true),
      f('allow_line_disc', 'Allow_Line_Disc', 'Allow line discount', 'boolean', true),
      f('price_includes_vat', 'Price_Includes_VAT', 'Price includes VAT', 'boolean', true),
    ],
  },
  taxAreas: {
    key: 'taxAreas', title: 'Tax areas', table: 'business_central_tax_areas', mode: 'managed',
    source: { kind: 'api', resource: 'taxAreas' }, renameField: 'code',
    fields: [
      f('code', 'code', 'Code', 'text', true, { required: true, isKey: true, maxLength: 20 }),
      f('display_name', 'displayName', 'Description', 'text', true, { maxLength: 100 }),
      f('tax_type', 'taxType', 'Tax type', 'text', false),
    ],
  },
  taxAreaLines: {
    key: 'taxAreaLines', title: 'Tax area lines', table: 'business_central_tax_area_lines', mode: 'managed',
    source: odata('TaxAreaLines', 465, ['Tax_Area', 'Tax_Jurisdiction_Code']), renameField: null,
    parent: { list: 'taxAreas', field: 'tax_area_code' },
    fields: [
      f('tax_area_code', 'Tax_Area', 'Tax area', 'text', true, { required: true, isKey: true, maxLength: 20 }),
      f('tax_jurisdiction_code', 'Tax_Jurisdiction_Code', 'Tax jurisdiction', 'select', true,
        { required: true, isKey: true, maxLength: 10, optionsFrom: 'taxJurisdictions' }),
      f('calculation_order', 'Calculation_Order', 'Calculation order', 'number', true),
    ],
  },
  taxJurisdictions: {
    key: 'taxJurisdictions', title: 'Tax jurisdictions', table: 'business_central_tax_jurisdictions', mode: 'managed',
    source: odata('TaxJurisdictions', 466, ['Code']), renameField: 'code',
    fields: [
      f('code', 'Code', 'Code', 'text', true, { required: true, isKey: true, maxLength: 10 }),
      f('display_name', 'Description', 'Description', 'text', true, { maxLength: 100 }),
      f('report_to_jurisdiction', 'Report_to_Jurisdiction', 'Report-to jurisdiction', 'text', true, { maxLength: 10 }),
      f('tax_account_sales', 'Tax_Account_Sales', 'Tax account (sales)', 'text', true, { maxLength: 20 }),
      f('tax_account_purchases', 'Tax_Account_Purchases', 'Tax account (purchases)', 'text', true, { maxLength: 20 }),
    ],
  },
  taxDetails: {
    key: 'taxDetails', title: 'Tax details', table: 'business_central_tax_details', mode: 'managed',
    source: odata('TaxDetails', 468, ['Tax_Jurisdiction_Code', 'Tax_Group_Code', 'Tax_Type', 'Effective_Date']),
    renameField: null,
    fields: [
      f('tax_jurisdiction_code', 'Tax_Jurisdiction_Code', 'Tax jurisdiction', 'select', true,
        { required: true, isKey: true, maxLength: 10, optionsFrom: 'taxJurisdictions' }),
      // BC uses '' for "no tax group", so this is intentionally not required.
      f('tax_group_code', 'Tax_Group_Code', 'Tax group', 'select', true,
        { isKey: true, maxLength: 20, optionsFrom: 'taxGroups' }),
      f('tax_type', 'Tax_Type', 'Tax type', 'text', true, { required: true, isKey: true }),
      f('effective_date', 'Effective_Date', 'Effective date', 'date', true, { required: true, isKey: true }),
      f('maximum_amount_qty', 'Maximum_Amount_Qty', 'Maximum amount/qty', 'number', true),
      // Required: a blank rate would silently be sent to BC as 0%.
      f('tax_below_maximum', 'Tax_Below_Maximum', 'Tax below maximum %', 'percent', true, { required: true }),
      f('tax_above_maximum', 'Tax_Above_Maximum', 'Tax above maximum %', 'percent', true),
    ],
  },
  locations: {
    key: 'locations', title: 'Locations', table: 'business_central_locations', mode: 'readOnly',
    source: { kind: 'api', resource: 'locations' }, renameField: 'code',
    fields: readOnly([
      f('code', 'code', 'Code', 'text', false, { isKey: true, maxLength: 10 }),
      f('display_name', 'displayName', 'Name', 'text', false, { maxLength: 100 }),
      f('address_line_1', 'addressLine1', 'Address', 'text', false),
      f('address_line_2', 'addressLine2', 'Address 2', 'text', false),
      f('city', 'city', 'City', 'text', false),
      f('state', 'state', 'State', 'text', false),
      f('postal_code', 'postalCode', 'Postal code', 'text', false),
      f('country', 'country', 'Country', 'text', false),
    ]),
  },
  customerPostingGroups: {
    key: 'customerPostingGroups', title: 'Customer posting groups', table: 'business_central_customer_posting_groups', mode: 'readOnly',
    source: odata('CustomerPostingGroups', 110, ['Code']), renameField: 'code',
    fields: readOnly([
      f('code', 'Code', 'Code', 'text', false, { isKey: true, maxLength: 20 }),
      f('display_name', 'Description', 'Description', 'text', false, { maxLength: 100 }),
    ]),
  },
  generalBusinessPostingGroups: {
    key: 'generalBusinessPostingGroups', title: 'Gen. bus. posting groups',
    table: 'business_central_general_business_posting_groups', mode: 'readOnly',
    source: odata('GenBusinessPostingGroups', 312, ['Code']), renameField: 'code',
    fields: readOnly([
      f('code', 'Code', 'Code', 'text', false, { isKey: true, maxLength: 20 }),
      f('display_name', 'Description', 'Description', 'text', false, { maxLength: 100 }),
      f('default_vat_business_posting_group', 'Def_VAT_Bus_Posting_Group', 'Default VAT bus. posting group', 'text', false, { maxLength: 20 }),
      f('auto_insert_default', 'Auto_Insert_Default', 'Auto insert default', 'boolean', false),
    ]),
  },
  customerTemplates: {
    key: 'customerTemplates', title: 'Customer templates', table: 'business_central_customer_templates', mode: 'managed',
    source: odata('CustomerTemplates', 1382, ['Code']), renameField: 'code',
    fields: [
      f('code', 'Code', 'Code', 'text', true, { required: true, isKey: true, maxLength: 20 }),
      f('display_name', 'Description', 'Description', 'text', true, { maxLength: 100 }),
      f('contact_type', 'Contact_Type', 'Contact type', 'select', true,
        { required: true, options: [{ value: 'Company', label: 'Company' }, { value: 'Person', label: 'Person' }] }),
      f('no_series', 'No_Series', 'No. series', 'select', true,
        { required: true, maxLength: 20, optionsFrom: 'noSeries', optionsMatch: 'CUST' }),
      f('customer_posting_group', 'Customer_Posting_Group', 'Customer posting group', 'select', true,
        { required: true, maxLength: 20, optionsFrom: 'customerPostingGroups', listHidden: true }),
      f('gen_bus_posting_group', 'Gen_Bus_Posting_Group', 'Gen. bus. posting group', 'select', true,
        { required: true, maxLength: 20, optionsFrom: 'generalBusinessPostingGroups', listHidden: true }),
      f('customer_price_group', 'Customer_Price_Group', 'Customer price group', 'select', true,
        { maxLength: 10, optionsFrom: 'customerPriceGroups' }),
      f('payment_terms_code', 'Payment_Terms_Code', 'Payment terms (starting value)', 'select', true,
        { required: true, maxLength: 10, optionsFrom: 'paymentTerms' }),
      f('tax_area_code', 'Tax_Area_Code', 'Tax area (starting value)', 'select', true,
        { required: true, maxLength: 20, optionsFrom: 'taxAreas' }),
      f('tax_liable', 'Tax_Liable', 'Tax liable', 'boolean', true, { listHidden: true }),
      f('tax_identification_type', 'Tax_Identification_Type', 'Tax identification type', 'select', true,
        { required: true, listHidden: true,
          options: [{ value: 'Legal Entity', label: 'Legal Entity' }, { value: 'Natural Person', label: 'Natural Person' }] }),
      f('application_method', 'Application_Method', 'Application method', 'select', true,
        { required: true, listHidden: true, defaultValue: 'Manual',
          options: [{ value: 'Manual', label: 'Manual' }, { value: 'Apply to Oldest', label: 'Apply to Oldest' }] }),
      f('location_code', 'Location_Code', 'Location', 'select', true,
        { required: true, maxLength: 10, optionsFrom: 'locations', listHidden: true }),
    ],
  },
  noSeries: {
    key: 'noSeries', title: 'Number series', table: 'business_central_no_series', mode: 'readOnly',
    source: odata('NoSeries', 456, ['Code']), renameField: 'code',
    fields: readOnly([
      f('code', 'Code', 'Code', 'text', false, { isKey: true, maxLength: 20 }),
      f('display_name', 'Description', 'Description', 'text', false, { maxLength: 100 }),
    ]),
  },
};
