'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/currentUserAccess';
import {
  canEditBusinessCentralItems,
  canViewCustomers,
  canViewReceivables,
} from '@/lib/auth/permissions';
import { resolveActiveBcConnection } from '@/lib/businessCentral/activeConnection';
import type { AgingRow } from '@/lib/businessCentral/agingSummary';
import { buildArSyncAdapters } from '@/lib/businessCentral/arSyncAdapters';
import { createBcClientForOrg, type BcClient } from '@/lib/businessCentral/client';
import { createReferenceTransportForOrg } from '@/lib/businessCentral/customerReferences/transport';
import {
  CUSTOMER_CARD_SOURCE,
  fillCustomerCardFields,
} from '@/lib/businessCentral/customers/customerCardFill';
import { createCustomerLedgerClientForOrg } from '@/lib/businessCentral/customerLedgerClient';
import {
  runAllEntitySyncs,
  type CheckpointStore,
  type SyncEntityResult,
} from '@/lib/businessCentral/syncRunner';
import {
  syncSalesInvoiceLines,
  type SalesInvoiceLineSyncDeps,
} from '@/lib/businessCentral/salesInvoiceLineSync';
import type { BcSalesInvoiceLine } from '@/lib/businessCentral/salesInvoiceLineMapper';
import { createServiceClient } from '@/lib/supabase/server';
import {
  BusinessCentralCustomer,
  BusinessCentralCustomerLedgerEntry,
  BusinessCentralSalesInvoice,
  BusinessCentralSyncCheckpoint,
} from '@/types/database';

// Task 8's runner deliberately does NOT skip later entities when the budget is
// exhausted — each still processes one page, so worst-case wall time is this
// budget plus up to four page round-trips (one per adapter). The effective
// ceiling is therefore roughly 60s plus four page fetches, and it must stay
// below the deployment's serverless function timeout.
const SYNC_BUDGET_MS = 60_000;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

type SupabaseServiceClient = ReturnType<typeof createServiceClient>;

function checkpointStore(
  supabase: SupabaseServiceClient,
  organizationId: string
): CheckpointStore {
  return {
    async read(connectionId, entityType) {
      const { data } = await supabase
        .from('business_central_sync_checkpoints')
        .select('cursor_value, records_synced')
        .eq('bc_connection_id', connectionId)
        .eq('entity_type', entityType)
        .maybeSingle();
      return data ?? null;
    },
    async write(connectionId, entityType, patch) {
      const now = new Date().toISOString();
      const { error } = await supabase.from('business_central_sync_checkpoints').upsert(
        {
          organization_id: organizationId,
          bc_connection_id: connectionId,
          entity_type: entityType,
          phase: 'backfill',
          cursor_value: patch.cursor_value,
          records_synced: patch.records_synced,
          last_error: patch.last_error,
          completed_full_pass: patch.complete,
          // Only stamp completion time when this write actually finished a full
          // pass; an incomplete write must leave the previous completion time
          // untouched rather than clearing or refreshing it.
          ...(patch.complete ? { last_completed_at: now } : {}),
          updated_at: now,
        },
        { onConflict: 'bc_connection_id,entity_type' }
      );
      if (error) throw error;
    },
  };
}

