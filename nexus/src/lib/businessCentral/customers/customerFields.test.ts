import { describe, expect, it } from 'vitest';
import { CUSTOMER_FIELDS, TEMPLATE_TO_CUSTOMER } from './customerFields';

const byName = (n: string) => CUSTOMER_FIELDS.find((f) => f.name === n)!;

describe('CUSTOMER_FIELDS', () => {
  it('has unique names and BC names', () => {
    expect(new Set(CUSTOMER_FIELDS.map((f) => f.name)).size).toBe(CUSTOMER_FIELDS.length);
    expect(new Set(CUSTOMER_FIELDS.map((f) => f.bcName)).size).toBe(CUSTOMER_FIELDS.length);
  });

  it('maps columns to the Customer_Card_Excel field names', () => {
    const map = Object.fromEntries(CUSTOMER_FIELDS.map((f) => [f.name, f.bcName]));
    expect(map).toEqual({
      display_name: 'Name', email: 'E_Mail', email_cc: 'EMailCCHCABG', phone_number: 'Phone_No',
      address_line_1: 'Address', address_line_2: 'Address_2', city: 'City', state: 'County',
      postal_code: 'Post_Code', country: 'Country_Region_Code', payment_terms_code: 'Payment_Terms_Code',
      tax_area_code: 'Tax_Area_Code', tax_liable: 'Tax_Liable', tax_identification_type: 'Tax_Identification_Type',
      customer_price_group: 'Customer_Price_Group', customer_posting_group: 'Customer_Posting_Group',
      gen_bus_posting_group: 'Gen_Bus_Posting_Group', application_method: 'Application_Method',
      location_code: 'Location_Code', blocked: 'Blocked', credit_limit: 'Credit_Limit_LCY',
    });
  });

  it('requires exactly name, email, phone, payment terms and tax area', () => {
    expect(CUSTOMER_FIELDS.filter((f) => f.required).map((f) => f.name).sort()).toEqual(
      ['display_name', 'email', 'payment_terms_code', 'phone_number', 'tax_area_code'],
    );
  });

  it('has no contact type or number series field', () => {
    expect(CUSTOMER_FIELDS.some((f) => /contact_type|no_series/.test(f.name))).toBe(false);
  });

  it('uses lists for the reference selects', () => {
    expect(byName('payment_terms_code').optionsFrom).toBe('paymentTerms');
    expect(byName('tax_area_code').optionsFrom).toBe('taxAreas');
    expect(byName('customer_price_group').optionsFrom).toBe('customerPriceGroups');
    expect(byName('customer_posting_group').optionsFrom).toBe('customerPostingGroups');
    expect(byName('gen_bus_posting_group').optionsFrom).toBe('generalBusinessPostingGroups');
    expect(byName('location_code').optionsFrom).toBe('locations');
  });

  it('has fixed options for blocked, tax identification type and application method', () => {
    expect(byName('blocked').options).toEqual([
      { value: ' ', label: 'Not blocked' }, { value: 'Ship', label: 'Ship' },
      { value: 'Invoice', label: 'Invoice' }, { value: 'All', label: 'All' },
    ]);
    expect(byName('tax_identification_type').options!.map((o) => o.value)).toEqual(['Legal Entity', 'Natural Person']);
    expect(byName('application_method').options!.map((o) => o.value)).toEqual(['Manual', 'Apply to Oldest']);
    for (const n of ['blocked', 'tax_identification_type', 'application_method']) expect(byName(n).type).toBe('select');
  });
});

describe('TEMPLATE_TO_CUSTOMER', () => {
  it('covers the 9 template fields that carry over to a customer', () => {
    expect(Object.keys(TEMPLATE_TO_CUSTOMER).sort()).toEqual([
      'application_method', 'customer_posting_group', 'customer_price_group', 'gen_bus_posting_group',
      'location_code', 'payment_terms_code', 'tax_area_code', 'tax_identification_type', 'tax_liable',
    ]);
  });
  it('targets real customer fields', () => {
    for (const col of Object.values(TEMPLATE_TO_CUSTOMER)) expect(byName(col)).toBeDefined();
  });
});
