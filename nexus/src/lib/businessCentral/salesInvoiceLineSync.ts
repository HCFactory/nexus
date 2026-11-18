import type { BcClient } from './client';
import { mapBcSalesInvoiceLineToDb, type BcSalesInvoiceLine } from './salesInvoiceLineMapper';
import type { SyncContext, SyncEntityResult } from './syncRunner';

/**
 * Dedicated sync path for Business Central sales invoice LINES.
 *
 * This deliberately does NOT use the shared runner (`syncRunner.ts`). Two
 * hard constraints from a live BC tenant rule that out:
 *
 * 1. `salesInvoiceLine` has no `lastModifiedDateTime` — BC rejects the field
 *    outright ("Could not find a property named 'lastModifiedDateTime' on
 *    type 'Microsoft.NAV.salesInvoiceLine'"), so there is no delta field to
 *    keyset on.
 * 2. `salesInvoiceLines` cannot be queried as a flat collection at all — BC
 *    rejects a bare fetch with "You must specify an Id or a Document Id to
 *    get the lines." Lines must always be scoped to one parent invoice via
 *    `documentId`.
 *
 * So this syncs lines by walking invoices already mirrored in our own
 * database (ascending by `bc_invoice_id`) and fetching each invoice's lines
 * individually. The cursor is an INVOICE id, not a line id — that is what
 * makes termination correct, because the shared runner's "short page means
 * done" rule breaks when the returned count (lines) doesn't match the
 * requested count (invoices).
 */

// One BC request per batch: invoices filtered by id with their lines expanded
// (production probe 2026-11-18: 50 invoices with 288 lines in ~0.6 s, versus
// ~0.13 s per invoice one at a time).
export const INVOICE_BATCH_SIZE = 50;

export interface SalesInvoiceLineSyncDeps {
  // Invoice ids already mirrored in our own database, ordered ascending,
  // strictly after `cursor`. Returns at most `limit`.
  listInvoiceIdsAfter(cursor: string | null, limit: number): Promise<string[]>;
  /** All lines of these invoices, in one BC request. */
  fetchLinesForInvoices(invoiceIds: string[]): Promise<BcSalesInvoiceLine[]>;
  upsertLines(rows: Record<string, unknown>[]): Promise<void>;
  readCheckpoint(): Promise<{ cursor_value: string | null; records_synced: number } | null>;
  writeCheckpoint(patch: {
    cursor_value: string | null;
    records_synced: number;
    last_error: string | null;
    complete: boolean;
  }): Promise<void>;
  nowMs(): number;
}

export async function syncSalesInvoiceLines(
  deps: SalesInvoiceLineSyncDeps,
  ctx: SyncContext,
  budgetMs: number
): Promise<SyncEntityResult> {
  const started = deps.nowMs();

  let checkpoint: { cursor_value: string | null; records_synced: number } | null = null;
  let cursor: string | null = null;
  let recordsSynced = 0;
  let complete = false;

  try {
    // Read inside the try: a checkpoint-store failure must surface as an
    // error result, never as a throw.
    checkpoint = await deps.readCheckpoint();
    cursor = checkpoint?.cursor_value ?? null;

    for (;;) {
      const invoiceIds = await deps.listInvoiceIdsAfter(cursor, INVOICE_BATCH_SIZE);

      if (invoiceIds.length === 0) {
        complete = true;
        await deps.writeCheckpoint({
          cursor_value: cursor,
          records_synced: (checkpoint?.records_synced ?? 0) + recordsSynced,
          last_error: null,
          complete,
        });
        break;
      }

      const lines = await deps.fetchLinesForInvoices(invoiceIds);
      const rows = lines.map(
        (line) =>
          mapBcSalesInvoiceLineToDb({
            organizationId: ctx.organizationId,
            connectionId: ctx.connectionId,
            environment: ctx.environment,
            companyId: ctx.companyId,
            line,
            now: ctx.now,
          }) as Record<string, unknown>
      );

      if (rows.length > 0) {
        await deps.upsertLines(rows);
      }

      cursor = invoiceIds[invoiceIds.length - 1];
      recordsSynced += rows.length;
      complete = invoiceIds.length < INVOICE_BATCH_SIZE;

      await deps.writeCheckpoint({
        cursor_value: cursor,
        records_synced: (checkpoint?.records_synced ?? 0) + recordsSynced,
        last_error: null,
        complete,
      });

      if (complete) {
        break;
      }

      if (deps.nowMs() - started >= budgetMs) {
        break;
      }
    }

    return {
      entityType: 'sales_invoice_line',
      recordsSynced,
      complete,
      cursor,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed';

    // Bookkeeping must never mask the real failure, and progress must never
    // be rolled back on error.
    try {
      await deps.writeCheckpoint({
        cursor_value: cursor,
        records_synced: (checkpoint?.records_synced ?? 0) + recordsSynced,
        last_error: message,
        complete: false,
      });
    } catch {
      // Intentionally swallowed: the returned error stays the original one.
    }

    return {
      entityType: 'sales_invoice_line',
      recordsSynced,
      complete: false,
      cursor,
      error: message,
    };
  }
}

/**
 * The lines of these invoices in one request: the invoices filtered by id,
 * with `salesInvoiceLines` expanded. Ids are Edm.Guid literals (unquoted).
 * Each line gets its invoice id from the parent when BC leaves it off.
 */
export async function fetchLinesForInvoicesFromBc(
  bcClient: Pick<BcClient, 'listResourcePage'>,
  invoiceIds: string[]
): Promise<BcSalesInvoiceLine[]> {
  if (invoiceIds.length === 0) return [];
  const invoices = await bcClient.listResourcePage<{ id: string; salesInvoiceLines?: BcSalesInvoiceLine[] }>(
    'salesInvoices',
    {
      filter: invoiceIds.map((id) => `id eq ${id}`).join(' or '),
      top: invoiceIds.length,
      select: 'id',
      expand: 'salesInvoiceLines',
    }
  );
  return invoices.flatMap((inv) =>
    (inv.salesInvoiceLines ?? []).map((line) => ({ ...line, documentId: line.documentId ?? inv.id }))
  );
}
