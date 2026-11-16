import 'server-only';

// Data for the Receivables invoice page (/receivables/invoices/<bc_invoice_id>):
// Nexus's copy of the posted BC invoice and its lines (filled from BC when
// missing), the sales order that posted it, and a live read of its Bill.com side.
//
// Server-only (not server actions): the page is the only caller, and the
// Bill.com panel takes the invoice details the page already loaded. It must
// not read the invoice row again: Next.js memoizes identical reads within one
// render, so after a fill from BC a second read returns the pre-write result.
import { requirePermission } from '@/lib/auth/currentUserAccess';
import { canViewReceivables } from '@/lib/auth/permissions';
import { createBillcomClientForConnection } from '@/lib/billcom/connection';
import { resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks';
import { readBillcomInvoiceStatus, type BillcomPanel } from '@/lib/billcom/invoiceStatus';
import { resolveActiveBcConnection } from '@/lib/businessCentral/activeConnection';
import { createBcClientForOrg } from '@/lib/businessCentral/client';
import { fetchAndMirrorSalesInvoice, mirrorSalesInvoiceLines, type InvoiceMirrorDeps } from '@/lib/businessCentral/invoiceMirror';
import { createServiceClient } from '@/lib/supabase/server';
import type { BusinessCentralConnection, BusinessCentralSalesInvoice, BusinessCentralSalesInvoiceLine } from '@/types/database';

const INVOICES = 'business_central_sales_invoices';
const LINES = 'business_central_sales_invoice_lines';
// The id goes into a BC OData filter unquoted, so only a GUID is accepted.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Supabase = ReturnType<typeof createServiceClient>;
type Ctx = { orgId: string; connection: BusinessCentralConnection; supabase: Supabase };

async function context(): Promise<Ctx | null> {
  const { orgId, user } = await requirePermission(canViewReceivables, 'You do not have permission to view receivables');
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) return null;
  return { orgId, connection, supabase: createServiceClient() };
}

// organization_id AND bc_connection_id are the only protection: the service client bypasses RLS.
async function readInvoice(ctx: Ctx, bcInvoiceId: string): Promise<BusinessCentralSalesInvoice | null> {
  const { data, error } = await ctx.supabase
    .from(INVOICES)
    .select('*')
    .eq('organization_id', ctx.orgId)
    .eq('bc_connection_id', ctx.connection.id)
    .eq('bc_invoice_id', bcInvoiceId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the invoice: ${error.message}`);
  return (data as BusinessCentralSalesInvoice | null) ?? null;
}

async function readLines(ctx: Ctx, bcInvoiceId: string): Promise<BusinessCentralSalesInvoiceLine[]> {
  const { data, error } = await ctx.supabase
    .from(LINES)
    .select('*')
    .eq('organization_id', ctx.orgId)
    .eq('bc_connection_id', ctx.connection.id)
    .eq('bc_invoice_id', bcInvoiceId)
    .order('sequence', { ascending: true });
  if (error) throw new Error(`Could not read the invoice lines: ${error.message}`);
  return (data ?? []) as BusinessCentralSalesInvoiceLine[];
}

async function readOrder(ctx: Ctx, bcInvoiceId: string) {
  const { data, error } = await ctx.supabase
    .from('sales_orders')
    .select('id, bc_order_number, billcom_invoice_id')
    .eq('organization_id', ctx.orgId)
    .eq('bc_connection_id', ctx.connection.id)
    .eq('bc_posted_invoice_id', bcInvoiceId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the sales order: ${error.message}`);
  return (data as { id: string; bc_order_number: string | null; billcom_invoice_id: string | null } | null) ?? null;
}

async function mirrorDeps(ctx: Ctx): Promise<InvoiceMirrorDeps> {
  const bc = await createBcClientForOrg(ctx.orgId, ctx.connection.id);
  return {
    supabase: ctx.supabase,
    listResourcePage: (resource, opts) => bc.listResourcePage(resource, opts),
    orgId: ctx.orgId,
    connectionId: ctx.connection.id,
    environment: ctx.connection.environment,
    companyId: ctx.connection.company_id,
    now: () => new Date().toISOString(),
  };
}