function salesInvoiceLineSyncDeps(
  supabase: SupabaseServiceClient,
  organizationId: string,
  connectionId: string,
  bcClient: BcClient
): SalesInvoiceLineSyncDeps {
  const checkpoints = checkpointStore(supabase, organizationId);
  return {
    async listInvoiceIdsAfter(cursor, limit) {
      // organization_id AND bc_connection_id are the only protection here:
      // the service-role client bypasses row-level security.
      let query = supabase
        .from('business_central_sales_invoices')
        .select('bc_invoice_id')
        .eq('organization_id', organizationId)
        .eq('bc_connection_id', connectionId)
        .order('bc_invoice_id', { ascending: true })
        .limit(limit);
      if (cursor) {
        query = query.gt('bc_invoice_id', cursor);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((row) => row.bc_invoice_id as string);
    },
    async fetchLinesForInvoice(invoiceId) {
      // Edm.Guid literals are unquoted in OData v4 filters; no $orderby —
      // ordering within a single invoice's lines is not needed.
      return bcClient.listResourcePage<BcSalesInvoiceLine>('salesInvoiceLines', {
        filter: `documentId eq ${invoiceId}`,
        top: 500,
      });
    },
    async upsertLines(rows) {
      const { error } = await supabase
        .from('business_central_sales_invoice_lines')
        .upsert(rows, { onConflict: 'organization_id,bc_connection_id,bc_company_id,bc_line_id' });
      if (error) throw error;
    },
    readCheckpoint: () => checkpoints.read(connectionId, 'sales_invoice_line'),
    writeCheckpoint: (patch) => checkpoints.write(connectionId, 'sales_invoice_line', patch),
    nowMs: () => Date.now(),
  };
}

export async function syncBusinessCentralReceivables(): Promise<SyncEntityResult[]> {
  const { orgId, user } = await requirePermission(
    canEditBusinessCentralItems,
    'You do not have permission to sync Business Central data'
  );

  const supabase = createServiceClient();
  const connection = await resolveActiveBcConnection(orgId, user.id);
  if (!connection) throw new Error('Select a Business Central environment first');

  const now = new Date().toISOString();
  const lockUntil = new Date(Date.now() + LOCK_TIMEOUT_MS).toISOString();

  if (
    connection.sync_in_progress_since &&
    (!connection.sync_in_progress_timeout_at || connection.sync_in_progress_timeout_at > now)
  ) {
    throw new Error(
      `Sync already in progress by ${connection.sync_in_progress_by ?? 'another user'} since ${connection.sync_in_progress_since}`
    );
  }

  await supabase
    .from('business_central_connections')
    .update({
      sync_in_progress_by: user.id,
      sync_in_progress_since: now,
      sync_in_progress_timeout_at: lockUntil,
      updated_at: now,
    })
    .eq('id', connection.id);

  try {
    const bcClient = await createBcClientForOrg(orgId, connection.id);
    const ledgerClient = await createCustomerLedgerClientForOrg(orgId, connection.id);
    const adapters = buildArSyncAdapters({ bcClient, ledgerClient });

    const started = Date.now();
    const ctx = {
      organizationId: orgId,
      connectionId: connection.id,
      environment: connection.environment,
      companyId: connection.company_id,
      now,
    };

    const results = await runAllEntitySyncs(
      {
        checkpoints: checkpointStore(supabase, orgId),
        async upsert(table, rows, conflictTarget) {
          const { error } = await supabase.from(table).upsert(rows, { onConflict: conflictTarget });
          if (error) throw error;
        },
        nowMs: () => Date.now(),
      },
      adapters,
      ctx,
      SYNC_BUDGET_MS
    );

    // Fill the extra customer columns from the Customer_Card_Excel OData page.
    // Runs after customers are upserted; a failure is reported but never
    // blocks the rest of the sync.
    try {
      const transport = await createReferenceTransportForOrg(orgId, connection.id);
      const cards = await transport.list(CUSTOMER_CARD_SOURCE);
      const known = new Set<string>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('business_central_customers')
          .select('bc_customer_number')
          .eq('organization_id', orgId)
          .eq('bc_connection_id', connection.id)
          .range(from, from + 999);
        if (error) throw error;
        for (const r of data ?? []) if (r.bc_customer_number) known.add(r.bc_customer_number as string);
        if ((data ?? []).length < 1000) break;
      }
      await fillCustomerCardFields(cards, known, async (number, patch) => {
        const { error } = await supabase
          .from('business_central_customers')
          .update(patch)
          .eq('organization_id', orgId)
          .eq('bc_connection_id', connection.id)
          .eq('bc_customer_number', number);
        if (error) throw error;
      });
    } catch (cardError) {
      results.push({
        entityType: 'customer',
        recordsSynced: 0,
        complete: false,
        cursor: null,
        error: `Customer card fields: ${cardError instanceof Error ? cardError.message : 'failed'}`,
      });
    }

    // Sales invoice lines get their own dedicated sync path (see
    // salesInvoiceLineSync.ts) — BC cannot query them as a flat collection,
    // so they are NOT one of the shared-runner adapters above. Give it
    // whatever time budget remains from the overall sync budget.
    const linesRemaining = Math.max(SYNC_BUDGET_MS - (Date.now() - started), 0);
    const linesResult = await syncSalesInvoiceLines(
      salesInvoiceLineSyncDeps(supabase, orgId, connection.id, bcClient),
      ctx,
      linesRemaining
    );
    results.push(linesResult);

    const failures = results.filter((r) => r.error);
    await supabase
      .from('business_central_connections')
      .update({
        last_pulled_at: now,
        last_error: failures.length ? failures.map((f) => `${f.entityType}: ${f.error}`).join('; ') : null,
        sync_in_progress_by: null,
        sync_in_progress_since: null,
        sync_in_progress_timeout_at: null,
        updated_at: now,
      })
      .eq('id', connection.id);

    revalidatePath('/customers');
    revalidatePath('/receivables');
    revalidatePath('/receivables/invoices');
    return results;
  } catch (error) {
    await supabase
      .from('business_central_connections')
      .update({
        last_error: error instanceof Error ? error.message : 'Receivables sync failed',
        sync_in_progress_by: null,
        sync_in_progress_since: null,
        sync_in_progress_timeout_at: null,
        updated_at: now,
      })
      .eq('id', connection.id);
    throw error;
  }
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

  const { data } = await supabase
    .from('business_central_customers')
    .select('*')
    .eq('organization_id', orgId)
    .eq('bc_connection_id', connection.id)
    .order('display_name', { ascending: true });

  return {
    customers: (data ?? []) as BusinessCentralCustomer[],
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

  const [{ data: invoices }, ledgerResult] = await Promise.all([
    supabase
      .from('business_central_sales_invoices')
      .select('*')
      .eq('organization_id', orgId)
      .eq('bc_connection_id', connection.id)
      .eq('bc_customer_id', customer.bc_customer_id)
      .order('posting_date', { ascending: false, nullsFirst: false }),
    // Guard: A null or empty customer number cannot legitimately match ledger entries
    // by number, and querying for empty string ('') would incorrectly return orphaned
    // ledger rows whose customer_no was stored as empty. Return empty results instead.
    customer.bc_customer_number?.trim()
      ? supabase
          .from('business_central_customer_ledger_entries')
          .select('*')
          .eq('organization_id', orgId)
          .eq('bc_connection_id', connection.id)
          .eq('customer_no', customer.bc_customer_number)
          .order('posting_date', { ascending: false, nullsFirst: false })
      : Promise.resolve({ data: [] as BusinessCentralCustomerLedgerEntry[] }),
  ]);

  return {
    customer: customer as BusinessCentralCustomer,
    invoices: (invoices ?? []) as BusinessCentralSalesInvoice[],
    ledgerEntries: (ledgerResult.data ?? []) as BusinessCentralCustomerLedgerEntry[],
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
