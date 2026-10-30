import type { SupabaseClient } from '@supabase/supabase-js';
import type { BcClient } from '../client';
import type { ServiceDeps } from './service';

const CUSTOMER_PAGE = 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function createUsageCounter(
  bc: BcClient,
  supabase: SupabaseClient,
  orgId: string,
  connectionId: string,
): ServiceDeps['countUsage'] {
  async function countCustomers(field: string, bcId: string | null): Promise<string | null> {
    if (!bcId) {
      throw new Error('Cannot check usage: this entry has no Business Central id. Sync the list and try again.');
    }
    const rows = await bc.listResourcePage<unknown>('customers', {
      filter: `${field} eq ${bcId}`,
      top: CUSTOMER_PAGE,
    });
    if (rows.length === 0) return null;
    if (rows.length >= CUSTOMER_PAGE) return `Used by ${CUSTOMER_PAGE} or more customers`;
    return `Used by ${plural(rows.length, 'customer', 'customers')}`;
  }

  async function countRows(table: string, code: string): Promise<number> {
    const { count, error } = await supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('bc_connection_id', connectionId)
      .eq('tax_jurisdiction_code', code);
    if (error) throw new Error(error.message);
    return count ?? 0;
  }

  return async (def, row) => {
    switch (def.key) {
      case 'paymentTerms':
        return countCustomers('paymentTermsId', row.bcId);
      case 'taxAreas':
        return countCustomers('taxAreaId', row.bcId);
      case 'taxJurisdictions': {
        const code = String(row.values.code ?? row.keyValues.code ?? '');
        const [lines, details] = await Promise.all([
          countRows('business_central_tax_area_lines', code),
          countRows('business_central_tax_details', code),
        ]);
        if (lines === 0 && details === 0) return null;
        return `Used by ${plural(lines, 'tax area line', 'tax area lines')} and ${plural(details, 'tax detail', 'tax details')}`;
      }
      default:
        return null;
    }
  };
}