export interface SalesInvoicePageData {
  invoice: BusinessCentralSalesInvoice;
  lines: BusinessCentralSalesInvoiceLine[];
  /** Lines were missing and BC couldn't be read to fill them. */
  linesError: boolean;
  salesOrder: { id: string; bcOrderNumber: string | null; billcomInvoiceId: string | null } | null;
}

/** null → the page is a 404 (not a GUID, no BC connection, or no such posted invoice). */
export async function getSalesInvoicePage(bcInvoiceId: string): Promise<SalesInvoicePageData | null> {
  if (!GUID.test(bcInvoiceId)) return null;
  const ctx = await context();
  if (!ctx) return null;

  // Gaps are filled from BC, and the stored rows the mirror returns are used
  // as-is (a read-back in this render would be memoized; see the top).
  let mirror: InvoiceMirrorDeps | null = null;
  let invoice = await readInvoice(ctx, bcInvoiceId);
  if (!invoice) {
    mirror = await mirrorDeps(ctx);
    invoice = await fetchAndMirrorSalesInvoice(mirror, bcInvoiceId);
    if (!invoice) return null;
  }

  // The header is enough to show the page: a BC failure here only loses the lines.
  let lines = await readLines(ctx, bcInvoiceId);
  let linesError = false;
  if (lines.length === 0) {
    try {
      mirror ??= await mirrorDeps(ctx);
      lines = (await mirrorSalesInvoiceLines(mirror, bcInvoiceId)).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    } catch (e) {
      console.error(`[invoice page] could not load lines of ${bcInvoiceId} from BC:`, e);
      linesError = true;
    }
  }

  const order = await readOrder(ctx, bcInvoiceId);
  return {
    invoice,
    lines,
    linesError,
    salesOrder: order ? { id: order.id, bcOrderNumber: order.bc_order_number, billcomInvoiceId: order.billcom_invoice_id ?? null } : null,
  };
}

/** What the Bill.com panel needs, taken from the page data (never re-read). */
export interface BillcomPanelInput {
  customerNumber: string | null;
  /** Invoice #, then BC Invoice No. */
  invoiceNumbers: string[];
  /** Set when Nexus created the Bill.com invoice. */
  billcomInvoiceId: string | null;
}

/** The Bill.com side of the invoice. Never throws: any failure is an `error` panel. */
export async function getSalesInvoiceBillcomPanel(input: BillcomPanelInput): Promise<BillcomPanel> {
  try {
    const ctx = await context();
    if (!ctx) return { kind: 'not_found' };

    const conn = await resolveBillcomConnection(ctx.supabase, ctx.orgId);
    if (!conn?.enabled) return { kind: 'off' };
    let client;
    try {
      client = await createBillcomClientForConnection(conn.id, ctx.orgId, { supabase: ctx.supabase });
    } catch (e) {
      console.error('[invoice page] could not create the Bill.com client:', e);
      return { kind: 'off' };
    }

    let found;
    if (input.billcomInvoiceId) {
      found = await readBillcomInvoiceStatus(client, { billcomInvoiceId: input.billcomInvoiceId, invoiceNumbers: [] });
    } else {
      const { data: link, error } = await ctx.supabase
        .from('billcom_customer_links')
        .select('status, billcom_customer_id')
        .eq('organization_id', ctx.orgId)
        .eq('bc_connection_id', ctx.connection.id)
        .eq('billcom_connection_id', conn.id)
        .eq('bc_customer_number', input.customerNumber ?? '')
        .maybeSingle();
      if (error) throw new Error(`Could not read the Bill.com customer link: ${error.message}`);
      const ready = link as { status: string; billcom_customer_id: string | null } | null;
      if (!ready || ready.status !== 'synced' || !ready.billcom_customer_id) return { kind: 'not_linked' };
      found = await readBillcomInvoiceStatus(client, { billcomCustomerId: ready.billcom_customer_id, invoiceNumbers: input.invoiceNumbers });
    }
    if (found === 'ambiguous') return { kind: 'ambiguous' };
    return found ? { kind: 'found', status: found } : { kind: 'not_found' };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
