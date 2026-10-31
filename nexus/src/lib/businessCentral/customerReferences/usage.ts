import type { BcClient } from '../client';
import { LIST_DEFINITIONS } from './definitions';
import type { ServiceDeps } from './service';
import type { ReferenceTransport } from './transport';

const CUSTOMER_PAGE = 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** OData v4 string literal: single quotes, embedded quotes doubled. */
const odataString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Every count here is read live from Business Central, never from Nexus's copy:
 * BC cascade-deletes a jurisdiction's tax area lines and tax details, so a stale
 * copy would let a delete silently strip the jurisdiction from tax areas.
 */
export function createUsageCounter(bc: BcClient, transport: ReferenceTransport): ServiceDeps['countUsage'] {
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

  async function countJurisdiction(code: string): Promise<string | null> {
    if (code.trim() === '') {
      throw new Error('Cannot check usage: this jurisdiction has no code. Sync the list and try again.');
    }
    const filter = `Tax_Jurisdiction_Code eq ${odataString(code)}`;
    const [lines, details] = await Promise.all([
      transport.list(LIST_DEFINITIONS.taxAreaLines.source, { filter }),
      transport.list(LIST_DEFINITIONS.taxDetails.source, { filter }),
    ]);
    if (lines.length === 0 && details.length === 0) return null;
    return `Used by ${plural(lines.length, 'tax area line', 'tax area lines')} and ${plural(details.length, 'tax detail', 'tax details')}`;
  }

  return async (def, row) => {
    switch (def.key) {
      case 'paymentTerms':
        return countCustomers('paymentTermsId', row.bcId);
      case 'taxAreas':
        return countCustomers('taxAreaId', row.bcId);
      case 'taxJurisdictions':
        return countJurisdiction(String(row.values.code ?? row.keyValues.code ?? ''));
      default:
        return null;
    }
  };
}
