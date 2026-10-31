import { createHash } from 'node:crypto';

import type { BusinessCentralCustomer } from '@/types/database';

export interface BillcomCustomerPayload {
  name: string;
  email: string;
  phone: string;
  accountNumber: string;
  billingAddress: {
    line1: string;
    line2: string;
    city: string;
    stateOrProvince: string;
    zipOrPostalCode: string;
    country: string;
  };
}

const s = (v: string | null | undefined): string => v ?? '';

export function toBillcomCustomer(row: BusinessCentralCustomer): BillcomCustomerPayload {
  return {
    name: s(row.display_name),
    email: s(row.email),
    phone: s(row.phone_number),
    accountNumber: s(row.bc_customer_number),
    billingAddress: {
      line1: s(row.address_line_1),
      line2: s(row.address_line_2),
      city: s(row.city),
      stateOrProvince: s(row.state),
      zipOrPostalCode: s(row.postal_code),
      country: s(row.country),
    },
  };
}

export function shouldBeArchived(row: BusinessCentralCustomer): boolean {
  return row.blocked === 'Invoice' || row.blocked === 'All';
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, sortKeys(val)]),
    );
  }
  return v;
}

export function payloadHash(p: BillcomCustomerPayload, archived: boolean): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys({ payload: p, archived })))
    .digest('hex');
}
