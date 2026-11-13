import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { BillcomClient } from './client';
import { createBillcomClientForConnection } from './connection';
import { payloadHash, shouldBeArchived, toBillcomCustomer } from './customerPayload';
import { markPending, pushCustomers, type PushDeps, type PushResult } from './customerPush';
import { BillcomConnectionDisabledError } from './errors';
import { fetchAll } from '@/lib/supabase/fetchAll';
import type { BillcomCustomerLink, BusinessCentralCustomer } from '@/types/database';

/**
 * Glue between customer saves / BC sync and the Bill.com customer push.
 * Nothing here may make a customer save or a sync fail.
 */

export type BillcomSaveStatus = {
  status: 'synced' | 'pending' | 'failed' | 'off';
  message?: string;
};

export interface BillcomScope {
  supabase: SupabaseClient;
  orgId: string;
  bcConnectionId: string;
}

export const OFF_MESSAGE = "Bill.com is turned off — this customer will be sent when it's turned on.";
export const PENDING_MESSAGE = "Bill.com didn't finish in time — this customer will be sent on the next run.";


/** The org's Bill.com connection: enabled ones first (default, else the only one). */
export async function resolveBillcomConnection(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ id: string; enabled: boolean } | null> {
  const { data, error } = await supabase
    .from('billcom_connections')
    .select('id, is_enabled, is_default')
    .eq('organization_id', orgId);
  if (error) throw new Error(`Could not read the Bill.com connection: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; is_enabled: boolean; is_default: boolean }>;
  const pick = (list: typeof rows) => list.find((r) => r.is_default) ?? (list.length === 1 ? list[0] : undefined);
  const enabled = pick(rows.filter((r) => r.is_enabled));
  if (enabled) return { id: enabled.id, enabled: true };
  const disabled = pick(rows);
  return disabled ? { id: disabled.id, enabled: false } : null;
}

/** Never used for Bill.com calls: markPending only touches Supabase. */
const NO_CLIENT: BillcomClient = {
  request: () => Promise.reject(new BillcomConnectionDisabledError('none')),
} as unknown as BillcomClient;

function deps(scope: BillcomScope, billcomConnectionId: string, billcom: BillcomClient = NO_CLIENT): PushDeps {
  return { ...scope, billcomConnectionId, billcom };
}

/** Push deps for an enabled connection, or null when Bill.com is off. */
export async function openPushDeps(scope: BillcomScope): Promise<PushDeps | null> {
  const conn = await resolveBillcomConnection(scope.supabase, scope.orgId);
  if (!conn?.enabled) return null;
  try {
    const billcom = await createBillcomClientForConnection(conn.id, scope.orgId, { supabase: scope.supabase });
    return deps(scope, conn.id, billcom);
  } catch (err) {
    if (err instanceof BillcomConnectionDisabledError) return null;
    throw err;
  }
}

/** The BC customer number of a Nexus customer row, or null. */
export async function lookupCustomerNumber(scope: BillcomScope, id: string): Promise<string | null> {
  const { data, error } = await scope.supabase
    .from('business_central_customers')
    .select('bc_customer_number')
    .eq('id', id)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return ((data as { bc_customer_number?: string | null } | null)?.bc_customer_number ?? null) || null;
}

function summarize(result: PushResult): BillcomSaveStatus['status'] {
  if (result.failed > 0 || result.needsAttention > 0) return 'failed';
  if (result.remaining > 0 || result.stoppedReason) return 'pending';
  return 'synced';
}

async function linkError(d: PushDeps, number: string): Promise<string | undefined> {
  const { data } = await d.supabase
    .from('billcom_customer_links')
    .select('last_error')
    .eq('organization_id', d.orgId)
    .eq('bc_connection_id', d.bcConnectionId)
    .eq('billcom_connection_id', d.billcomConnectionId)
    .eq('bc_customer_number', number)
    .maybeSingle();
  return (data as { last_error?: string | null } | null)?.last_error ?? undefined;
}

/**
 * Queue one customer and try to send it now (10 s budget). Never throws:
 * every problem becomes a status the save result can show.
 */
export async function pushCustomerAfterSave(scope: BillcomScope, number: string): Promise<BillcomSaveStatus> {
  try {
    const conn = await resolveBillcomConnection(scope.supabase, scope.orgId);
    if (!conn) return { status: 'off', message: OFF_MESSAGE };
    await markPending(deps(scope, conn.id), [number]);
    if (!conn.enabled) return { status: 'off', message: OFF_MESSAGE };

    let billcom: BillcomClient;
    try {
      billcom = await createBillcomClientForConnection(conn.id, scope.orgId, { supabase: scope.supabase });
    } catch (err) {
      if (err instanceof BillcomConnectionDisabledError) return { status: 'off', message: OFF_MESSAGE };
      throw err;
    }
    const d = deps(scope, conn.id, billcom);
    const result = await pushCustomers(d, { numbers: [number], budgetMs: 10_000 });
    const status = summarize(result);
    if (status === 'synced') return { status };
    if (status === 'pending') return { status, message: result.error ?? PENDING_MESSAGE };
    const reason = await linkError(d, number).catch(() => undefined);
    return { status, message: `Bill.com could not take this customer${reason ? `: ${reason}` : '.'}` };
  } catch (err) {
    console.error('[billcom] customer push after save failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', message: `Saved, but sending to Bill.com failed: ${message}` };
  }
}


/**
 * After a BC sync: queue every customer whose Bill.com payload changed since
 * its last push (or that was never pushed). No Bill.com calls. Returns the
 * number queued, or null when Bill.com is off.
 */
export async function queueChangedCustomers(scope: BillcomScope): Promise<number | null> {
  const conn = await resolveBillcomConnection(scope.supabase, scope.orgId);
  if (!conn?.enabled) return null;
  const [rows, links] = await Promise.all([
    fetchAll<BusinessCentralCustomer>(() =>
      scope.supabase
        .from('business_central_customers')
        .select('*')
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId)
        .order('id'),
    ),
    fetchAll<BillcomCustomerLink>(() =>
      scope.supabase
        .from('billcom_customer_links')
        .select('bc_customer_number, last_pushed_hash, status')
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId)
        .eq('billcom_connection_id', conn.id)
        .order('id'),
    ),
  ]);
  const linkByNo = new Map(links.map((l) => [l.bc_customer_number, l]));
  const changed: string[] = [];
  for (const row of rows) {
    const no = row.bc_customer_number;
    if (!no) continue;
    const link = linkByNo.get(no);
    if (link?.status === 'pending') continue;
    if (!link || link.last_pushed_hash !== payloadHash(toBillcomCustomer(row), shouldBeArchived(row))) {
      changed.push(no);
    }
  }
  // Deleted directly in BC: queue so the next run archives it in Bill.com.
  const known = new Set(rows.map((r) => r.bc_customer_number));
  for (const l of links) {
    if (!known.has(l.bc_customer_number) && l.status !== 'pending' && l.last_pushed_hash !== 'deleted') {
      changed.push(l.bc_customer_number);
    }
  }
  await markPending(deps(scope, conn.id), changed);
  return changed.length;
}
