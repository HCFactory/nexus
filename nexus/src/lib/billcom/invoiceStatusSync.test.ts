import { describe, expect, it, vi } from 'vitest';

import { BillcomRateLimitError } from './errors';
import { guardMismatches, matchBillcomInvoices, syncBillcomInvoiceStatus, type BillcomListInvoice, type NexusInvoiceRef } from './invoiceStatusSync';

const bill = (over: Partial<BillcomListInvoice> = {}): BillcomListInvoice => ({
  id: '00e1', invoiceNumber: 'W-1', customerName: 'Aloha School', totalAmount: 100, dueAmount: 0, dueDate: '2026-11-01',
  status: 'PAID_IN_FULL', updatedTime: '2026-11-20T10:00:00.000+00:00', archived: false, ...over,
});
const nexus = (over: Partial<NexusInvoiceRef> = {}): NexusInvoiceRef => ({
  bc_invoice_id: 'inv-1', external_document_number: 'W-1', bc_invoice_number: 'INV-1', customer_name: 'ALOHA SCHOOL.', total_amount_including_tax: 100, ...over,
});

describe('matchBillcomInvoices', () => {
  it('matches by External Doc. No. with the same total and customer name, and stores Bill.com status', () => {
    expect(matchBillcomInvoices([bill()], [nexus()])).toEqual([
      { bc_invoice_id: 'inv-1', match: 'found', billcom_invoice_id: '00e1', status: 'PAID_IN_FULL', total_amount: 100, due_amount: 0, due_date: '2026-11-01', billcom_updated_time: '2026-11-20T10:00:00.000+00:00' },
    ]);
  });

  it('falls back to the BC invoice number', () => {
    const rows = matchBillcomInvoices([bill({ invoiceNumber: 'INV-1' })], [nexus({ external_document_number: 'W-9' })]);
    expect(rows[0]).toMatchObject({ bc_invoice_id: 'inv-1', match: 'found' });
  });

  it('a single candidate whose total or customer differs is stored as mismatch (no stale Paid)', () => {
    expect(matchBillcomInvoices([bill({ totalAmount: 99.99 })], [nexus()])).toEqual([{ bc_invoice_id: 'inv-1', match: 'mismatch', billcom_invoice_id: '00e1', status: null, total_amount: null, due_amount: null, due_date: null, billcom_updated_time: '2026-11-20T10:00:00.000+00:00' }]);
    expect(matchBillcomInvoices([bill({ customerName: 'Someone Else' })], [nexus()])[0].match).toBe('mismatch');
  });

  it('partly invoiced order: several BC invoices share the number, each matched by its own total', () => {
    const rows = matchBillcomInvoices(
      [bill({ id: 'b-a', totalAmount: 60 }), bill({ id: 'b-b', totalAmount: 40 })],
      [nexus({ bc_invoice_id: 'inv-a', total_amount_including_tax: 60 }), nexus({ bc_invoice_id: 'inv-b', total_amount_including_tax: 40 })],
    );
    expect(rows.map((r) => [r.bc_invoice_id, r.billcom_invoice_id, r.match])).toEqual([['inv-a', 'b-a', 'found'], ['inv-b', 'b-b', 'found']]);
  });

  it('still refuses when that is unclear (two invoices with the same number and total)', () => {
    const rows = matchBillcomInvoices(
      [bill({ id: 'b-a', totalAmount: 50 }), bill({ id: 'b-b', totalAmount: 50 })],
      [nexus({ bc_invoice_id: 'inv-a', total_amount_including_tax: 50 }), nexus({ bc_invoice_id: 'inv-b', total_amount_including_tax: 50 })],
    );
    expect(rows).toEqual([]);
  });

  it('skips archived Bill.com invoices, and numbers Nexus does not have', () => {
    expect(matchBillcomInvoices([bill({ archived: true }), bill({ id: 'x', invoiceNumber: 'W-404' })], [nexus()])).toEqual([]);
  });
});

/** Well after the test invoices' times, so the one-day look-back doesn't apply. */
const LATER = Date.parse('2027-01-01T00:00:00.000Z');

