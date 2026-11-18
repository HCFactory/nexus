'use server';

import { revalidatePath } from 'next/cache';
import { markPending, planInitialPush, pushCustomers, type PushPreview, type PushResult } from '@/lib/billcom/customerPush';
import {
  openPushDeps,
  pushCustomerAfterSave,
  resolveBillcomConnection,
  type BillcomSaveStatus,
} from '@/lib/billcom/customerSyncHooks';
import { fetchAll } from '@/lib/supabase/fetchAll';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { createServiceClient } from '@/lib/supabase/server';
import type { BillcomCustomerLinkStatus } from '@/types/database';

type Fail = { ok: false; error: string };
type Scope = Awaited<ReturnType<typeof requireActiveBusinessCentralScope>>;

const ADMIN_ONLY = 'Only admins can push customers to Bill.com';
const NO_PERMISSION = "You don't have permission to change customers";
const OFF = 'Bill.com is turned off. Turn it on in Admin to send customers.';
const BULK_BUDGET_MS = 25_000;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const billcomScope = (scope: Scope) => ({
  supabase: createServiceClient(),
  orgId: scope.orgId,
  bcConnectionId: scope.bcConnectionId,
});

async function adminScope(): Promise<Scope | null> {
  const scope = await requireActiveBusinessCentralScope();
  return scope.access.isAdmin ? scope : null;
}


/** Dry run of the first push: what would be linked, created, updated, deactivated. Writes nothing. */
export async function previewInitialPush(): Promise<{ ok: true; preview: PushPreview } | Fail> {
  try {
    const scope = await adminScope();
    if (!scope) return { ok: false, error: ADMIN_ONLY };
    const deps = await openPushDeps(billcomScope(scope));
    if (!deps) return { ok: false, error: OFF };
    return { ok: true, preview: await planInitialPush(deps) };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Queue every customer, then send one time-limited batch; the rest stay pending. */
export async function confirmInitialPush(): Promise<{ ok: true; result: PushResult } | Fail> {
  try {
    const scope = await adminScope();
    if (!scope) return { ok: false, error: ADMIN_ONLY };
    const bScope = billcomScope(scope);
    const deps = await openPushDeps(bScope);
    if (!deps) return { ok: false, error: OFF };
    const rows = await fetchAll<{ bc_customer_number: string | null }>(() =>
      bScope.supabase
        .from('business_central_customers')
        .select('bc_customer_number')
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId)
        .order('id'),
    );
    await markPending(deps, rows.flatMap((r) => (r.bc_customer_number ? [r.bc_customer_number] : [])));
    const result = await pushCustomers(deps, { budgetMs: BULK_BUDGET_MS });
    revalidatePath('/customers', 'layout');
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Send the next time-limited batch of pending customers. */
export async function runPendingPush(): Promise<{ ok: true; result: PushResult } | Fail> {
  try {
    const scope = await adminScope();
    if (!scope) return { ok: false, error: ADMIN_ONLY };
    const deps = await openPushDeps(billcomScope(scope));
    if (!deps) return { ok: false, error: OFF };
    const result = await pushCustomers(deps, { budgetMs: BULK_BUDGET_MS });
    revalidatePath('/customers', 'layout');
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Try one customer again. Allowed for anyone who can edit customers. */
export async function retryCustomerPush(customerNumber: string): Promise<{ ok: true; billcom: BillcomSaveStatus } | Fail> {
  try {
    const scope = await requireActiveBusinessCentralScope();
    if (!scope.access.canEditCustomers || !scope.access.canViewCustomers) return { ok: false, error: NO_PERMISSION };
    if (!customerNumber) return { ok: false, error: 'Customer number is missing.' };
    const bScope = billcomScope(scope);
    const { data, error } = await bScope.supabase
      .from('business_central_customers')
      .select('id')
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId)
      .eq('bc_customer_number', customerNumber);
    if (error) return { ok: false, error: error.message };
    if (!data?.length) return { ok: false, error: "That customer wasn't found." };
    const billcom = await pushCustomerAfterSave(bScope, customerNumber);
    revalidatePath('/customers', 'layout');
    return { ok: true, billcom };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** How many customers are pending, sent, failed or need attention, and whether Bill.com is on. */
export async function getBillcomPushStatus(): Promise<
  { ok: true; on: boolean; counts: Record<BillcomCustomerLinkStatus, number> } | Fail
> {
  try {
    const scope = await requireActiveBusinessCentralScope();
    if (!scope.access.canViewCustomers) return { ok: false, error: "You don't have permission to view customers" };
    const counts: Record<BillcomCustomerLinkStatus, number> = { pending: 0, synced: 0, failed: 0, needs_attention: 0 };
    const supabase = createServiceClient();
    const conn = await resolveBillcomConnection(supabase, scope.orgId, scope.bcConnectionId);
    if (!conn) return { ok: true, on: false, counts };
    const links = await fetchAll<{ status: BillcomCustomerLinkStatus }>(() =>
      supabase
        .from('billcom_customer_links')
        .select('status')
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId)
        .eq('billcom_connection_id', conn.id)
        .order('id'),
    );
    for (const l of links) if (l.status in counts) counts[l.status]++;
    return { ok: true, on: conn.enabled, counts };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export interface BillcomCustomerView {
  /** Bill.com connected and turned on. When false, show no Bill.com UI. */
  on: boolean;
  isAdmin: boolean;
  /** May use Retry on one customer. */
  canRetry: boolean;
  /** Customers waiting to be sent (pending only; failed wait for a retry). */
  pendingCount: number;
  /** Link status by BC customer number. */
  links: Record<string, { status: BillcomCustomerLinkStatus; lastError: string | null }>;
}

const VIEW_OFF: BillcomCustomerView = { on: false, isAdmin: false, canRetry: false, pendingCount: 0, links: {} };

/** Bill.com link statuses for the customer pages (all, or just one customer). Never throws. */
export async function getBillcomCustomerView(customerNumber?: string): Promise<BillcomCustomerView> {
  try {
    const scope = await requireActiveBusinessCentralScope();
    if (!scope.access.canViewCustomers) return VIEW_OFF;
    const supabase = createServiceClient();
    const conn = await resolveBillcomConnection(supabase, scope.orgId, scope.bcConnectionId);
    if (!conn || !conn.enabled) return VIEW_OFF;
    const rows = await fetchAll<{ bc_customer_number: string; status: BillcomCustomerLinkStatus; last_error: string | null }>(
      () => {
        const q = supabase
          .from('billcom_customer_links')
          .select('bc_customer_number, status, last_error')
          .eq('organization_id', scope.orgId)
          .eq('bc_connection_id', scope.bcConnectionId)
          .eq('billcom_connection_id', conn.id);
        return (customerNumber ? q.eq('bc_customer_number', customerNumber) : q).order('id');
      },
    );
    const links: BillcomCustomerView['links'] = {};
    let pendingCount = 0;
    for (const r of rows) {
      links[r.bc_customer_number] = { status: r.status, lastError: r.last_error };
      if (r.status === 'pending') pendingCount++;
    }
    return {
      on: true,
      isAdmin: scope.access.isAdmin === true,
      canRetry: scope.access.canEditCustomers === true,
      pendingCount,
      links,
    };
  } catch (e) {
    console.error('getBillcomCustomerView failed', e);
    return VIEW_OFF;
  }
}
