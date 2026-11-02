import { createHash } from 'node:crypto';

import type { BusinessCentralCustomer } from '@/types/database';

export interface BillcomBillingAddress {
  line1: string;
  line2: string;
  city: string;
  stateOrProvince: string;
  zipOrPostalCode: string;
  country: string;
}

export interface BillcomCustomerPayload {
  name: string;
  email?: string;
  phone: string;
  accountNumber: string;
  billingAddress?: BillcomBillingAddress;
}

const s = (v: string | null | undefined): string => v ?? '';
const t = (v: string | null | undefined): string => (v ?? '').trim();

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const US_STATE_CODES = new Set(Object.values(US_STATES));

function normalizeUsState(raw: string): string | null {
  const v = raw.trim();
  const up = v.toUpperCase();
  if (US_STATE_CODES.has(up)) return up;
  return US_STATES[v.toLowerCase()] ?? null;
}

function buildAddress(row: BusinessCentralCustomer): BillcomBillingAddress | undefined {
  const line1 = t(row.address_line_1);
  const city = t(row.city);
  const zip = t(row.postal_code);
  if (!line1 || !city || !zip) return undefined;

  let country = t(row.country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) country = 'US';

  let state = t(row.state);
  if (country === 'US') {
    const code = normalizeUsState(state);
    if (!code) return undefined;
    state = code;
  }

  return {
    line1,
    line2: t(row.address_line_2),
    city,
    stateOrProvince: state,
    zipOrPostalCode: zip,
    country,
  };
}

export function toBillcomCustomer(row: BusinessCentralCustomer): BillcomCustomerPayload {
  const email = t(row.email);
  const billingAddress = buildAddress(row);
  return {
    name: s(row.display_name),
    ...(email ? { email } : {}),
    phone: s(row.phone_number),
    accountNumber: s(row.bc_customer_number),
    ...(billingAddress ? { billingAddress } : {}),
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
