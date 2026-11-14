// Lease on a sales order (sales_orders.claimed_until) so two triggers (save,
// list sweep, Try again, Overwrite, delete) never work on one order at once.
// Same pattern as billcom_customer_links: one conditional UPDATE that only
// matches a row with no live lease; a returned row means we hold it.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SyncState } from '@/types/salesOrders';
import { syncSalesOrder, type OrderSyncDeps } from './orderSync';
import { SAVE_UNFINISHED } from './saveMarker';

export const LEASE_MS = 120_000;
export const SWEEP_BATCH = 5;


const ORDERS = 'sales_orders';

export interface OrderScope {
  orgId: string;
  connectionId: string;
}

/** The claimed_until value a claim made at `nowIso` writes. */
export function leaseUntil(nowIso: string): string {
  return new Date(Date.parse(nowIso) + LEASE_MS).toISOString();
}

/** True when this call took the lease (no lease, or the previous one expired). */
export async function claimOrder(
  supabase: SupabaseClient,
  orderId: string,
  nowIso: string,
  scope?: OrderScope,
): Promise<boolean> {
  let q = supabase
    .from(ORDERS)
    .update({ claimed_until: leaseUntil(nowIso) })
    .eq('id', orderId);
  if (scope) q = q.eq('organization_id', scope.orgId).eq('bc_connection_id', scope.connectionId);
  const { data, error } = await q.or(`claimed_until.is.null,claimed_until.lt.${nowIso}`).select('id');
  if (error) throw new Error(`Could not claim the sales order: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Clear the lease. With `until` (the value our claim wrote), only our own
 * lease is cleared, so a run whose lease expired can't free a newer claim.
 */
export async function releaseOrder(supabase: SupabaseClient, orderId: string, until?: string): Promise<void> {
  let q = supabase.from(ORDERS).update({ claimed_until: null }).eq('id', orderId);
  if (until) q = q.eq('claimed_until', until);
  const { error } = await q;
  if (error) throw new Error(`Could not release the sales order: ${error.message}`);
}

/** Release without letting a release failure hide the real result; the lease expires on its own. */
async function safeRelease(supabase: SupabaseClient, orderId: string, until: string): Promise<void> {
  try {
    await releaseOrder(supabase, orderId, until);
  } catch (e) {
    console.error('[sales-orders] could not release the order lease:', e);
  }
}

/**
 * Run `fn` while holding the order's lease; null (fn not run) when someone
 * else holds it. The lease is always released.
 */
export async function withOrderClaim<T>(
  deps: Pick<OrderSyncDeps, 'supabase' | 'orgId' | 'connectionId' | 'now'>,
  orderId: string,
  fn: () => Promise<T>,
): Promise<{ claimed: true; value: T } | { claimed: false }> {
  const nowIso = deps.now();
  const scope = { orgId: deps.orgId, connectionId: deps.connectionId };
  if (!(await claimOrder(deps.supabase, orderId, nowIso, scope))) return { claimed: false };
  try {
    return { claimed: true, value: await fn() };
  } finally {
    await safeRelease(deps.supabase, orderId, leaseUntil(nowIso));
  }
}

/** Claim, sync and release one order; null when it is already claimed. */
export async function syncWithClaim(
  deps: OrderSyncDeps,
  orderId: string,
  opts: { overwrite?: boolean } = {},
): Promise<SyncState | null> {
  const res = await withOrderClaim(deps, orderId, () => syncSalesOrder(deps, orderId, opts));
  return res.claimed ? res.value : null;
}

/**
 * Pick up pending/failed orders (fewest attempts, then oldest) whose lease is free and sync each
 * one. Conflicts, and failed saves that did not finish, are never retried automatically. Returns how many orders
 * were synced (whatever state they ended in).
 */
export async function sweepPendingOrders(deps: OrderSyncDeps, limit = SWEEP_BATCH): Promise<number> {
  const nowIso = deps.now();
  const { data, error } = await deps.supabase
    .from(ORDERS)
    .select('id')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .in('sync_state', ['pending', 'failed'])
    .or(`claimed_until.is.null,claimed_until.lt.${nowIso}`)
    .or(`sync_state.eq.pending,sync_error.is.null,sync_error.not.like.${SAVE_UNFINISHED}*`)
    // Fewest failed attempts first, so orders that keep failing don't starve
    // newer pending ones; then oldest first (sync writes updated_at each run).
    .order('sync_attempts', { ascending: true })
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Could not read pending sales orders: ${error.message}`);
  let handled = 0;
  for (const { id } of (data ?? []) as { id: string }[]) {
    try {
      if ((await syncWithClaim(deps, id)) !== null) handled += 1;
    } catch (e) {
      console.error(`[sales-orders] background sync of ${id} failed:`, e);
    }
  }
  return handled;
}
