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

async function runManualSync(orgId: string, userId: string, kind: ReceivablesSyncKind): Promise<SyncEntityResult[]> {
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, userId);
  if (!connection) throw new Error('Select a Business Central environment first');
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
    canSync: canEditBusinessCentralItems(access),
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
}> {
  const { orgId, user } = await requirePermission(
    canViewReceivables,
    'You do not have permission to view receivables'
  );
  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) return { invoices: [] };

  const { data } = await supabase
    .from('business_central_sales_invoices')
    .select('*')
    .eq('organization_id', orgId)
    .eq('bc_connection_id', connection.id)
    // nullsFirst: false ensures NULLs sort last on DESC, preventing null posting_dates
    // from consuming result slots and pushing recent invoices out of the top 500.
    .order('posting_date', { ascending: false, nullsFirst: false })
    .limit(500);

  return { invoices: (data ?? []) as BusinessCentralSalesInvoice[] };
}

// No type re-exports here. A 'use server' module may only export async
// functions, and Turbopack's dev transform sweeps even `export type` into the
// server-actions manifest, producing a build error. Consumers import
// SyncEntityResult from @/lib/businessCentral/syncRunner and SyncEntityType
// from @/types/database directly.
