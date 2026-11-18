'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { editScope, NO_PERMISSION, type Fail, type Scope } from '@/lib/salesOrders/editScope';
import { buildInvoiceDeps } from '@/lib/salesOrders/invoiceDeps';
import { retryInvoiceProcess, runInvoiceProcess, startInvoiceProcess } from '@/lib/salesOrders/invoiceProcess';
import { invoiceBlockReason, isInvoiceResumable } from '@/lib/salesOrders/orderRules';
import { createServiceClient } from '@/lib/supabase/server';

const ORDERS = 'sales_orders';
const NOTHING_TO_RETRY = 'Nothing to retry.';
const ORDER_NOT_FOUND = 'Sales order not found.';
const CHECK_FAILED = 'Could not check Bill.com for this customer.';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const refresh = () => revalidatePath('/sales-orders', 'layout');

/** The active scope for read-only checks, or null without view permission or an environment. */
async function viewScope(): Promise<Scope | null> {
  try {
    const scope = await requireActiveBusinessCentralScope();
    return scope.access.canViewSalesOrders ? scope : null;
  } catch {
    return null;
  }
}

async function loadInvoiceFields(scope: Scope, orderId: string) {
  const { data, error } = await createServiceClient()
    .from(ORDERS)
    .select('id, invoice_state, claimed_until, status, sync_state')
    .eq('id', orderId)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { id: string; invoice_state: string; claimed_until: string | null; status: string; sync_state: string } | null) ?? null;
}

/** Run `work` after the response is sent, then refresh the pages. Never throws. */
function inBackground(scope: Scope, orderId: string, userId: string | undefined, work: (deps: Awaited<ReturnType<typeof buildInvoiceDeps>>) => Promise<unknown>) {
  after(async () => {
    try {
      const deps = await buildInvoiceDeps(scope, { userId });
      await work(deps);
    } catch (e) {
      console.error(`[sales-orders] background invoicing of ${orderId} failed:`, e);
    }
    refresh();
  });
}

/** Start invoicing: claim the order and flip it to Invoicing…, then post and send in the background. */
export async function createInvoice(orderId: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const deps = await buildInvoiceDeps(scope, { userId: scope.user.id });
    const started = await startInvoiceProcess(deps, orderId);
    if (!started.ok) return { ok: false, error: started.error };
    refresh();
    inBackground(scope, orderId, scope.user.id, (d) => runInvoiceProcess(d, orderId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not create the invoice: ${errorMessage(e)}` };
  }
}

/** Retry a failed posting or Bill.com send. Checks cheaply first, then runs in the background. */
export async function retryInvoice(orderId: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const order = await loadInvoiceFields(scope, orderId);
    if (!order) return { ok: false, error: ORDER_NOT_FOUND };
    if (order.invoice_state !== 'post_failed' && order.invoice_state !== 'billcom_failed') {
      return { ok: false, error: NOTHING_TO_RETRY };
    }
    // No in-sync check here: BC may already hold the posted invoice, which the
    // posting step records first; it saves NOT_IN_SYNC on the order otherwise.
    inBackground(scope, orderId, scope.user.id, (d) => retryInvoiceProcess(d, orderId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not retry the invoice: ${errorMessage(e)}` };
  }
}

/** On opening an order: pick up an invoice process that stopped mid-way (lease free). Never throws. */
export async function resumeInvoiceIfStuck(orderId: string): Promise<void> {
  try {
    const scope = await viewScope();
    if (!scope) return;
    const order = await loadInvoiceFields(scope, orderId);
    if (!order) return;
    if (!isInvoiceResumable(order.invoice_state)) return;
    if (order.claimed_until && order.claimed_until >= new Date().toISOString()) return;
    inBackground(scope, orderId, undefined, (d) => runInvoiceProcess(d, orderId));
  } catch (e) {
    console.error(`[sales-orders] could not resume invoicing of ${orderId}:`, e);
  }
}

/** Why this customer can't be invoiced yet (null when ready). */
export async function getInvoiceReadiness(customerNumber: string): Promise<{ blockedReason: string | null }> {
  try {
    const scope = await viewScope();
    if (!scope) return { blockedReason: CHECK_FAILED };
    // Bill.com's own connector copies this environment's invoices: nothing to check in Bill.com.
    if ((scope.connection as { billcom_via_connector?: boolean } | null)?.billcom_via_connector === true) return { blockedReason: null };
    const supabase = createServiceClient();
    const conn = await resolveBillcomConnection(supabase, scope.orgId);
    if (!conn?.enabled) return { blockedReason: invoiceBlockReason(null, false) };
    const { data, error } = await supabase
      .from('billcom_customer_links')
      .select('status, billcom_customer_id')
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId)
      .eq('billcom_connection_id', conn.id)
      .eq('bc_customer_number', customerNumber)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const link = (data as { status: string; billcom_customer_id: string | null } | null) ?? null;
    return { blockedReason: invoiceBlockReason(link, true) };
  } catch {
    return { blockedReason: CHECK_FAILED };
  }
}
