'use server';

import { revalidatePath } from 'next/cache';
import { markPending, planInitialPush, pushCustomers, type PushPreview, type PushResult } from '@/lib/billcom/customerPush';
import {
  openPushDeps,
  pushCustomerAfterSave,
  resolveBillcomConnection,
  type BillcomSaveStatus,
} from '@/lib/billcom/customerSyncHooks';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { createServiceClient } from '@/lib/supabase/server';
import type { BillcomCustomerLinkStatus } from '@/types/database';

type Fail = { ok: false; error: string };
type Scope = Awaited<ReturnType<typeof requireActiveBusinessCentralScope>>;

const ADMIN_ONLY = 'Only admins can push customers to Bill.com';
const NO_PERMISSION = "You don't have permission to change customers";
const OFF = 'Bill.com is turned off. Turn it on in Admin to send customers.';
const BULK_BUDGET_MS = 25_000;
const PAGE = 1000;

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

async function pageAll<T>(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }> },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error((error as { message?: string }).message ?? String(error));
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
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
    const rows = await pageAll<{ bc_customer_number: string | null }>(() =>
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

/** Send the next time-limited batch of pending and failed customers. */
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
    const billcom = await pushCustomerAfterSave(billcomScope(scope), customerNumber);
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
    const conn = await resolveBillcomConnection(supabase, scope.orgId);
    if (!conn) return { ok: true, on: false, counts };
    const links = await pageAll<{ status: BillcomCustomerLinkStatus }>(() =>
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
