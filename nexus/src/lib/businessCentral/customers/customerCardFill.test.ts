import { describe, expect, it, vi } from 'vitest';
import { fillCustomerCardFields, mapCardToCustomerColumns } from './customerCardFill';

const card = {
  No: 'W00010', Name: 'Acme', E_Mail: 'a@x.com', EMailCCHCABG: 'cc@x.com', Phone_No: '555',
  Payment_Terms_Code: '30 DAYS', Tax_Area_Code: 'HI-HNL-RT', Tax_Liable: true,
  Tax_Identification_Type: 'Legal Entity', Customer_Price_Group: 'WHSL-DLVRY',
  Customer_Posting_Group: 'DOMESTIC', Gen_Bus_Posting_Group: 'DOMESTIC', Application_Method: 'Manual',
  Location_Code: 'MAIN', Blocked: 'Invoice', Credit_Limit_LCY: 2500.5,
};

describe('mapCardToCustomerColumns', () => {
  it('fills every new column and the card etag', () => {
    expect(mapCardToCustomerColumns({ etag: 'W/"1"', fields: card })).toEqual({
      email_cc: 'cc@x.com', payment_terms_code: '30 DAYS', tax_area_code: 'HI-HNL-RT',
      tax_identification_type: 'Legal Entity', customer_price_group: 'WHSL-DLVRY',
      customer_posting_group: 'DOMESTIC', gen_bus_posting_group: 'DOMESTIC', application_method: 'Manual',
      location_code: 'MAIN', credit_limit: 2500.5, blocked: 'Invoice', bc_card_etag: 'W/"1"',
    });
  });
  it('uses empty string / 0 for missing values', () => {
    const out = mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Payment_Terms_Code: null } });
    expect(out.payment_terms_code).toBe('');
    expect(out.email_cc).toBe('');
    expect(out.credit_limit).toBe(0);
  });
});

describe('mapCardToCustomerColumns blocked', () => {
  it('sets blocked null for a blank space and for _x0020_', () => {
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Blocked: ' ' } }).blocked).toBeNull();
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Blocked: '_x0020_' } }).blocked).toBeNull();
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X' } }).blocked).toBeNull();
  });
  it('keeps Invoice', () => {
    expect(mapCardToCustomerColumns({ etag: 'e', fields: { No: 'X', Blocked: 'Invoice' } }).blocked).toBe('Invoice');
  });
});

describe('fillCustomerCardFields', () => {
  it('updates matched customers by number and counts them', async () => {
    const update = vi.fn(async () => {});
    const n = await fillCustomerCardFields(
      [{ key: { values: { No: 'W00010' } }, etag: 'e1', fields: card }],
      new Set(['W00010', 'W00011']),
      update,
    );
    expect(n).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('W00010', expect.objectContaining({ bc_card_etag: 'e1', email_cc: 'cc@x.com' }));
  });
  it('skips cards with no matching customer row', async () => {
    const update = vi.fn(async () => {});
    const n = await fillCustomerCardFields(
      [{ key: { values: { No: 'ZZ' } }, etag: 'e', fields: { No: 'ZZ' } }], new Set(['A']), update,
    );
    expect(n).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
});