describe('syncBillcomInvoiceStatus', () => {
  function deps(pages: { results: BillcomListInvoice[]; nextPage?: string }[], opts: { cursor?: string | null; throwAt?: number; clock?: () => number } = {}) {
    let call = 0;
    const listChanged = vi.fn(async () => {
      if (opts.throwAt === call) {
        call++;
        throw new BillcomRateLimitError({ status: 429, statusText: 'x', message: 'BDC_1144', url: 'u', code: 'BDC_1144' } as never);
      }
      return pages[call++] ?? { results: [] };
    });
    const checkpoint: { cursor_value: string | null; complete: boolean }[] = [];
    return {
      listChanged,
      findNexusInvoices: vi.fn(async (numbers: string[]) => ({ invoices: [nexus()].filter((n) => numbers.includes(n.external_document_number ?? '')), truncated: false })),
      readStored: vi.fn(async () => [] as { bc_invoice_id: string; match: 'found' | 'mismatch'; billcom_invoice_id: string | null }[]),
      upsert: vi.fn(async () => {}),
      removeByBillcomIds: vi.fn(async () => {}),
      readCheckpoint: vi.fn(async () => (opts.cursor === undefined ? null : { cursor_value: opts.cursor, records_synced: 0 })),
      writeCheckpoint: vi.fn(async (p: { cursor_value: string | null; complete: boolean }) => { checkpoint.push(p); }),
      nowMs: opts.clock ?? (() => LATER),
      checkpoint,
    };
  }

  it('reads changed invoices from the saved time (quoted), page by page, and remembers the last updatedTime', async () => {
    const d = deps([{ results: [bill()], nextPage: 'p2' }, { results: [bill({ id: '00e2', invoiceNumber: 'W-2', updatedTime: '2026-11-20T11:00:00.000+00:00' })] }], { cursor: '2026-11-19T00:00:00.000+00:00' });
    const r = await syncBillcomInvoiceStatus(d, 30_000);
    expect(d.listChanged.mock.calls).toEqual([['2026-11-19T00:00:00.000+00:00', undefined], ['2026-11-19T00:00:00.000+00:00', 'p2']]);
    expect(d.upsert).toHaveBeenCalledTimes(1);
    expect(d.checkpoint.at(-1)).toMatchObject({ cursor_value: '2026-11-20T11:00:00.000+00:00', complete: true });
    expect(r).toMatchObject({ entityType: 'billcom_invoice_status', recordsSynced: 1, complete: true, error: null });
  });

  it('first run starts from the beginning', async () => {
    const d = deps([{ results: [] }]);
    await syncBillcomInvoiceStatus(d, 30_000);
    expect(d.listChanged.mock.calls[0]).toEqual([null, undefined]);
  });

  it('out of time: stops between pages, keeps the cursor, incomplete', async () => {
    let t = LATER;
    const d = deps([{ results: [bill()], nextPage: 'p2' }, { results: [] }], { clock: () => (t += 20_000) });
    const r = await syncBillcomInvoiceStatus(d, 30_000);
    expect(d.listChanged).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ complete: false, error: null, cursor: '2026-11-20T10:00:00.000+00:00' });
  });

  it('Bill.com rate limit: stops quietly with progress kept (the next sync continues), not an error', async () => {
    const d = deps([{ results: [bill()], nextPage: 'p2' }], { throwAt: 1 });
    const r = await syncBillcomInvoiceStatus(d, 30_000);
    expect(r).toMatchObject({ complete: false, error: null, cursor: '2026-11-20T10:00:00.000+00:00' });
  });

  it('any other failure is reported with the cursor kept', async () => {
    const d = deps([]);
    d.listChanged.mockRejectedValueOnce(new Error('Bill.com down'));
    const r = await syncBillcomInvoiceStatus(d, 30_000);
    expect(r).toMatchObject({ complete: false, error: 'Bill.com down' });
  });
});

