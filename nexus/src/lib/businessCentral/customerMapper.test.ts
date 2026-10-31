import { describe, expect, it } from 'vitest';
import { mapBcCustomerToDb, normalizeBlocked, type BcCustomer } from './customerMapper';

const baseCustomer: BcCustomer = {
  id: 'cust-guid-1',
  number: 'C00010',
  displayName: 'Acme Corp',
  type: 'Company',
  addressLine1: '1 Main St',
  addressLine2: '',
  city: 'Honolulu',
  state: 'HI',
  postalCode: '96815',
  country: 'US',
  phoneNumber: '555-0100',
  email: 'ap@acme.test',
  website: '',
  taxLiable: true,
  taxAreaId: 'tax-guid',
  taxRegistrationNumber: 'TRN-1',
  currencyId: 'cur-guid',
  currencyCode: 'USD',
  paymentTermsId: 'pt-guid',
  paymentMethodId: 'pm-guid',
  shipmentMethodId: 'sm-guid',
  blocked: ' ',
  balance: 4200.5,
  lastModifiedDateTime: '2026-03-03T10:00:00Z',
  '@odata.etag': 'W/"etag-1"',
};

const input = {
  organizationId: 'org-1',
  connectionId: 'conn-1',
  environment: 'TEST',
  companyId: 'company-1',
  now: '2026-03-04T00:00:00Z',
};

describe('mapBcCustomerToDb', () => {
  it('maps identity, scope, and profile fields', () => {
    const row = mapBcCustomerToDb({ ...input, customer: baseCustomer });
    expect(row.organization_id).toBe('org-1');
    expect(row.bc_connection_id).toBe('conn-1');
    expect(row.bc_environment).toBe('TEST');
    expect(row.bc_company_id).toBe('company-1');
    expect(row.bc_customer_id).toBe('cust-guid-1');
    expect(row.bc_customer_number).toBe('C00010');
    expect(row.display_name).toBe('Acme Corp');
    expect(row.city).toBe('Honolulu');
    expect(row.bc_etag).toBe('W/"etag-1"');
    expect(row.bc_last_modified_at).toBe('2026-03-03T10:00:00Z');
  });

  it('converts empty strings to null', () => {
    const row = mapBcCustomerToDb({ ...input, customer: baseCustomer });
    expect(row.address_line_2).toBeNull();
    expect(row.website).toBeNull();
  });

  it('normalizes the BC blank blocked value to null', () => {
    const row = mapBcCustomerToDb({ ...input, customer: baseCustomer });
    expect(row.blocked).toBeNull();
  });

  it('keeps a real blocked value', () => {
    const row = mapBcCustomerToDb({
      ...input,
      customer: { ...baseCustomer, blocked: 'All' },
    });
    expect(row.blocked).toBe('All');
  });

  it('maps financial details when present and leaves them null otherwise', () => {
    const withDetails = mapBcCustomerToDb({
      ...input,
      customer: {
        ...baseCustomer,
        customerFinancialDetails: { balance: 4200.5, overdueAmount: 1200 },
      },
    });
    expect(withDetails.balance).toBe(4200.5);
    expect(withDetails.overdue_amount).toBe(1200);

    const withoutDetails = mapBcCustomerToDb({ ...input, customer: baseCustomer });
    expect(withoutDetails.balance).toBe(4200.5);
    expect(withoutDetails.overdue_amount).toBeNull();
  });

  it('retains the raw payload and stamps sync fields', () => {
    const row = mapBcCustomerToDb({ ...input, customer: baseCustomer });
    expect(row.bc_raw_payload).toEqual(baseCustomer);
    expect(row.sync_status).toBe('synced');
    expect(row.last_synced_at).toBe('2026-03-04T00:00:00Z');
    expect(row.last_pulled_at).toBe('2026-03-04T00:00:00Z');
    expect(row.sync_error).toBeNull();
  });

  it('preserves a legitimate zero balance from financial details', () => {
    const row = mapBcCustomerToDb({
      ...input,
      customer: {
        ...baseCustomer,
        customerFinancialDetails: { balance: 0 },
      },
    });
    expect(row.balance).toBe(0);
  });
});

describe('blocked normalization', () => {
  it('maps the XML-encoded blank _x0020_ to null', () => {
    const row = mapBcCustomerToDb({ ...input, customer: { ...baseCustomer, blocked: '_x0020_' } });
    expect(row.blocked).toBeNull();
  });
  it('keeps real values', () => {
    expect(mapBcCustomerToDb({ ...input, customer: { ...baseCustomer, blocked: 'Invoice' } }).blocked).toBe('Invoice');
  });
  it('normalizeBlocked handles blanks and real values', () => {
    for (const v of ['_x0020_', ' ', '', null, undefined]) expect(normalizeBlocked(v)).toBeNull();
    expect(normalizeBlocked(' Ship ')).toBe('Ship');
    expect(normalizeBlocked('All')).toBe('All');
  });
});
