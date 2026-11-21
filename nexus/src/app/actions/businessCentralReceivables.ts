'use server';

import { fetchAll } from '@/lib/supabase/fetchAll';
import { requirePermission } from '@/lib/auth/currentUserAccess';
import {
  canEditBusinessCentralItems,
  canViewCustomers,
  canViewReceivables,
} from '@/lib/auth/permissions';
import { resolveActiveBcConnection } from '@/lib/businessCentral/activeConnection';
import type { AgingRow } from '@/lib/businessCentral/agingSummary';
import { CUSTOMER_FIELDS } from '@/lib/businessCentral/customers/customerFields';
import type { SyncEntityResult } from '@/lib/businessCentral/syncRunner';
import { createServiceClient } from '@/lib/supabase/server';
import { resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks';
import { runReceivablesSync, type ReceivablesSyncKind } from '@/lib/businessCentral/sync/receivablesSync';
import { recordSyncRun } from '@/lib/businessCentral/sync/syncRuns';
import {
  BusinessCentralCustomer,
  BusinessCentralCustomerLedgerEntry,
  BusinessCentralSalesInvoice,
  BusinessCentralSyncCheckpoint,
} from '@/types/database';

/** Admin → Sync → Customers & Receivables: one round of the full sync for the active environment. */
export async function syncBusinessCentralReceivables(): Promise<SyncEntityResult[]> {
  const { orgId, user } = await requirePermission(
    canEditBusinessCentralItems,
    'You do not have permission to sync Business Central data'
  );
  return runManualSync(orgId, user.id, 'full');
}

/** Customers page → Sync now: one round of the light sync (customers, card fields, ship-tos). */
export async function syncCustomersLight(): Promise<SyncEntityResult[]> {
  const { orgId, user } = await requirePermission(canViewCustomers, 'You do not have permission to view customers');
  return runManualSync(orgId, user.id, 'light');
}

// Anyone who can view customers may run the quick sync: once one finishes,
// the next can start only after this long (follow-up rounds of an unfinished
// sync are not held back).
const LIGHT_COOLDOWN_MS = 60_000;

async function runManualSync(orgId: string, userId: string, kind: ReceivablesSyncKind): Promise<SyncEntityResult[]> {
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, userId);
  if (!connection) throw new Error('Select a Business Central environment first');
  if (kind === 'light') {
    // Missing table (migration 072 not applied) reads as no recent run.
    const { data } = await supabase
      .from('bc_sync_runs')
      .select('started_at, complete')
      .eq('bc_connection_id', connection.id)
      .eq('kind', 'light')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const last = data as { started_at: string; complete: boolean | null } | null;
    if (last?.complete === true && Date.now() - new Date(last.started_at).getTime() < LIGHT_COOLDOWN_MS) {
      throw new Error('Customers were just synced. Try again in a minute.');
    }
  }
  return recordSyncRun(supabase, { orgId, connectionId: connection.id, kind, trigger: 'manual', triggeredBy: userId }, () =>
    runReceivablesSync({ supabase, orgId, connection, kind, lockedBy: userId })
  );
}

export async function getReceivablesSyncStatus(): Promise<BusinessCentralSyncCheckpoint[]> {
  const { orgId, user } = await requirePermission(
    canViewReceivables,
    'You do not have permission to view receivables'
  );
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) return [];

  const { data } = await supabase
    .from('business_central_sync_checkpoints')
    .select('*')
    .eq('bc_connection_id', connection.id);

  return (data ?? []) as BusinessCentralSyncCheckpoint[];
}

const CUSTOMER_PAGE_SIZE = 1000;
// What the customers list and its edit form read; never bc_raw_payload.
const CUSTOMER_LIST_COLUMNS = [
  ...new Set(['id', 'bc_customer_number', 'display_name', 'email', 'city', 'currency_code', 'balance', ...CUSTOMER_FIELDS.map((f) => f.name)]),
].join(',');

export async function getCustomersPageData(): Promise<{
  customers: BusinessCentralCustomer[];
  canSync: boolean;
}> {
  const { orgId, user, access } = await requirePermission(
    canViewCustomers,
    'You do not have permission to view customers'
  );
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) return { customers: [], canSync: false };

  // Supabase caps a single response at 1,000 rows: read the first page with
  // the total, then the remaining pages at the same time. Only the columns the
  // list and edit form use (never the raw BC record, the bulk of each row).
  const page = (from: number, count = false) =>
    supabase
      .from('business_central_customers')
      .select(CUSTOMER_LIST_COLUMNS, count ? { count: 'exact' } : undefined)
      .eq('organization_id', orgId)
      .eq('bc_connection_id', connection.id)
      .order('display_name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + CUSTOMER_PAGE_SIZE - 1);
  const first = await page(0, true);
  const total = first.count ?? 0;
  const rest = await Promise.all(
    Array.from({ length: Math.max(Math.ceil(total / CUSTOMER_PAGE_SIZE) - 1, 0) }, (_, i) => page((i + 1) * CUSTOMER_PAGE_SIZE)),
  );
  const customers = [first, ...rest].flatMap((r) => (r.data ?? []) as unknown as BusinessCentralCustomer[]);

  return {
    customers,
    // Anyone who can view customers can run the light customer sync.
    canSync: canViewCustomers(access),
  };
}

