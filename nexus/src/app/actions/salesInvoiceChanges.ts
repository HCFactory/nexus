'use server';

// Change invoice: server actions for the sales order page
// (spec: docs/superpowers/specs/2026-11-17-change-invoice-design.md).
// No exported types here ('use server'); they live in types/invoiceChanges.ts.
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { readChangeBlock } from '@/lib/billcom/invoiceChangeCheck';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { editScope, NO_PERMISSION, type Fail, type Scope } from '@/lib/salesOrders/editScope';
import { changeLinesFromDrafts } from '@/lib/salesOrders/invoiceChangeLines';
import {
  deleteExtraDrafts,
  discardInvoiceChange,
  findExtraDrafts,
  loadOpenChange,
  retryInvoiceChange,
  runInvoiceChange,
  startInvoiceChange,
} from '@/lib/salesOrders/invoiceChangeProcess';
import { buildInvoiceDeps } from '@/lib/salesOrders/invoiceDeps';
import { createServiceClient } from '@/lib/supabase/server';
import { FAILED_CHANGE_STATES, RESUMABLE_CHANGE_STATES, type DraftSummary, type InvoiceChangeRow } from '@/types/invoiceChanges';
import type { LineDraft } from '@/types/salesOrders';

type Deps = Awaited<ReturnType<typeof buildInvoiceDeps>>;
type OrderFields = { id: string; invoice_state: string; claimed_until: string | null; billcom_invoice_id: string | null };

const ORDER_NOT_FOUND = 'Sales order not found.';
const NOTHING_TO_RETRY = 'Nothing to retry.';
const NOTHING_TO_CLEAN = 'Nothing to clean up.';
const CHECK_FAILED = "Couldn't check this invoice right now. Try again.";

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const refresh = () => {
  revalidatePath('/sales-orders', 'layout');
  revalidatePath('/receivables/invoices', 'layout');
};

async function viewScope(): Promise<Scope | null> {
  try {
    const scope = await requireActiveBusinessCentralScope();
    return scope.access.canViewSalesOrders ? scope : null;
  } catch {
    return null;
  }
}

async function loadOrderFields(deps: Deps, orderId: string): Promise<OrderFields | null> {
  const { data, error } = await deps.supabase
    .from('sales_orders')
    .select('id, invoice_state, claimed_until, billcom_invoice_id')
    .eq('id', orderId)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as OrderFields | null) ?? null;
}

