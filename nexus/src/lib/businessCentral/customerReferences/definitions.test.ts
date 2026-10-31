import { describe, it, expect } from 'vitest';
import { LIST_DEFINITIONS } from './definitions';
import { toDbValues, toBcFields } from './mapping';
import type { ListKey } from '@/types/customerReferences';

const COLUMNS: Record<ListKey, string[]> = {
  paymentTerms: ['code', 'display_name', 'due_date_calculation', 'discount_date_calculation', 'discount_percent', 'calculate_discount_on_credit_memos'],
  customerPriceGroups: ['code', 'display_name', 'allow_invoice_disc', 'allow_line_disc', 'price_includes_vat'],
  taxAreas: ['code', 'display_name', 'tax_type'],
  taxJurisdictions: ['code', 'display_name', 'report_to_jurisdiction', 'tax_account_sales', 'tax_account_purchases'],
  taxAreaLines: ['tax_area_code', 'tax_jurisdiction_code', 'calculation_order'],
  taxDetails: ['tax_jurisdiction_code', 'tax_group_code', 'tax_type', 'effective_date', 'maximum_amount_qty', 'tax_below_maximum', 'tax_above_maximum'],
  locations: ['code', 'display_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code', 'country'],
  customerPostingGroups: ['code', 'display_name'],
  generalBusinessPostingGroups: ['code', 'display_name', 'default_vat_business_posting_group', 'auto_insert_default'],
  customerTemplates: ['code', 'display_name', 'contact_type', 'no_series', 'customer_posting_group', 'gen_bus_posting_group',
    'customer_price_group', 'payment_terms_code', 'tax_area_code', 'tax_liable', 'tax_identification_type', 'application_method', 'location_code'],
  noSeries: ['code', 'display_name'],
};
const TABLES: Record<ListKey, string> = {
  paymentTerms: 'business_central_payment_terms',
  customerPriceGroups: 'business_central_customer_price_groups',
  taxAreas: 'business_central_tax_areas',
  taxJurisdictions: 'business_central_tax_jurisdictions',
  taxAreaLines: 'business_central_tax_area_lines',
  taxDetails: 'business_central_tax_details',
  locations: 'business_central_locations',
  customerPostingGroups: 'business_central_customer_posting_groups',
  generalBusinessPostingGroups: 'business_central_general_business_posting_groups',
  customerTemplates: 'business_central_customer_templates',
  noSeries: 'business_central_no_series',
};
const defs = Object.entries(LIST_DEFINITIONS);

