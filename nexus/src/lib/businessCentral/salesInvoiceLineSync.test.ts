import { describe, expect, it, vi } from 'vitest';
import {
  INVOICE_BATCH_SIZE,
  fetchLinesForInvoicesFromBc,
  syncSalesInvoiceLines,
  type SalesInvoiceLineSyncDeps,
} from './salesInvoiceLineSync';
import type { BcSalesInvoiceLine } from './salesInvoiceLineMapper';
import type { SyncContext } from './syncRunner';

const ctx: SyncContext = {
  organizationId: 'org-1',
  connectionId: 'conn-1',
  environment: 'TEST',
  companyId: 'company-1',
  now: '2026-03-04T00:00:00Z',
};

/** A batch fetch built from a per-invoice answer (one call per batch, like BC's $expand). */
function perInvoice(fn: (invoiceId: string) => Promise<BcSalesInvoiceLine[]>) {
  return vi.fn(async (ids: string[]) => (await Promise.all(ids.map(fn))).flat());
}

function line(id: string, documentId: string): BcSalesInvoiceLine {
  return { id, documentId, sequence: 1, description: 'Widget' };
}

interface CheckpointState {
  cursor_value: string | null;
  records_synced: number;
  last_error: string | null;
  complete: boolean;
}

function makeDeps(overrides: Partial<SalesInvoiceLineSyncDeps> = {}): SalesInvoiceLineSyncDeps & {
  checkpoint: CheckpointState | null;
  upserts: Record<string, unknown>[][];
} {
  let checkpoint: CheckpointState | null = null;
  const upserts: Record<string, unknown>[][] = [];
  const clock = { ms: 0 };

  const deps: SalesInvoiceLineSyncDeps & {
    checkpoint: CheckpointState | null;
    upserts: Record<string, unknown>[][];
  } = {
    listInvoiceIdsAfter: vi.fn(async () => []),
    fetchLinesForInvoices: vi.fn(async () => []),
    upsertLines: vi.fn(async (rows: Record<string, unknown>[]) => {
      upserts.push(rows);
    }),
    readCheckpoint: vi.fn(async () => checkpoint),
    writeCheckpoint: vi.fn(async (patch: CheckpointState) => {
      checkpoint = { ...patch };
    }),
    nowMs: () => clock.ms,
    get checkpoint() {
      return checkpoint;
    },
    upserts,
    ...overrides,
  };

  return deps;
}

