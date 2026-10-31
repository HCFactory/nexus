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
  /** Phrase like "3 customers" (without "Used by"), or null when none. */
  async function customersUsing(field: string, bcId: string | null): Promise<string | null> {
    const rows = await bc.listResourcePage<unknown>('customers', {
      filter: `${field} eq ${bcId}`,
      top: CUSTOMER_PAGE,
    });
    if (rows.length === 0) return null;
    if (rows.length >= CUSTOMER_PAGE) return `${CUSTOMER_PAGE} or more customers`;
    return plural(rows.length, 'customer', 'customers');
  }

  /** Codes of customer templates whose BC field equals the code. */
  async function templatesUsing(bcField: string, code: string): Promise<string[]> {
    const rows = await transport.list(LIST_DEFINITIONS.customerTemplates.source, {
      filter: `${bcField} eq ${odataString(code)}`,
    });
    return rows.map((r) => String(r.fields.Code ?? ''));
  }

  async function countCustomersAndTemplates(
    customerField: string,
    templateField: string,
    row: Parameters<ReturnType<typeof createUsageCounter>>[1],
  ): Promise<string | null> {
    if (!row.bcId) {
      throw new Error('Cannot check usage: this entry has no Business Central id. Sync the list and try again.');
    }
    const code = String(row.values.code ?? row.keyValues.code ?? '');
    if (code.trim() === '') {
      throw new Error('Cannot check usage: this entry has no code. Sync the list and try again.');
    }
    const [customers, templates] = await Promise.all([
      customersUsing(customerField, row.bcId),
      templatesUsing(templateField, code),
    ]);
    const tpl = templates.length === 0 ? null : `${templates.length === 1 ? 'template' : 'templates'} ${templates.join(', ')}`;
    if (customers && tpl) return `Used by ${customers} and ${tpl}`;
    if (customers || tpl) return `Used by ${customers ?? tpl}`;
    return null;
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
        return countCustomersAndTemplates('paymentTermsId', 'Payment_Terms_Code', row);
      case 'taxAreas':
        return countCustomersAndTemplates('taxAreaId', 'Tax_Area_Code', row);
      case 'taxJurisdictions':
        return countJurisdiction(String(row.values.code ?? row.keyValues.code ?? ''));
      default:
        return null;
    }
  };
}
