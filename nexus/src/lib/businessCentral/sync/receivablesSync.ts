import 'server-only';
import { billcomListQuery } from '@/lib/billcom/listQuery';

import { revalidatePath } from 'next/cache';

import { createBillcomClientForConnection } from '@/lib/billcom/connection';
import { queueChangedCustomers, resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks';
import { syncBillcomInvoiceStatus, type BillcomListInvoice, type NexusInvoiceRef, type StoredRef } from '@/lib/billcom/invoiceStatusSync';
import { buildArSyncAdapters } from '@/lib/businessCentral/arSyncAdapters';
import { createBcClientForOrg, type BcClient } from '@/lib/businessCentral/client';
import { createCustomerLedgerClientForOrg } from '@/lib/businessCentral/customerLedgerClient';
import { createReferenceTransportForOrg } from '@/lib/businessCentral/customerReferences/transport';
import {
  CARD_SELECT_FIELDS,
  CUSTOMER_CARD_SOURCE,
  fillCustomerCardFieldsInChunks,
} from '@/lib/businessCentral/customers/customerCardFill';
import { pullSalesPriceLists } from '@/lib/businessCentral/priceLists/priceListSync';
import {
  fetchLinesForInvoicesFromBc,
  syncSalesInvoiceLines,
  type SalesInvoiceLineSyncDeps,
} from '@/lib/businessCentral/salesInvoiceLineSync';
import { pullShipTos } from '@/lib/businessCentral/shipTo/shipToService';
import {
  runAllEntitySyncs,
  type CheckpointStore,
  type SyncEntityResult,
} from '@/lib/businessCentral/syncRunner';
import type { createServiceClient } from '@/lib/supabase/server';
import type { BusinessCentralConnection } from '@/types/database';

import { acquireSyncLock, releaseSyncLock } from './syncLock';
import { SyncInProgressError } from './syncRuns';

/** light: customers, card fields, ship-tos (every 15 min). full: everything (every 2 h). */
export type ReceivablesSyncKind = 'light' | 'full';

export { SyncInProgressError };

// Task 8's runner deliberately does NOT skip later entities when the budget is
// exhausted — each still processes one page, so worst-case wall time is this
// budget plus up to four page round-trips (one per adapter). The effective
// ceiling is therefore roughly 60s plus four page fetches, and it must stay
// below the deployment's serverless function timeout.
const SYNC_BUDGET_MS = 60_000;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
// The card fill starts new batches for up to this long (each batch is one
// short BC request), then stops and continues on the next sync.
const CARD_BUDGET_MS = 30_000;
// Invoice lines get their own window too: the AR budget above is usually spent,
// which left lines one batch per sync. Worst case for the whole sync stays well
// under the function timeout (~60s AR + ~30s cards + ~40s lines + page fetches).
const LINES_BUDGET_MS = 40_000;
// The Bill.com payment status step gets its own window too; it continues next sync.
const BILLCOM_STATUS_BUDGET_MS = 30_000;
const BILLCOM_STATUS_CHECKPOINT = 'billcom_invoice_status';
// Supabase returns at most this many rows per request.
const ROW_CAP = 1000;
// Sync checkpoint row that remembers where the card fill stopped.
const CARD_CHECKPOINT = 'customer_card';

type SupabaseServiceClient = ReturnType<typeof createServiceClient>;

export function checkpointStore(
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
    fetchLinesForInvoices: (invoiceIds) => fetchLinesForInvoicesFromBc(bcClient, invoiceIds),
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


/**
 * One round of the Business Central receivables sync for one environment.
 * Takes the environment's sync lock (refuses with SyncInProgressError when
 * held). `lockedBy` is the user who started it, or null for an automatic sync.
 */
export async function runReceivablesSync(o: {
  supabase: SupabaseServiceClient;
  orgId: string;
  connection: BusinessCentralConnection;
  kind: ReceivablesSyncKind;
  lockedBy: string | null;
}): Promise<SyncEntityResult[]> {
  const { supabase, orgId, connection, kind, lockedBy } = o;
  const now = new Date().toISOString();
  const lockUntil = new Date(Date.now() + LOCK_TIMEOUT_MS).toISOString();

  if (!(await acquireSyncLock(supabase, connection.id, lockedBy, now, lockUntil))) {
    throw new SyncInProgressError('A sync is already running for this environment. Try again in a few minutes.');
  }

  try {
    const bcClient = await createBcClientForOrg(orgId, connection.id);
    const ledgerClient = await createCustomerLedgerClientForOrg(orgId, connection.id);
    // Light: customers only (plus card fields, ship-tos and the Bill.com queue below).
    const adapters = buildArSyncAdapters({ bcClient, ledgerClient }).filter(
      (a) => kind === 'full' || a.entityType === 'customer'
    );

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

    // Fill the extra customer columns from the Customer_Card_Excel OData page,
    // in batches of customers sorted by number, continuing from where the last
    // sync stopped. Gets its own time window (the AR budget above is usually
    // spent). A failure is reported but never blocks the rest of the sync.
    try {
      const checkpoints = checkpointStore(supabase, orgId);
      const saved = await checkpoints.read(connection.id, CARD_CHECKPOINT);
      const transport = await createReferenceTransportForOrg(orgId, connection.id);
      const known = new Map<string, string | null>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('business_central_customers')
          .select('bc_customer_number, bc_card_etag')
          .eq('organization_id', orgId)
          .eq('bc_connection_id', connection.id)
          .order('bc_customer_number', { ascending: true })
          .range(from, from + 999);
        if (error) throw error;
        for (const r of data ?? []) {
          if (r.bc_customer_number) known.set(r.bc_customer_number as string, (r.bc_card_etag as string | null) ?? null);
        }
        if ((data ?? []).length < 1000) break;
      }
      const cardStarted = Date.now();
      const card = await fillCustomerCardFieldsInChunks({
        startAfter: saved?.cursor_value ?? null,
        hasTime: () => Date.now() - cardStarted < CARD_BUDGET_MS,
        known,
        fetchChunk: (after, size) =>
          transport.list(CUSTOMER_CARD_SOURCE, {
            select: CARD_SELECT_FIELDS,
            orderby: 'No',
            top: size,
            ...(after !== null ? { filter: `No gt '${after.replace(/'/g, "''")}'` } : {}),
          }),
        update: async (number, patch) => {
          const { error } = await supabase
            .from('business_central_customers')
            .update(patch)
            .eq('organization_id', orgId)
            .eq('bc_connection_id', connection.id)
            .eq('bc_customer_number', number);
          if (error) throw error;
        },
      });
      await checkpoints.write(connection.id, CARD_CHECKPOINT, {
        cursor_value: card.cursor,
        records_synced: card.complete ? 0 : Number(saved?.records_synced ?? 0) + card.filled,
        last_error: card.error ?? null,
        complete: card.complete,
      });
      if (!card.complete) {
        results.push({
          entityType: 'customer',
          recordsSynced: card.filled,
          complete: false,
          cursor: card.cursor,
          error: card.error ? `Customer card fields: ${card.error}` : null,
        });
      }
    } catch (cardError) {
      results.push({
        entityType: 'customer',
        recordsSynced: 0,
        complete: false,
        cursor: null,
        error: `Customer card fields: ${cardError instanceof Error ? cardError.message : 'failed'}`,
      });
    }

    // Pull ship-to addresses (page 300) for every customer. Same contract as
    // the card fill: a failure is reported, never blocks the rest of the sync.
    try {
      const shipToTransport = await createReferenceTransportForOrg(orgId, connection.id);
      await pullShipTos({
        supabase,
        transport: shipToTransport,
        orgId,
        connectionId: connection.id,
        now: () => new Date().toISOString(),
      });
    } catch (shipToError) {
      results.push({
        entityType: 'customer',
        recordsSynced: 0,
        complete: false,
        cursor: null,
        error: `Ship-to addresses: ${shipToError instanceof Error ? shipToError.message : 'failed'}`,
      });
    }

    if (kind === 'full') {
      // Copy BC sales price lists (read-only). Same contract: report, never block.
      try {
        const priceListTransport = await createReferenceTransportForOrg(orgId, connection.id);
        await pullSalesPriceLists({
          supabase,
          transport: priceListTransport,
          orgId,
          connectionId: connection.id,
          now: () => new Date().toISOString(),
        });
      } catch (priceListError) {
        results.push({
          entityType: 'customer',
          recordsSynced: 0,
          complete: false,
          cursor: null,
          error: `Sales price lists: ${priceListError instanceof Error ? priceListError.message : 'failed'}`,
        });
      }
    }

    // Queue customers whose Bill.com payload changed. No Bill.com calls here;
    // skipped when Bill.com is off; a failure is logged, never fails the sync.
    try {
      await queueChangedCustomers({ supabase, orgId, bcConnectionId: connection.id });
    } catch (billcomError) {
      console.error('[billcom] could not queue changed customers after sync:', billcomError);
    }

    if (kind === 'full') {
      // Sales invoice lines get their own dedicated sync path (see
      // salesInvoiceLineSync.ts) — BC cannot query them as a flat collection,
      // so they are NOT one of the shared-runner adapters above. Give it
      // whatever time budget remains from the overall sync budget.
      const linesResult = await syncSalesInvoiceLines(
        salesInvoiceLineSyncDeps(supabase, orgId, connection.id, bcClient),
        ctx,
        LINES_BUDGET_MS
      );
      results.push(linesResult);

      // Bill.com payment status for each invoice (only with a Bill.com connection picked).
      const billcomStep = await runBillcomStatusStep(supabase, orgId, connection.id);
      if (billcomStep) results.push(billcomStep);
    }

    const failures = results.filter((r) => r.error);
    await releaseSyncLock(supabase, connection.id, now, {
      // Only the full sync pulls invoices and ledger entries.
      ...(kind === 'full' ? { last_pulled_at: now } : {}),
      last_error: failures.length ? failures.map((f) => `${f.entityType}: ${f.error}`).join('; ') : null,
    });

    // 'layout' also refreshes customer profiles and invoice pages under these.
    revalidatePath('/customers', 'layout');
    revalidatePath('/receivables', 'layout');
    return results;
  } catch (error) {
    await releaseSyncLock(supabase, connection.id, now, {
      last_error: error instanceof Error ? error.message : 'Receivables sync failed',
    });
    throw error;
  }
}

/**
 * Bill.com payment status: reads Bill.com invoices changed since the last run,
 * matches them to this environment's invoices and stores the status. Null when
 * the environment has no enabled Bill.com connection. Never throws.
 */
async function runBillcomStatusStep(supabase: SupabaseServiceClient, orgId: string, bcConnectionId: string): Promise<SyncEntityResult | null> {
  try {
    const conn = await resolveBillcomConnection(supabase, orgId, bcConnectionId);
    if (!conn?.enabled) return null;
    const client = await createBillcomClientForConnection(conn.id, orgId, { supabase });
    const checkpoints = checkpointStore(supabase, orgId);
    const columns = 'bc_invoice_id, external_document_number, bc_invoice_number, customer_name, total_amount_including_tax';
    return await syncBillcomInvoiceStatus(
      {
        async listChanged(since, page) {
          // A time must be quoted: its colons would otherwise break Bill.com's field:op:value filter.
          const qs = billcomListQuery({ max: '100', sort: 'updatedTime:asc', filters: since ? `updatedTime:gte:"${since}"` : undefined }, page);
          return client.request<{ results: BillcomListInvoice[]; nextPage?: string }>(`/v3/invoices?${qs}`);
        },
        async findNexusInvoices(numbers) {
          const read = async (column: 'external_document_number' | 'bc_invoice_number') => {
            const { data, error } = await supabase
              .from('business_central_sales_invoices')
              .select(columns)
              .eq('organization_id', orgId)
              .eq('bc_connection_id', bcConnectionId)
              .in(column, numbers)
              .limit(ROW_CAP);
            if (error) throw new Error(`Could not read invoices: ${error.message}`);
            return (data ?? []) as NexusInvoiceRef[];
          };
          const [byExt, byNo] = await Promise.all([read('external_document_number'), read('bc_invoice_number')]);
          const seen = new Map<string, NexusInvoiceRef>();
          for (const r of [...byExt, ...byNo]) seen.set(r.bc_invoice_id, r);
          // A very common number (e.g. "VERBAL") can hit the row cap: then the list may be incomplete.
          return { invoices: [...seen.values()], truncated: byExt.length >= ROW_CAP || byNo.length >= ROW_CAP };
        },
        async readStored(bcInvoiceIds) {
          const { data, error } = await supabase
            .from('billcom_invoice_status')
            .select('bc_invoice_id, match, billcom_invoice_id')
            .eq('organization_id', orgId)
            .eq('bc_connection_id', bcConnectionId)
            .in('bc_invoice_id', bcInvoiceIds);
          if (error) throw new Error(`Could not read stored Bill.com status: ${error.message}`);
          return (data ?? []) as StoredRef[];
        },
        async removeByBillcomIds(ids) {
          const { error } = await supabase
            .from('billcom_invoice_status')
            .delete()
            .eq('organization_id', orgId)
            .eq('bc_connection_id', bcConnectionId)
            .in('billcom_invoice_id', ids);
          if (error) throw new Error(`Could not clear archived Bill.com status: ${error.message}`);
        },
        async upsert(rows) {
          const now = new Date().toISOString();
          const { error } = await supabase.from('billcom_invoice_status').upsert(
            rows.map((r) => ({ ...r, organization_id: orgId, bc_connection_id: bcConnectionId, billcom_connection_id: conn.id, checked_at: now })),
            { onConflict: 'bc_connection_id,bc_invoice_id' },
          );
          if (error) throw new Error(`Could not save Bill.com status: ${error.message}`);
        },
        readCheckpoint: () => checkpoints.read(bcConnectionId, BILLCOM_STATUS_CHECKPOINT),
        writeCheckpoint: (patch) => checkpoints.write(bcConnectionId, BILLCOM_STATUS_CHECKPOINT, patch),
        nowMs: () => Date.now(),
      },
      BILLCOM_STATUS_BUDGET_MS,
    );
  } catch (e) {
    return {
      entityType: 'billcom_invoice_status',
      recordsSynced: 0,
      complete: false,
      cursor: null,
      error: `Bill.com payment status: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