describe('syncSalesInvoiceLines', () => {
  it('fetches each batch of invoices in one request, 50 at a time', async () => {
    expect(INVOICE_BATCH_SIZE).toBe(50);
    const ids = Array.from({ length: 50 }, (_, i) => `inv-${String(i).padStart(2, '0')}`);
    const deps = makeDeps({
      listInvoiceIdsAfter: vi.fn().mockResolvedValueOnce(ids).mockResolvedValueOnce([]),
      fetchLinesForInvoices: vi.fn(async (batch: string[]) => batch.map((id) => line(`${id}-l1`, id))),
    });
    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);
    expect(deps.fetchLinesForInvoices).toHaveBeenCalledTimes(1);
    expect(deps.fetchLinesForInvoices).toHaveBeenCalledWith(ids);
    expect(result).toMatchObject({ complete: true, recordsSynced: 50 });
  });

  it('resumes from a stored cursor', async () => {
    const deps = makeDeps({
      readCheckpoint: vi.fn(async () => ({ cursor_value: 'inv-5', records_synced: 10 })),
    });

    await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(deps.listInvoiceIdsAfter).toHaveBeenCalledWith('inv-5', INVOICE_BATCH_SIZE);
  });

  it('completes a full pass, counting lines synced while advancing the invoice cursor', async () => {
    const invoiceIds = ['inv-1', 'inv-2'];
    const deps = makeDeps({
      listInvoiceIdsAfter: vi.fn(async () => invoiceIds),
      fetchLinesForInvoices: perInvoice(async (invoiceId: string) => [
        line(`${invoiceId}-line-1`, invoiceId),
        line(`${invoiceId}-line-2`, invoiceId),
      ]),
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.entityType).toBe('sales_invoice_line');
    expect(result.error).toBeNull();
    // A batch shorter than INVOICE_BATCH_SIZE means the pass is complete.
    expect(result.complete).toBe(true);
    // Cursor tracks the LAST INVOICE id processed, not a line id.
    expect(result.cursor).toBe('inv-2');
    // recordsSynced counts LINES (4), even though only 2 invoices were processed.
    expect(result.recordsSynced).toBe(4);
    expect(deps.upserts).toHaveLength(1);
    expect(deps.upserts[0]).toHaveLength(4);
  });

  it('treats a short batch of invoice ids as pass-complete', async () => {
    const invoiceIds = Array.from({ length: 3 }, (_, i) => `inv-${i}`);
    const deps = makeDeps({
      listInvoiceIdsAfter: vi.fn(async () => invoiceIds),
      fetchLinesForInvoices: perInvoice(async (invoiceId: string) => [line(`${invoiceId}-l1`, invoiceId)]),
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.complete).toBe(true);
    expect(deps.checkpoint?.complete).toBe(true);
  });

  it('reports completion with no upsert when zero invoices are pending', async () => {
    const deps = makeDeps({
      listInvoiceIdsAfter: vi.fn(async () => []),
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.complete).toBe(true);
    expect(result.recordsSynced).toBe(0);
    expect(deps.upsertLines).not.toHaveBeenCalled();
  });

  it('does not upsert when an invoice in the batch has no lines', async () => {
    const deps = makeDeps({
      listInvoiceIdsAfter: vi.fn(async () => ['inv-1']),
      fetchLinesForInvoices: vi.fn(async () => []),
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.complete).toBe(true);
    expect(result.recordsSynced).toBe(0);
    expect(deps.upsertLines).not.toHaveBeenCalled();
    // The invoice cursor still advances even though it produced no lines.
    expect(result.cursor).toBe('inv-1');
  });

  it('stops on the time budget mid-pass, saving progress', async () => {
    const clockMs = { value: 0 };
    let call = 0;
    const batches = [
      Array.from({ length: INVOICE_BATCH_SIZE }, (_, i) => `inv-a-${i}`),
      Array.from({ length: INVOICE_BATCH_SIZE }, (_, i) => `inv-b-${i}`),
    ];
    const deps = makeDeps({
      listInvoiceIdsAfter: vi.fn(async () => {
        const batch = batches[call] ?? [];
        call += 1;
        // Exceeds the budget after the first batch's checkpoint write, so the
        // second batch (present only to prove the loop would otherwise
        // continue) must never be fetched.
        clockMs.value += 70_000;
        return batch;
      }),
      fetchLinesForInvoices: perInvoice(async (invoiceId: string) => [line(`${invoiceId}-l1`, invoiceId)]),
      nowMs: () => clockMs.value,
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.complete).toBe(false);
    expect(result.error).toBeNull();
    // First batch (full, size INVOICE_BATCH_SIZE) completed and checkpointed
    // before the budget check stopped the loop.
    expect(result.cursor).toBe(`inv-a-${INVOICE_BATCH_SIZE - 1}`);
    expect(result.recordsSynced).toBe(INVOICE_BATCH_SIZE);
    expect(deps.checkpoint?.complete).toBe(false);
    expect(deps.checkpoint?.cursor_value).toBe(`inv-a-${INVOICE_BATCH_SIZE - 1}`);
    expect(deps.listInvoiceIdsAfter).toHaveBeenCalledTimes(1);
  });

  it('returns an error result without throwing when a fetch fails, preserving the cursor', async () => {
    const deps = makeDeps({
      readCheckpoint: vi.fn(async () => ({ cursor_value: 'inv-0', records_synced: 5 })),
      listInvoiceIdsAfter: vi.fn(async () => ['inv-1', 'inv-2']),
      fetchLinesForInvoices: perInvoice(async (invoiceId: string) => {
        if (invoiceId === 'inv-2') {
          throw new Error('BC request failed');
        }
        return [line(`${invoiceId}-l1`, invoiceId)];
      }),
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.error).toBe('BC request failed');
    expect(result.complete).toBe(false);
    // Progress never rolled back: the cursor stays at the last checkpointed value.
    expect(result.cursor).toBe('inv-0');
    expect(deps.upsertLines).not.toHaveBeenCalled();
    expect(deps.checkpoint?.last_error).toBe('BC request failed');
    expect(deps.checkpoint?.cursor_value).toBe('inv-0');
  });

  it('keeps the original error when the error-path checkpoint write also fails', async () => {
    const deps = makeDeps({
      listInvoiceIdsAfter: vi.fn(async () => {
        throw new Error('listInvoiceIdsAfter blew up');
      }),
      writeCheckpoint: vi.fn(async () => {
        throw new Error('checkpoint store offline');
      }),
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.error).toBe('listInvoiceIdsAfter blew up');
    expect(result.complete).toBe(false);
  });

  it('returns an error result without throwing when the checkpoint read fails', async () => {
    const deps = makeDeps({
      readCheckpoint: vi.fn(async () => {
        throw new Error('store offline');
      }),
    });

    const result = await syncSalesInvoiceLines(deps, ctx, 60_000);

    expect(result.error).toBe('store offline');
    expect(result.complete).toBe(false);
    expect(deps.listInvoiceIdsAfter).not.toHaveBeenCalled();
  });
});

describe('fetchLinesForInvoicesFromBc', () => {
  it('asks BC once for the invoices by id with their lines expanded, and returns the lines with their invoice id', async () => {
    const listResourcePage = vi.fn(async () => [
      { id: 'a', salesInvoiceLines: [{ id: 'a1', documentId: 'a' }, { id: 'a2' }] },
      { id: 'b', salesInvoiceLines: [] },
      { id: 'c' },
    ]);
    const lines = await fetchLinesForInvoicesFromBc({ listResourcePage } as never, ['a', 'b', 'c']);
    expect(listResourcePage).toHaveBeenCalledWith('salesInvoices', {
      filter: 'id eq a or id eq b or id eq c',
      top: 3,
      select: 'id',
      expand: 'salesInvoiceLines',
    });
    expect(lines).toEqual([
      { id: 'a1', documentId: 'a' },
      { id: 'a2', documentId: 'a' },
    ]);
  });

  it('makes no request for an empty batch', async () => {
    const listResourcePage = vi.fn();
    expect(await fetchLinesForInvoicesFromBc({ listResourcePage } as never, [])).toEqual([]);
    expect(listResourcePage).not.toHaveBeenCalled();
  });
});
