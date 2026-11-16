// Copies posted BC sales invoices and their lines into Nexus's Receivables
// tables, outside the Receivables sync: right after Create invoice posts, and
// when the invoice page finds a gap. Same mappers and conflict targets as the
// sync (arSyncAdapters / salesInvoiceLineSync), so the sync later just updates
// these rows.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BusinessCentralSalesInvoice, BusinessCentralSalesInvoiceLine } from '@/types/database';
import { mapBcSalesInvoiceLineToDb, type BcSalesInvoiceLine } from './salesInvoiceLineMapper';
import { isPostedInvoice, mapBcSalesInvoiceToDb, type BcSalesInvoice } from './salesInvoiceMapper';

export interface InvoiceMirrorDeps {
  supabase: SupabaseClient;
  listResourcePage: <T>(resource: string, opts: { filter?: string; top: number }) => Promise<T[]>;
  orgId: string;
  connectionId: string;
  environment: string;
  companyId: string;
  now: () => string;
}

const INVOICE_CONFLICT = 'organization_id,bc_connection_id,bc_company_id,bc_invoice_id';
const LINE_CONFLICT = 'organization_id,bc_connection_id,bc_company_id,bc_line_id';

const scope = (deps: InvoiceMirrorDeps) => ({
  organizationId: deps.orgId,
  connectionId: deps.connectionId,
  environment: deps.environment,
  companyId: deps.companyId,
  now: deps.now(),
});

// Each write returns the stored rows: a caller rendering a page must use them
// rather than read them back, because Next.js memoizes identical reads within
// one render (a re-read would return the pre-write result).

/** Stores the invoice; returns the stored row. */
export async function mirrorSalesInvoice(deps: InvoiceMirrorDeps, raw: BcSalesInvoice): Promise<BusinessCentralSalesInvoice> {
  const row = mapBcSalesInvoiceToDb({ ...scope(deps), invoice: raw });
  const { data, error } = await deps.supabase
    .from('business_central_sales_invoices')
    .upsert(row, { onConflict: INVOICE_CONFLICT })
    .select('*')
    .single();
  if (error) throw new Error(`Could not save the invoice: ${error.message}`);
  return data as BusinessCentralSalesInvoice;
}

/** Copies the invoice's lines from BC; returns the stored rows (empty when BC has none). */
export async function mirrorSalesInvoiceLines(deps: InvoiceMirrorDeps, bcInvoiceId: string): Promise<BusinessCentralSalesInvoiceLine[]> {
  // Edm.Guid literals are unquoted in OData v4 filters.
  const lines = await deps.listResourcePage<BcSalesInvoiceLine>('salesInvoiceLines', {
    filter: `documentId eq ${bcInvoiceId}`,
    top: 500,
  });
  if (lines.length === 0) return [];
  const s = scope(deps);
  const rows = lines.map((line) => mapBcSalesInvoiceLineToDb({ ...s, line }));
  const { data, error } = await deps.supabase
    .from('business_central_sales_invoice_lines')
    .upsert(rows, { onConflict: LINE_CONFLICT })
    .select('*');
  if (error) throw new Error(`Could not save the invoice lines: ${error.message}`);
  return (data ?? []) as BusinessCentralSalesInvoiceLine[];
}

/** Reads one posted invoice from BC and stores it; null when BC has no such posted invoice. */
export async function fetchAndMirrorSalesInvoice(deps: InvoiceMirrorDeps, bcInvoiceId: string): Promise<BusinessCentralSalesInvoice | null> {
  const [invoice] = await deps.listResourcePage<BcSalesInvoice>('salesInvoices', { filter: `id eq ${bcInvoiceId}`, top: 1 });
  if (!invoice || !isPostedInvoice(invoice)) return null;
  return mirrorSalesInvoice(deps, invoice);
}