async function loadLineRows(deps: Deps, orderId: string) {
  const { data, error } = await deps.supabase
    .from('sales_order_lines')
    .select('*')
    .eq('sales_order_id', orderId)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .order('position');
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function userName(userId: string): Promise<string> {
  const { data } = await createServiceClient().from('users').select('display_name').eq('id', userId).maybeSingle();
  return ((data as { display_name: string | null } | null)?.display_name ?? '').trim();
}

/** Run `work` after the response is sent, then refresh the pages. Never throws. */
function inBackground(scope: Scope, orderId: string, work: (deps: Deps) => Promise<unknown>) {
  after(async () => {
    try {
      await work(await buildInvoiceDeps(scope, { userId: scope.user.id }));
    } catch (e) {
      console.error(`[sales-orders] background invoice change of ${orderId} failed:`, e);
    }
    refresh();
  });
}

/** The order's open change, and why Change invoice is disabled (null = allowed or not applicable). */
export async function getInvoiceChangeState(orderId: string): Promise<{ change: InvoiceChangeRow | null; blockedReason: string | null }> {
  const scope = await viewScope();
  if (!scope) return { change: null, blockedReason: null };
  try {
    const deps = await buildInvoiceDeps(scope);
    const change = await loadOpenChange(deps, orderId);
    if (change) return { change, blockedReason: null };
    const order = await loadOrderFields(deps, orderId);
    if (!order || order.invoice_state !== 'done') return { change: null, blockedReason: null };
    return { change: null, blockedReason: await readChangeBlock(deps.billcom, order.billcom_invoice_id) };
  } catch (e) {
    console.error(`[sales-orders] could not read the invoice change state of ${orderId}:`, e);
    return { change: null, blockedReason: CHECK_FAILED };
  }
}

/** Start a change: re-checks Bill.com on the server, then cancels and reposts in the background. */
export async function startChangeInvoice(orderId: string, drafts: LineDraft[], reason: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const deps = await buildInvoiceDeps(scope, { userId: scope.user.id });
    const order = await loadOrderFields(deps, orderId);
    if (!order) return { ok: false, error: ORDER_NOT_FOUND };
    const lines = changeLinesFromDrafts(drafts, (await loadLineRows(deps, orderId)) as Parameters<typeof changeLinesFromDrafts>[1]);
    if (!lines.ok) return { ok: false, error: lines.error };
    const blockedReason = await readChangeBlock(deps.billcom, order.billcom_invoice_id);
    if (blockedReason) return { ok: false, error: blockedReason };
    const started = await startInvoiceChange(deps, {
      orderId,
      reason,
      lines: lines.lines,
      userId: scope.user.id,
      userName: await userName(scope.user.id),
      blockedReason,
    });
    if (!started.ok) return { ok: false, error: started.error };
    refresh();
    inBackground(scope, orderId, (d) => runInvoiceChange(d, started.changeId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not change the invoice: ${errorMessage(e)}` };
  }
}

/** Retry the failed step of the order's open change, in the background. */
export async function retryChangeInvoice(orderId: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const deps = await buildInvoiceDeps(scope, { userId: scope.user.id });
    const change = await loadOpenChange(deps, orderId);
    if (!change || !FAILED_CHANGE_STATES.includes(change.state)) return { ok: false, error: NOTHING_TO_RETRY };
    inBackground(scope, orderId, (d) => retryInvoiceChange(d, change.id));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not retry the change: ${errorMessage(e)}` };
  }
}

/** Drop the open change (only before BC cancelled the old invoice). */
export async function discardChangeInvoice(orderId: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const deps = await buildInvoiceDeps(scope, { userId: scope.user.id });
    const change = await loadOpenChange(deps, orderId);
    if (!change) return { ok: false, error: NOTHING_TO_RETRY };
    const res = await discardInvoiceChange(deps, change.id);
    if (res.ok) refresh();
    return res;
  } catch (e) {
    return { ok: false, error: `Could not discard the change: ${errorMessage(e)}` };
  }
}

/** What "Delete extra drafts" would keep and delete in BC, for the confirm box. */
export async function getExtraInvoiceDrafts(
  orderId: string,
): Promise<{ ok: true; keep: DraftSummary | null; extra: DraftSummary[] } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const deps = await buildInvoiceDeps(scope);
    const change = await loadOpenChange(deps, orderId);
    if (!change) return { ok: false, error: NOTHING_TO_CLEAN };
    return await findExtraDrafts(deps, change.id);
  } catch (e) {
    return { ok: false, error: `Could not read BC's drafts: ${errorMessage(e)}` };
  }
}

/** Delete the extra drafts the rep confirmed in the box (by id); the kept draft is never deleted. */
export async function deleteExtraInvoiceDrafts(orderId: string, draftIds: string[]): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const deps = await buildInvoiceDeps(scope, { userId: scope.user.id });
    const change = await loadOpenChange(deps, orderId);
    if (!change) return { ok: false, error: NOTHING_TO_CLEAN };
    const res = await deleteExtraDrafts(deps, change.id, draftIds);
    refresh();
    return res;
  } catch (e) {
    return { ok: false, error: `Could not delete the drafts: ${errorMessage(e)}` };
  }
}

/** Opening the order resumes a change that stopped midway (lease expired). Never throws. */
export async function resumeInvoiceChangeIfStuck(orderId: string): Promise<void> {
  try {
    const scope = await viewScope();
    if (!scope) return;
    const deps = await buildInvoiceDeps(scope);
    const change = await loadOpenChange(deps, orderId);
    if (!change || !RESUMABLE_CHANGE_STATES.includes(change.state)) return;
    const order = await loadOrderFields(deps, orderId);
    if (!order || (order.claimed_until && order.claimed_until >= deps.now())) return;
    inBackground(scope, orderId, (d) => runInvoiceChange(d, change.id));
  } catch (e) {
    console.error(`[sales-orders] could not resume the invoice change of ${orderId}:`, e);
  }
}
