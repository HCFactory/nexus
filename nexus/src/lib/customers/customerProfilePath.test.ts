import { describe, expect, it } from 'vitest';
import { fakeSupabase } from '@/test/fakeSupabase';
import { customerByNumberHref, customerProfilePath } from './customerProfilePath';

const db = () =>
  fakeSupabase({
    business_central_customers: [
      { id: 'cust-1', organization_id: 'org-1', bc_connection_id: 'conn-1', bc_customer_number: 'W00123' },
      { id: 'cust-other-env', organization_id: 'org-1', bc_connection_id: 'conn-2', bc_customer_number: 'W00999' },
    ],
  }).client;

describe('customerByNumberHref', () => {
  it('links to the jump-to-profile address', () => {
    expect(customerByNumberHref('W 00/1')).toBe('/customers/by-number/W%2000%2F1');
  });
});

describe('customerProfilePath', () => {
  it('the customer’s profile in this environment', async () => {
    expect(await customerProfilePath(db(), 'org-1', 'conn-1', 'W00123')).toBe('/customers/cust-1');
  });
  it('not in Nexus for this environment: the customer search for that number', async () => {
    expect(await customerProfilePath(db(), 'org-1', 'conn-1', 'W00999')).toBe('/customers?search=W00999');
    expect(await customerProfilePath(db(), 'org-1', null, 'W00123')).toBe('/customers?search=W00123');
  });
  it('a lookup failure falls back to the search too', async () => {
    const f = fakeSupabase({ business_central_customers: [] });
    f.failOn = () => 'down';
    expect(await customerProfilePath(f.client, 'org-1', 'conn-1', 'W00123')).toBe('/customers?search=W00123');
  });
});
