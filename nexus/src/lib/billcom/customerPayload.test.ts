import { describe, expect, it } from 'vitest';

import type { BusinessCentralCustomer } from '@/types/database';

import { payloadHash, shouldBeArchived, toBillcomCustomer } from './customerPayload';

function row(over: Partial<BusinessCentralCustomer> = {}): BusinessCentralCustomer {
  return {
    display_name: 'Acme',
    email: 'a@acme.com',
    phone_number: '555-1',
    address_line_1: '1 Main',
    address_line_2: 'Ste 2',
    city: 'Town',
    state: 'CA',
    postal_code: '90210',
    country: 'US',
    bc_customer_number: 'C0001',
    blocked: null,
    email_cc: 'cc@acme.com',
    ...over,
  } as BusinessCentralCustomer;
}

describe('toBillcomCustomer', () => {
  it('maps fields, billing only, no cc/contact', () => {
    const p = toBillcomCustomer(row());
    expect(p).toEqual({
      name: 'Acme',
      email: 'a@acme.com',
      phone: '555-1',
      accountNumber: 'C0001',
      billingAddress: {
        line1: '1 Main',
        line2: 'Ste 2',
        city: 'Town',
        stateOrProvince: 'CA',
        zipOrPostalCode: '90210',
        country: 'US',
      },
    });
  });
  it('sends blank phone/account as empty strings but omits blank email', () => {
    const p = toBillcomCustomer(row({ email: null, phone_number: null, bc_customer_number: null }));
    expect('email' in p).toBe(false);
    expect(toBillcomCustomer(row({ email: '  ' })).email).toBeUndefined();
    expect(p.phone).toBe('');
    expect(p.accountNumber).toBe('');
  });
  it.each([['address_line_1'], ['city'], ['postal_code']])('omits billingAddress when %s blank', (f) => {
    expect('billingAddress' in toBillcomCustomer(row({ [f]: null }))).toBe(false);
    expect('billingAddress' in toBillcomCustomer(row({ [f]: '  ' }))).toBe(false);
  });
  it('blank country with rest filled defaults to US', () => {
    expect(toBillcomCustomer(row({ country: null })).billingAddress?.country).toBe('US');
    expect(toBillcomCustomer(row({ country: ' ' })).billingAddress?.country).toBe('US');
  });
  it('invalid country code is treated as blank (US)', () => {
    expect(toBillcomCustomer(row({ country: 'USA' })).billingAddress?.country).toBe('US');
  });
  it('uppercases and trims country', () => {
    const a = toBillcomCustomer(row({ country: ' ca ', state: 'Ontario' })).billingAddress;
    expect(a?.country).toBe('CA');
    expect(a?.stateOrProvince).toBe('Ontario');
  });
  it('converts US state names and codes', () => {
    expect(toBillcomCustomer(row({ state: 'Hawaii' })).billingAddress?.stateOrProvince).toBe('HI');
    expect(toBillcomCustomer(row({ state: 'hi' })).billingAddress?.stateOrProvince).toBe('HI');
    expect(toBillcomCustomer(row({ state: ' district of columbia ' })).billingAddress?.stateOrProvince).toBe('DC');
  });
  it('omits billingAddress for invalid US state', () => {
    expect('billingAddress' in toBillcomCustomer(row({ state: 'Narnia' }))).toBe(false);
    expect('billingAddress' in toBillcomCustomer(row({ state: null }))).toBe(false);
    expect('billingAddress' in toBillcomCustomer(row({ country: null, state: 'Narnia' }))).toBe(false);
  });
  it('keeps blank line2 as empty string', () => {
    expect(toBillcomCustomer(row({ address_line_2: null })).billingAddress?.line2).toBe('');
  });
});

describe('shouldBeArchived', () => {
  it.each([['Invoice', true], ['All', true], ['Ship', false], [null, false], ['', false], ['x', false]])('%s -> %s', (b, exp) => {
    expect(shouldBeArchived(row({ blocked: b as string | null }))).toBe(exp);
  });
});

describe('payloadHash', () => {
  it('ignores key order', () => {
    const p = toBillcomCustomer(row());
    const reordered = { billingAddress: { country: 'US', line1: '1 Main', line2: 'Ste 2', city: 'Town', stateOrProvince: 'CA', zipOrPostalCode: '90210' }, accountNumber: 'C0001', phone: '555-1', email: 'a@acme.com', name: 'Acme' };
    expect(payloadHash(reordered, false)).toBe(payloadHash(p, false));
  });
  it('changes on any pushed field or archived flag', () => {
    const base = payloadHash(toBillcomCustomer(row()), false);
    expect(payloadHash(toBillcomCustomer(row()), true)).not.toBe(base);
    for (const over of [{ display_name: 'B' }, { email: 'z@z.com' }, { phone_number: '1' }, { bc_customer_number: 'C2' }, { address_line_1: 'x' }, { address_line_2: 'x' }, { city: 'x' }, { state: 'NY' }, { postal_code: '1' }, { country: 'CA' }]) {
      expect(payloadHash(toBillcomCustomer(row(over)), false)).not.toBe(base);
    }
  });
  it('differs when email or address is omitted', () => {
    const base = payloadHash(toBillcomCustomer(row()), false);
    expect(payloadHash(toBillcomCustomer(row({ email: null })), false)).not.toBe(base);
    expect(payloadHash(toBillcomCustomer(row({ city: null })), false)).not.toBe(base);
  });
  it('ignores email_cc', () => {
    expect(payloadHash(toBillcomCustomer(row({ email_cc: 'q@q.com' })), false)).toBe(payloadHash(toBillcomCustomer(row()), false));
  });
});
