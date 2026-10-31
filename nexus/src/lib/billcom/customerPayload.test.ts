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
  it('sends blanks as empty strings', () => {
    const p = toBillcomCustomer(
      row({ email: null, phone_number: null, address_line_1: null, address_line_2: null, city: null, state: null, postal_code: null, country: null, bc_customer_number: null }),
    );
    expect(p.email).toBe('');
    expect(p.phone).toBe('');
    expect(p.accountNumber).toBe('');
    expect(p.billingAddress).toEqual({ line1: '', line2: '', city: '', stateOrProvince: '', zipOrPostalCode: '', country: '' });
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
    for (const over of [{ display_name: 'B' }, { email: 'z@z.com' }, { phone_number: '1' }, { bc_customer_number: 'C2' }, { address_line_1: 'x' }, { address_line_2: 'x' }, { city: 'x' }, { state: 'x' }, { postal_code: '1' }, { country: 'CA' }]) {
      expect(payloadHash(toBillcomCustomer(row(over)), false)).not.toBe(base);
    }
  });
  it('ignores email_cc', () => {
    expect(payloadHash(toBillcomCustomer(row({ email_cc: 'q@q.com' })), false)).toBe(payloadHash(toBillcomCustomer(row()), false));
  });
});