describe('guardMismatches', () => {
  const mm = { bc_invoice_id: 'inv-1', match: 'mismatch' as const, billcom_invoice_id: 'b-other', status: null, total_amount: null, due_amount: null, due_date: null, billcom_updated_time: null };
  it('a mismatch never replaces a found match that came from a different Bill.com invoice', () => {
    expect(guardMismatches([mm], [{ bc_invoice_id: 'inv-1', match: 'found', billcom_invoice_id: 'b-right' }])).toEqual([]);
  });
  it('it may replace the same Bill.com invoice’s earlier match (it changed), or fill an empty slot', () => {
    expect(guardMismatches([mm], [{ bc_invoice_id: 'inv-1', match: 'found', billcom_invoice_id: 'b-other' }])).toEqual([mm]);
    expect(guardMismatches([mm], [])).toEqual([mm]);
  });
  it('found rows always go through', () => {
    const found = { ...mm, match: 'found' as const };
    expect(guardMismatches([found], [{ bc_invoice_id: 'inv-1', match: 'found', billcom_invoice_id: 'b-right' }])).toEqual([found]);
  });
});

describe('syncBillcomInvoiceStatus safeguards', () => {
  const NOW = Date.parse('2026-11-21T12:00:00.000Z');
  function d(over: Record<string, unknown> = {}) {
    const base = {
      listChanged: vi.fn(async () => ({ results: [bill({ totalAmount: 1 })] })),
      findNexusInvoices: vi.fn(async () => ({ invoices: [nexus()], truncated: false })),
      readStored: vi.fn(async () => [{ bc_invoice_id: 'inv-1', match: 'found' as const, billcom_invoice_id: 'b-right' }]),
      upsert: vi.fn(async () => {}),
      removeByBillcomIds: vi.fn(async () => {}),
      readCheckpoint: vi.fn(async () => null),
      writeCheckpoint: vi.fn(async () => {}),
      nowMs: () => NOW,
    };
    return { ...base, ...over } as typeof base;
  }

  it('does not let another Bill.com invoice with the same number turn a found match into a mismatch', async () => {
    const deps = d();
    await syncBillcomInvoiceStatus(deps, 30_000);
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it('a cut-off Nexus lookup (row cap) never writes mismatches', async () => {
    const deps = d({ readStored: vi.fn(async () => []), findNexusInvoices: vi.fn(async () => ({ invoices: [nexus()], truncated: true })) });
    await syncBillcomInvoiceStatus(deps, 30_000);
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it('archived Bill.com invoices remove the status they had stored', async () => {
    const deps = d({ listChanged: vi.fn(async () => ({ results: [bill({ id: 'b-arch', archived: true })] })) });
    await syncBillcomInvoiceStatus(deps, 30_000);
    expect(deps.removeByBillcomIds).toHaveBeenCalledWith(['b-arch']);
  });

  it('re-reads the last day each run, so an invoice posted to Nexus later still gets matched', async () => {
    const deps = d({ listChanged: vi.fn(async () => ({ results: [bill({ updatedTime: '2026-11-21T11:00:00.000+00:00' })] })) });
    await syncBillcomInvoiceStatus(deps, 30_000);
    expect(deps.writeCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ cursor_value: '2026-11-20T12:00:00.000Z', complete: true }));
  });

  it('during the catch-up (older changes) the cursor follows the last invoice read', async () => {
    const deps = d({ listChanged: vi.fn(async () => ({ results: [bill({ updatedTime: '2026-10-01T00:00:00.000+00:00' })] })) });
    await syncBillcomInvoiceStatus(deps, 30_000);
    expect(deps.writeCheckpoint).toHaveBeenLastCalledWith(expect.objectContaining({ cursor_value: '2026-10-01T00:00:00.000+00:00' }));
  });

  it('checks the clock before each Bill.com request (no request once out of time)', async () => {
    let t = NOW;
    const deps = d({ nowMs: () => (t += 40_000) });
    const r = await syncBillcomInvoiceStatus(deps, 30_000);
    expect(deps.listChanged).not.toHaveBeenCalled();
    expect(r.complete).toBe(false);
  });
});