describe('LIST_DEFINITIONS', () => {
  it('covers all eleven lists with matching keys', () => {
    expect(defs).toHaveLength(11);
    for (const [k, d] of defs) expect(d.key).toBe(k);
  });

  it('every definition has at least one isKey field', () => {
    for (const [, d] of defs) expect(d.fields.some((f) => f.isKey)).toBe(true);
  });

  it('code lists rename via code; lines and details are keyed by 2+ fields', () => {
    for (const [k, d] of defs) {
      if (k === 'taxAreaLines' || k === 'taxDetails') {
        expect(d.renameField).toBeNull();
        expect(d.fields.filter((f) => f.isKey).length).toBeGreaterThanOrEqual(2);
      } else {
        expect(d.renameField).toBe('code');
      }
    }
    expect(LIST_DEFINITIONS.taxDetails.fields.filter((f) => f.isKey)).toHaveLength(4);
  });

  it('read-only lists have no editable fields', () => {
    const ro = defs.filter(([, d]) => d.mode === 'readOnly').map(([k]) => k).sort();
    expect(ro).toEqual(['customerPostingGroups', 'generalBusinessPostingGroups', 'locations', 'noSeries']);
    for (const [, d] of defs) if (d.mode === 'readOnly') expect(d.fields.every((f) => !f.editable)).toBe(true);
  });

  it('every field is a real column of the definition table (migration 053)', () => {
    for (const [k, d] of defs) {
      expect(d.table).toBe(TABLES[k as ListKey]);
      expect(d.fields.map((f) => f.name).sort()).toEqual([...COLUMNS[k as ListKey]].sort());
    }
  });

  it('no list has delete disabled (price groups are checked live in usage.ts)', () => {
    for (const [, d] of defs) expect(d.deleteDisabledReason).toBeUndefined();
  });

  it('wires parent and select options', () => {
    expect(LIST_DEFINITIONS.taxAreaLines.parent).toEqual({ list: 'taxAreas', field: 'tax_area_code' });
    const f = (k: ListKey, n: string) => LIST_DEFINITIONS[k].fields.find((x) => x.name === n)!;
    expect(f('taxDetails', 'tax_group_code')).toMatchObject({ type: 'select', optionsFrom: 'taxGroups' });
    expect(f('taxDetails', 'tax_group_code').required).toBeFalsy();
    // A blank rate would silently become 0% in BC.
    expect(f('taxDetails', 'tax_below_maximum').required).toBe(true);
    expect(f('taxDetails', 'tax_jurisdiction_code').optionsFrom).toBe('taxJurisdictions');
    expect(f('taxAreaLines', 'tax_jurisdiction_code').optionsFrom).toBe('taxJurisdictions');
    expect(f('taxAreas', 'tax_type').editable).toBe(false);
  });

  it('toDbValues maps a paymentTerms API record', () => {
    const def = LIST_DEFINITIONS.paymentTerms;
    const v = toDbValues(def, {
      key: { bcId: 'x' }, etag: 'e',
      fields: { code: '30 DAYS', displayName: 'Net 30 days', dueDateCalculation: '30D', discountPercent: 0 },
    });
    expect(v).toMatchObject({ code: '30 DAYS', display_name: 'Net 30 days', due_date_calculation: '30D', discount_percent: 0 });
  });

  it('toBcFields round-trips toDbValues for an API and an OData list', () => {
    const api = LIST_DEFINITIONS.paymentTerms;
    const apiFields = { code: 'A', displayName: 'B', dueDateCalculation: '1M', discountDateCalculation: '10D', discountPercent: 2, calculateDiscountOnCreditMemos: true };
    expect(toBcFields(api, toDbValues(api, { key: { bcId: '1' }, etag: '', fields: apiFields }))).toEqual(apiFields);
    const od = LIST_DEFINITIONS.taxDetails;
    const odFields = { Tax_Jurisdiction_Code: 'J', Tax_Group_Code: '', Tax_Type: 'Sales and Use Tax', Effective_Date: '2024-01-01', Maximum_Amount_Qty: 0, Tax_Below_Maximum: 4.5, Tax_Above_Maximum: 0 };
    expect(toBcFields(od, toDbValues(od, { key: { values: {} }, etag: '', fields: odFields }))).toEqual(odFields);
  });

  it('uses the expected sources', () => {
    expect(LIST_DEFINITIONS.paymentTerms.source).toEqual({ kind: 'api', resource: 'paymentTerms' });
    expect(LIST_DEFINITIONS.taxDetails.source).toEqual({
      kind: 'odata', service: 'TaxDetails', pageNumber: 468,
      keyFields: ['Tax_Jurisdiction_Code', 'Tax_Group_Code', 'Tax_Type', 'Effective_Date'],
    });
  });

  it('customer templates manage exactly the 13 spec fields', () => {
    const t = LIST_DEFINITIONS.customerTemplates;
    expect(t.mode).toBe('managed');
    expect(t.source).toEqual({ kind: 'odata', service: 'CustomerTemplates', pageNumber: 1382, keyFields: ['Code'] });
    expect(t.fields.map((f) => f.bcName)).toEqual(['Code', 'Description', 'Contact_Type', 'No_Series',
      'Customer_Posting_Group', 'Gen_Bus_Posting_Group', 'Customer_Price_Group', 'Payment_Terms_Code',
      'Tax_Area_Code', 'Tax_Liable', 'Tax_Identification_Type', 'Application_Method', 'Location_Code']);
    const by = Object.fromEntries(t.fields.map((f) => [f.name, f]));
    expect(by.customer_price_group.required).toBeFalsy();
    for (const n of ['code', 'contact_type', 'no_series', 'customer_posting_group', 'gen_bus_posting_group',
      'payment_terms_code', 'tax_area_code', 'tax_identification_type', 'application_method', 'location_code'])
      expect(by[n].required).toBe(true);
    expect(by.no_series).toMatchObject({ optionsFrom: 'noSeries', optionsMatch: 'CUST' });
    expect(by.application_method.defaultValue).toBe('Manual');
    expect(by.contact_type.options?.map((o) => o.value)).toEqual(['Company', 'Person']);
    expect(by.tax_identification_type.options?.map((o) => o.value)).toEqual(['Legal Entity', 'Natural Person']);
    expect(by.application_method.options?.map((o) => o.value)).toEqual(['Manual', 'Apply to Oldest']);
    expect(t.fields.filter((f) => f.listHidden).map((f) => f.name)).toEqual(['customer_posting_group',
      'gen_bus_posting_group', 'tax_liable', 'tax_identification_type', 'application_method', 'location_code']);
  });

  it('number series is a read-only copy from the NoSeries page', () => {
    expect(LIST_DEFINITIONS.noSeries).toMatchObject({ mode: 'readOnly', table: 'business_central_no_series',
      source: { kind: 'odata', service: 'NoSeries', pageNumber: 456, keyFields: ['Code'] } });
  });
});
