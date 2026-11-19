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
import { isBillcomConnectorMode, resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks';
import { findConnectorInvoice, readBillcomInvoiceStatus, type BillcomPanel } from '@/lib/billcom/invoiceStatus';
import { resolveActiveBcConnection } from '@/lib/businessCentral/activeConnection';
import { createBcClientForOrg } from '@/lib/businessCentral/client';
import { fetchAndMirrorSalesInvoice, mirrorSalesInvoiceLines, type InvoiceMirrorDeps } from '@/lib/businessCentral/invoiceMirror';
import { createServiceClient } from '@/lib/supabase/server';
import type { BusinessCentralConnection, BusinessCentralSalesInvoice, BusinessCentralSalesInvoiceLine } from '@/types/database';
import type { InvoiceChangeRow } from '@/types/invoiceChanges';
import type { BillcomLookup } from '@/types/stripe';

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

type OrderLink = { id: string; bc_order_number: string | null; billcom_invoice_id: string | null };

async function readOrderBy(ctx: Ctx, column: 'bc_posted_invoice_id' | 'id', value: string): Promise<OrderLink | null> {
  const { data, error } = await ctx.supabase
    .from('sales_orders')
    .select('id, bc_order_number, billcom_invoice_id')
    .eq('organization_id', ctx.orgId)
    .eq('bc_connection_id', ctx.connection.id)
    .eq(column, value)
    .maybeSingle();
  if (error) throw new Error(`Could not read the sales order: ${error.message}`);
  return (data as OrderLink | null) ?? null;
}

const CHANGES = 'sales_invoice_changes';

/** Changes whose old (cancelled) invoice is this one, newest first. */
async function changesReplacing(ctx: Ctx, bcInvoiceId: string): Promise<InvoiceChangeRow[]> {
  const { data, error } = await ctx.supabase
    .from(CHANGES)
    .select('*')
    .eq('organization_id', ctx.orgId)
    .eq('bc_connection_id', ctx.connection.id)
    .eq('old_bc_invoice_id', bcInvoiceId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not read the invoice changes: ${error.message}`);
  return (data ?? []) as InvoiceChangeRow[];
}

async function orderChanges(ctx: Ctx, salesOrderId: string): Promise<InvoiceChangeRow[]> {
  const { data, error } = await ctx.supabase
    .from(CHANGES)
    .select('*')
    .eq('organization_id', ctx.orgId)
    .eq('bc_connection_id', ctx.connection.id)
    .eq('sales_order_id', salesOrderId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not read the invoice changes: ${error.message}`);
  return (data ?? []) as InvoiceChangeRow[];
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
  /** Every change of the order's invoice, newest first. */
  changes: InvoiceChangeRow[];
  /** Set when a finished change cancelled this invoice and posted another. */
  replacedBy: { id: string; number: string } | null;
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

  // The order points at its current invoice; a replaced (cancelled) one is reached through its change record.
  const replacing = await changesReplacing(ctx, bcInvoiceId);
  const order =
    (await readOrderBy(ctx, 'bc_posted_invoice_id', bcInvoiceId)) ??
    (replacing[0] ? await readOrderBy(ctx, 'id', replacing[0].sales_order_id) : null);
  const done = replacing.find((c) => c.state === 'done' && c.new_bc_invoice_id);
  return {
    invoice,
    lines,
    linesError,
    salesOrder: order ? { id: order.id, bcOrderNumber: order.bc_order_number, billcomInvoiceId: order.billcom_invoice_id ?? null } : null,
    changes: order ? await orderChanges(ctx, order.id) : [],
    replacedBy: done ? { id: done.new_bc_invoice_id as string, number: done.new_bc_invoice_number ?? '' } : null,
  };
}

/** What the Bill.com panel needs, taken from the page data (never re-read). */
export interface BillcomPanelInput {
  customerNumber: string | null;
  /** Invoice #, then BC Invoice No. */
  invoiceNumbers: string[];
  /** Set when Nexus created the Bill.com invoice. */
  billcomInvoiceId: string | null;
  /** BC total incl. tax and customer name: connector mode only matches when Bill.com agrees. */
  bcTotal?: number | null;
  customerName?: string | null;
}

/**
 * The live Bill.com invoice for a BC invoice: by the order's stored Bill.com id,
 * else by number among the linked customer's invoices (exactly one match only).
 * Shared by the Bill.com panel and charging, which needs the Bill.com customer
 * id for record-payment: the invoice's own customerId, else the customer link.
 * Throws on Bill.com or database errors.
 */
export async function findBillcomInvoiceForCharge(input: BillcomPanelInput): Promise<BillcomLookup> {
  const ctx = await context();
  if (!ctx) return { kind: 'not_found' };

  const conn = await resolveBillcomConnection(ctx.supabase, ctx.orgId, ctx.connection.id);
  if (!conn?.enabled) return { kind: 'off' };
  let client;
  try {
    client = await createBillcomClientForConnection(conn.id, ctx.orgId, { supabase: ctx.supabase });
  } catch (e) {
    console.error('[invoice page] could not create the Bill.com client:', e);
    return { kind: 'off' };
  }

  const readLinkedCustomerId = async (): Promise<string | null> => {
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
    return ready?.status === 'synced' && ready.billcom_customer_id ? ready.billcom_customer_id : null;
  };

  if (input.billcomInvoiceId) {
    const found = await readBillcomInvoiceStatus(client, { billcomInvoiceId: input.billcomInvoiceId, invoiceNumbers: [] });
    if (found === 'ambiguous') return { kind: 'ambiguous' };
    if (!found) return { kind: 'not_found' };
    return { kind: 'found', status: found, billcomCustomerId: found.customerId ?? (await readLinkedCustomerId()) };
  }

  // Connector mode: Bill.com's own BC connector copied the invoice, so Nexus has
  // no customer links. Find it by number; the invoice names its Bill.com customer.
  if (await isBillcomConnectorMode(ctx.supabase, ctx.orgId, ctx.connection.id)) {
    const r = await findConnectorInvoice(client, {
      invoiceNumbers: input.invoiceNumbers,
      bcTotal: input.bcTotal ?? null,
      customerName: input.customerName ?? null,
    });
    return r.kind === 'found' ? { kind: 'found', status: r.status, billcomCustomerId: r.status.customerId ?? null } : { kind: r.kind };
  }

  const customerId = await readLinkedCustomerId();
  if (!customerId) return { kind: 'not_linked' };
  const found = await readBillcomInvoiceStatus(client, { billcomCustomerId: customerId, invoiceNumbers: input.invoiceNumbers });
  if (found === 'ambiguous') return { kind: 'ambiguous' };
  return found ? { kind: 'found', status: found, billcomCustomerId: customerId } : { kind: 'not_found' };
}

/** The Bill.com side of the invoice. Never throws: any failure is an `error` panel. */
export async function getSalesInvoiceBillcomPanel(input: BillcomPanelInput): Promise<BillcomPanel> {
  try {
    const found = await findBillcomInvoiceForCharge(input);
    return found.kind === 'found' ? { kind: 'found', status: found.status } : { kind: found.kind };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
