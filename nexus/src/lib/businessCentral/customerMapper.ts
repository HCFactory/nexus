import { BusinessCentralCustomer } from '@/types/database';

export interface BcCustomerFinancialDetails {
  balance?: number;
  totalSalesExcludingTax?: number;
  overdueAmount?: number;
}

export interface BcCustomer {
  id: string;
  number?: string;
  displayName: string;
  type?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phoneNumber?: string;
  email?: string;
  website?: string;
  taxLiable?: boolean;
  taxAreaId?: string;
  taxRegistrationNumber?: string;
  currencyId?: string;
  currencyCode?: string;
  paymentTermsId?: string;
  paymentMethodId?: string;
  shipmentMethodId?: string;
  blocked?: string;
  balance?: number;
  lastModifiedDateTime?: string;
  customerFinancialDetails?: BcCustomerFinancialDetails;
  '@odata.etag'?: string;
  [key: string]: unknown;
}

export interface CustomerUpsertInput {
  organizationId: string;
  connectionId: string;
  environment: string;
  companyId: string;
  customer: BcCustomer;
  now: string;
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * BC's "not blocked" is a single blank space, which API v2 returns XML-encoded
 * as "_x0020_". Real values are Ship, Invoice, All. Anything blank -> null.
 */
export function normalizeBlocked(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '_x0020_' ? null : trimmed;
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function mapBcCustomerToDb(input: CustomerUpsertInput): Partial<BusinessCentralCustomer> {
  const { organizationId, connectionId, environment, companyId, customer, now } = input;
  const financials = customer.customerFinancialDetails;

  return {
    organization_id: organizationId,
    bc_connection_id: connectionId,
    bc_environment: environment,
    bc_company_id: companyId,
    bc_customer_id: customer.id,
    bc_customer_number: emptyToNull(customer.number),
    bc_etag: customer['@odata.etag'] ?? null,
    bc_last_modified_at: customer.lastModifiedDateTime || null,
    display_name: customer.displayName,
    type: emptyToNull(customer.type),
    address_line_1: emptyToNull(customer.addressLine1),
    address_line_2: emptyToNull(customer.addressLine2),
    city: emptyToNull(customer.city),
    state: emptyToNull(customer.state),
    postal_code: emptyToNull(customer.postalCode),
    country: emptyToNull(customer.country),
    phone_number: emptyToNull(customer.phoneNumber),
    email: emptyToNull(customer.email),
    website: emptyToNull(customer.website),
    currency_id: emptyToNull(customer.currencyId),
    currency_code: emptyToNull(customer.currencyCode),
    payment_terms_id: emptyToNull(customer.paymentTermsId),
    payment_method_id: emptyToNull(customer.paymentMethodId),
    shipment_method_id: emptyToNull(customer.shipmentMethodId),
    tax_liable: customer.taxLiable ?? false,
    tax_area_id: emptyToNull(customer.taxAreaId),
    tax_registration_number: emptyToNull(customer.taxRegistrationNumber),
    // BC uses a single blank space for "not blocked".
    blocked: normalizeBlocked(customer.blocked),
    balance: numberOrNull(financials?.balance ?? customer.balance),
    overdue_amount: numberOrNull(financials?.overdueAmount),
    bc_raw_payload: customer as unknown as Record<string, unknown>,
    sync_status: 'synced',
    sync_error: null,
    last_synced_at: now,
    last_pulled_at: now,
    updated_at: now,
  };
}
