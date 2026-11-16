// Copies posted BC sales invoices and their lines into Nexus's Receivables
// tables, outside the Receivables sync: right after Create invoice posts, and
// when the invoice page finds a gap. Same mappers and conflict targets as the
// sync (arSyncAdapters / salesInvoiceLineSync), so the sync later just updates
// these rows.
import type { SupabaseClient } from '@supabase/supabase-js';
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

export async function mirrorSalesInvoice(deps: InvoiceMirrorDeps, raw: BcSalesInvoice): Promise<void> {
  const row = mapBcSalesInvoiceToDb({ ...scope(deps), invoice: raw });
  const { error } = await deps.supabase.from('business_central_sales_invoices').upsert(row, { onConflict: INVOICE_CONFLICT });
  if (error) throw new Error(`Could not save the invoice: ${error.message}`);
}

/** Copies the invoice's lines from BC; returns how many were stored. */
export async function mirrorSalesInvoiceLines(deps: InvoiceMirrorDeps, bcInvoiceId: string): Promise<number> {
  // Edm.Guid literals are unquoted in OData v4 filters.
  const lines = await deps.listResourcePage<BcSalesInvoiceLine>('salesInvoiceLines', {
    filter: `documentId eq ${bcInvoiceId}`,
    top: 500,
  });
  if (lines.length === 0) return 0;
  const s = scope(deps);
  const rows = lines.map((line) => mapBcSalesInvoiceLineToDb({ ...s, line }));
  const { error } = await deps.supabase.from('business_central_sales_invoice_lines').upsert(rows, { onConflict: LINE_CONFLICT });
  if (error) throw new Error(`Could not save the invoice lines: ${error.message}`);
  return rows.length;
}

/** Reads one posted invoice from BC and stores it; false when BC has no such posted invoice. */
export async function fetchAndMirrorSalesInvoice(deps: InvoiceMirrorDeps, bcInvoiceId: string): Promise<boolean> {
  const [invoice] = await deps.listResourcePage<BcSalesInvoice>('salesInvoices', { filter: `id eq ${bcInvoiceId}`, top: 1 });
  if (!invoice || !isPostedInvoice(invoice)) return false;
  await mirrorSalesInvoice(deps, invoice);
  return true;
}