export async function getCustomerDetail(id: string): Promise<{
  customer: BusinessCentralCustomer;
  invoices: BusinessCentralSalesInvoice[];
  ledgerEntries: BusinessCentralCustomerLedgerEntry[];
} | null> {
  const { orgId, user } = await requirePermission(
    canViewCustomers,
    'You do not have permission to view customers'
  );
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) return null;

  const { data: customer } = await supabase
    .from('business_central_customers')
    .select('*')
    .eq('organization_id', orgId)
    .eq('bc_connection_id', connection.id)
    .eq('id', id)
    .maybeSingle();

  if (!customer) return null;

  // Paged: a customer can have more than the 1,000 rows one query returns.
  // `id` breaks ties so pages never repeat or skip rows.
  const [invoices, ledgerEntries] = await Promise.all([
    fetchAll<BusinessCentralSalesInvoice>(
      () =>
        supabase
          .from('business_central_sales_invoices')
          .select('*')
          .eq('organization_id', orgId)
          .eq('bc_connection_id', connection.id)
          .eq('bc_customer_id', customer.bc_customer_id)
          .order('posting_date', { ascending: false, nullsFirst: false })
          .order('id'),
      1000,
      'invoices',
    ),
    // Guard: A null or empty customer number cannot legitimately match ledger entries
    // by number, and querying for empty string ('') would incorrectly return orphaned
    // ledger rows whose customer_no was stored as empty. Return empty results instead.
    customer.bc_customer_number?.trim()
      ? fetchAll<BusinessCentralCustomerLedgerEntry>(
          () =>
            supabase
              .from('business_central_customer_ledger_entries')
              .select('*')
              .eq('organization_id', orgId)
              .eq('bc_connection_id', connection.id)
              .eq('customer_no', customer.bc_customer_number)
              .order('posting_date', { ascending: false, nullsFirst: false })
              .order('id'),
          1000,
          'ledger entries',
        )
      : Promise.resolve([] as BusinessCentralCustomerLedgerEntry[]),
  ]);

  return {
    customer: customer as BusinessCentralCustomer,
    invoices,
    ledgerEntries,
  };
}

export async function getAgingPageData(): Promise<{ rows: AgingRow[]; asOfDate: string | null }> {
  const { orgId, user } = await requirePermission(
    canViewReceivables,
    'You do not have permission to view receivables'
  );
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) return { rows: [], asOfDate: null };

  const { data } = await supabase
    .from('business_central_ar_aging')
    .select('*')
    .eq('organization_id', orgId)
    .eq('bc_connection_id', connection.id)
    .order('days_overdue', { ascending: false });

  const rows = (data ?? []) as AgingRow[];
  return { rows, asOfDate: rows[0]?.as_of_date ?? null };
}

export async function getSalesInvoicesPageData(): Promise<{
  invoices: BusinessCentralSalesInvoice[];
  /** Stored Bill.com status by BC invoice id; null when this environment has no Bill.com. */
  billcomStatus: Record<string, { match: 'found' | 'mismatch'; status: string | null; dueAmount: number | null; dueDate: string | null }> | null;
}> {
  const { orgId, user } = await requirePermission(
    canViewReceivables,
    'You do not have permission to view receivables'
  );
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) return { invoices: [], billcomStatus: null };

  const { data } = await supabase
    .from('business_central_sales_invoices')
    .select('*')
    .eq('organization_id', orgId)
    .eq('bc_connection_id', connection.id)
    // nullsFirst: false ensures NULLs sort last on DESC, preventing null posting_dates
    // from consuming result slots and pushing recent invoices out of the top 500.
    .order('posting_date', { ascending: false, nullsFirst: false })
    .limit(500);

  const invoices = (data ?? []) as BusinessCentralSalesInvoice[];
  return { invoices, billcomStatus: await readStoredBillcomStatus(supabase, orgId, connection.id, invoices) };
}

/** Bill.com statuses stored for these invoices (in chunks: ids go in the URL). Never throws. */
async function readStoredBillcomStatus(
  supabase: ReturnType<typeof createServiceClient>,
  orgId: string,
  bcConnectionId: string,
  invoices: BusinessCentralSalesInvoice[],
) {
  try {
    const conn = await resolveBillcomConnection(supabase, orgId, bcConnectionId);
    if (!conn?.enabled) return null;
    const ids = invoices.map((i) => i.bc_invoice_id);
    const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, i * 100 + 100));
    const rows = (
      await Promise.all(
        chunks.map(async (chunk) => {
          const { data, error } = await supabase
            .from('billcom_invoice_status')
            .select('bc_invoice_id, match, status, due_amount, due_date')
            .eq('organization_id', orgId)
            .eq('bc_connection_id', bcConnectionId)
            .in('bc_invoice_id', chunk);
          if (error) throw new Error(error.message);
          return (data ?? []) as { bc_invoice_id: string; match: 'found' | 'mismatch'; status: string | null; due_amount: number | null; due_date: string | null }[];
        }),
      )
    ).flat();
    return Object.fromEntries(
      rows.map((r) => [r.bc_invoice_id, { match: r.match, status: r.status, dueAmount: r.due_amount === null ? null : Number(r.due_amount), dueDate: r.due_date }]),
    );
  } catch (e) {
    console.error('[invoices] could not read stored Bill.com status:', e instanceof Error ? e.message : e);
    return null;
  }
}

// No type re-exports here. A 'use server' module may only export async
// functions, and Turbopack's dev transform sweeps even `export type` into the
// server-actions manifest, producing a build error. Consumers import
// SyncEntityResult from @/lib/businessCentral/syncRunner and SyncEntityType
// from @/types/database directly.
