// Links that name a customer by BC customer number (sales invoices) go through
// /customers/by-number/<number>, which jumps to that customer's profile.
import type { SupabaseClient } from '@supabase/supabase-js';

/** Where a link to this customer number should point. */
export const customerByNumberHref = (customerNumber: string) =>
  `/customers/by-number/${encodeURIComponent(customerNumber)}`;

/**
 * The customer's profile in this environment; the customer search for that
 * number when they aren't in Nexus (or the lookup fails). Never throws.
 */
export async function customerProfilePath(
  supabase: SupabaseClient,
  orgId: string,
  bcConnectionId: string | null,
  customerNumber: string,
): Promise<string> {
  const search = `/customers?search=${encodeURIComponent(customerNumber)}`;
  if (!bcConnectionId) return search;
  const { data, error } = await supabase
    .from('business_central_customers')
    .select('id')
    .eq('organization_id', orgId)
    .eq('bc_connection_id', bcConnectionId)
    .eq('bc_customer_number', customerNumber)
    .limit(1);
  const id = !error && (data as { id: string }[] | null)?.[0]?.id;
  return id ? `/customers/${encodeURIComponent(id)}` : search;
}
