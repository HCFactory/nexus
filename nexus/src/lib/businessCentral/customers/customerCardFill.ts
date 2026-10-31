import { normalizeBlocked } from '../customerMapper';
import type { BcRecord, ReferenceSource } from '../customerReferences/transport';

export const CUSTOMER_CARD_SOURCE: ReferenceSource = {
  kind: 'odata',
  service: 'Customer_Card_Excel',
  pageNumber: 21,
  keyFields: ['No'],
};

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Columns filled from a Customer_Card_Excel record (never touches columns the API v2 sync owns). */
export function mapCardToCustomerColumns(card: Pick<BcRecord, 'etag' | 'fields'>): Record<string, unknown> {
  const x = card.fields;
  const limit = typeof x.Credit_Limit_LCY === 'number' && Number.isFinite(x.Credit_Limit_LCY) ? x.Credit_Limit_LCY : 0;
  return {
    email_cc: str(x.EMailCCHCABG),
    payment_terms_code: str(x.Payment_Terms_Code),
    tax_area_code: str(x.Tax_Area_Code),
    tax_identification_type: str(x.Tax_Identification_Type),
    customer_price_group: str(x.Customer_Price_Group),
    customer_posting_group: str(x.Customer_Posting_Group),
    gen_bus_posting_group: str(x.Gen_Bus_Posting_Group),
    application_method: str(x.Application_Method),
    location_code: str(x.Location_Code),
    credit_limit: limit,
    blocked: normalizeBlocked(x.Blocked),
    bc_card_etag: card.etag || null,
  };
}

/**
 * Fill card columns onto customers already in our database. Cards whose number
 * has no customer row are skipped; customers with no card are left untouched.
 * Returns how many customers were updated.
 */
export async function fillCustomerCardFields(
  cards: BcRecord[],
  knownNumbers: Set<string>,
  update: (customerNumber: string, patch: Record<string, unknown>) => Promise<void>,
  concurrency = 10,
): Promise<number> {
  const matched = cards.filter((c) => {
    const no = 'values' in c.key ? c.key.values.No : '';
    return no !== '' && knownNumbers.has(no);
  });
  for (let i = 0; i < matched.length; i += concurrency) {
    await Promise.all(
      matched.slice(i, i + concurrency).map((c) =>
        update((c.key as { values: Record<string, string> }).values.No, mapCardToCustomerColumns(c)),
      ),
    );
  }
  return matched.length;
}
