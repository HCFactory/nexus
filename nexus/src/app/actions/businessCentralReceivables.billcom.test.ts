import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queueChanged: vi.fn(),
  fillCards: vi.fn(),
  pullShipTos: vi.fn(),
  pullPriceLists: vi.fn(),
  calls: [] as string[],
  runAll: vi.fn(),
  revalidate: vi.fn(),
  syncLines: vi.fn(),
  list: vi.fn(),
  checkpoint: null as null | { cursor_value: string | null; records_synced: number },
  upserts: [] as { table: string; row: Record<string, unknown> }[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mocks.revalidate(...a) }));
vi.mock('@/lib/auth/currentUserAccess', () => ({
  requirePermission: vi.fn().mockResolvedValue({ orgId: 'org-1', user: { id: 'u1' } }),
}));
vi.mock('@/lib/businessCentral/activeConnection', () => ({
  resolveActiveBcConnection: vi.fn().mockResolvedValue({ id: 'bc-1', environment: 'TEST', company_id: 'c' }),
}));
vi.mock('@/lib/supabase/server', () => {
  const make = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'update']) q[m] = () => q;
    q.upsert = (row: Record<string, unknown>) => (mocks.upserts.push({ table, row }), q);
    q.range = () => Promise.resolve({ data: [], error: null });
    q.maybeSingle = () => Promise.resolve({ data: table === 'business_central_sync_checkpoints' ? mocks.checkpoint : null, error: null });
    q.then = (r: (v: unknown) => unknown) => r({ data: null, error: null });
    return q;
  };
  return { createServiceClient: () => ({ from: make }) };
});
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/businessCentral/customerLedgerClient', () => ({ createCustomerLedgerClientForOrg: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/businessCentral/arSyncAdapters', () => ({
  buildArSyncAdapters: () => [{ entityType: 'customer' }, { entityType: 'sales_invoice' }, { entityType: 'customer_ledger_entry' }],
}));
vi.mock('@/lib/businessCentral/syncRunner', () => ({ runAllEntitySyncs: (...a: unknown[]) => mocks.runAll(...a) }));
vi.mock('@/lib/businessCentral/salesInvoiceLineSync', () => ({
  syncSalesInvoiceLines: (...a: unknown[]) => mocks.syncLines(...a),
  fetchLinesForInvoicesFromBc: vi.fn(),
}));
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({
  createReferenceTransportForOrg: vi.fn().mockResolvedValue({ list: (...a: unknown[]) => mocks.list(...a) }),
}));
vi.mock('@/lib/businessCentral/customers/customerCardFill', () => ({
  CUSTOMER_CARD_SOURCE: 'card',
  CARD_SELECT_FIELDS: ['No', 'EMailCCHCABG'],
  fillCustomerCardFieldsInChunks: (...a: unknown[]) => (mocks.calls.push('fill'), mocks.fillCards(...a)),
}));
vi.mock('@/lib/businessCentral/shipTo/shipToService', () => ({
  pullShipTos: (...a: unknown[]) => mocks.pullShipTos(...a),
}));
vi.mock('@/lib/businessCentral/priceLists/priceListSync', () => ({
  pullSalesPriceLists: (...a: unknown[]) => mocks.pullPriceLists(...a),
}));
vi.mock('@/lib/billcom/customerSyncHooks', () => ({
  queueChangedCustomers: (...a: unknown[]) => (mocks.calls.push('queue'), mocks.queueChanged(...a)),
}));

import { syncBusinessCentralReceivables, syncCustomersLight } from './businessCentralReceivables';

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.queueChanged.mockReset().mockResolvedValue(3);
  mocks.fillCards.mockReset().mockResolvedValue({ filled: 0, cursor: null, complete: true });
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.runAll.mockReset().mockResolvedValue([]);
  mocks.syncLines.mockReset().mockResolvedValue({ entityType: 'sales_invoice_line', recordsSynced: 0, complete: true, cursor: null, error: null });
  mocks.checkpoint = null;
  mocks.upserts.length = 0;
  mocks.pullShipTos.mockReset().mockResolvedValue({ upserted: 0, deleted: 0 });
  mocks.pullPriceLists.mockReset().mockResolvedValue({ lines: 0 });
});

describe('sync queues changed customers for Bill.com', () => {
  it('runs after the card fill, scoped to the org and BC connection', async () => {
    await syncBusinessCentralReceivables();
    expect(mocks.calls).toEqual(['fill', 'queue']);
    expect(mocks.queueChanged.mock.calls[0][0]).toMatchObject({ orgId: 'org-1', bcConnectionId: 'bc-1' });
  });

  it('a Bill.com queue failure is logged and never fails the sync', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.queueChanged.mockRejectedValue(new Error('links table down'));
    const results = await syncBusinessCentralReceivables();
    expect(results.some((r) => r.error)).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('sync pulls ship-to addresses', () => {
  it('calls pullShipTos once with no customer number', async () => {
    await syncBusinessCentralReceivables();
    expect(mocks.pullShipTos).toHaveBeenCalledTimes(1);
    expect(mocks.pullShipTos.mock.calls[0]).toHaveLength(1);
    expect(mocks.pullShipTos.mock.calls[0][0]).toMatchObject({ orgId: 'org-1', connectionId: 'bc-1' });
  });

  it('a pull failure is reported and the rest of the sync still finishes', async () => {
    mocks.pullShipTos.mockRejectedValue(new Error('page 300 down'));
    const results = await syncBusinessCentralReceivables();
    expect(results).toContainEqual({
      entityType: 'customer',
      recordsSynced: 0,
      complete: false,
      cursor: null,
      error: 'Ship-to addresses: page 300 down',
    });
    expect(results.some((r) => r.entityType === 'sales_invoice_line')).toBe(true);
    expect(mocks.calls).toContain('queue');
  });
});

describe('sync copies sales price lists', () => {
  it('calls pullSalesPriceLists scoped to the org and connection', async () => {
    await syncBusinessCentralReceivables();
    expect(mocks.pullPriceLists).toHaveBeenCalledTimes(1);
    expect(mocks.pullPriceLists.mock.calls[0][0]).toMatchObject({ orgId: 'org-1', connectionId: 'bc-1' });
  });

  it('a failure is reported and the rest of the sync still finishes', async () => {
    mocks.pullPriceLists.mockRejectedValue(new Error('page 7015 down'));
    const results = await syncBusinessCentralReceivables();
    expect(results).toContainEqual({
      entityType: 'customer',
      recordsSynced: 0,
      complete: false,
      cursor: null,
      error: 'Sales price lists: page 7015 down',
    });
    expect(results.some((r) => r.entityType === 'sales_invoice_line')).toBe(true);
    expect(mocks.calls).toContain('queue');
  });
});

describe('sync fills customer card fields in batches', () => {
  const cardCheckpoint = () => mocks.upserts.find((u) => u.table === 'business_central_sync_checkpoints' && u.row.entity_type === 'customer_card')?.row;

  it('continues from the saved cursor, asking BC for one sorted batch of only the needed fields', async () => {
    mocks.checkpoint = { cursor_value: "W'01", records_synced: 500 };
    await syncBusinessCentralReceivables();
    const o = mocks.fillCards.mock.calls[0][0] as { startAfter: string | null; fetchChunk: (a: string | null, n: number) => Promise<unknown> };
    expect(o.startAfter).toBe("W'01");
    await o.fetchChunk("W'01", 500);
    expect(mocks.list).toHaveBeenCalledWith('card', { select: ['No', 'EMailCCHCABG'], orderby: 'No', top: 500, filter: "No gt 'W''01'" });
    await o.fetchChunk(null, 500);
    expect(mocks.list).toHaveBeenLastCalledWith('card', { select: ['No', 'EMailCCHCABG'], orderby: 'No', top: 500 });
  });

  it('a finished pass clears the cursor and adds no result line', async () => {
    mocks.fillCards.mockResolvedValue({ filled: 120, cursor: null, complete: true });
    const results = await syncBusinessCentralReceivables();
    expect(cardCheckpoint()).toMatchObject({ bc_connection_id: 'bc-1', cursor_value: null, completed_full_pass: true });
    expect(results.some((r) => r.error?.startsWith('Customer card fields'))).toBe(false);
  });

  it('out of time: saves the cursor and reports "click Sync again"', async () => {
    mocks.fillCards.mockResolvedValue({ filled: 1500, cursor: 'W01500', complete: false });
    const results = await syncBusinessCentralReceivables();
    expect(cardCheckpoint()).toMatchObject({ cursor_value: 'W01500', completed_full_pass: false });
    expect(results).toContainEqual({ entityType: 'customer', recordsSynced: 1500, complete: false, cursor: 'W01500', error: null });
  });

  it('a failed batch saves the progress and reports the error', async () => {
    mocks.fillCards.mockResolvedValue({ filled: 500, cursor: 'W00500', complete: false, error: 'timeout' });
    const results = await syncBusinessCentralReceivables();
    expect(cardCheckpoint()).toMatchObject({ cursor_value: 'W00500', last_error: 'timeout' });
    expect(results).toContainEqual({ entityType: 'customer', recordsSynced: 500, complete: false, cursor: 'W00500', error: 'Customer card fields: timeout' });
  });
});

describe('invoice lines get their own time window', () => {
  it('passes 40 seconds, not what the other syncs left over', async () => {
    await syncBusinessCentralReceivables();
    expect(mocks.syncLines.mock.calls[0][2]).toBe(40_000);
  });
});

describe('sync refreshes the pages that show synced data', () => {
  it('revalidates customers (and their profiles) and receivables', async () => {
    mocks.revalidate.mockReset();
    await syncBusinessCentralReceivables();
    expect(mocks.revalidate).toHaveBeenCalledWith('/customers', 'layout');
    expect(mocks.revalidate).toHaveBeenCalledWith('/receivables', 'layout');
  });
});

describe('light sync (Customers page, every 15 minutes)', () => {
  it('syncs customers only, then card fields, ship-tos and the Bill.com queue; no invoices, ledger, price lists or lines', async () => {
    await syncCustomersLight();
    const adapters = mocks.runAll.mock.calls[0][1] as { entityType: string }[];
    expect(adapters.map((a) => a.entityType)).toEqual(['customer']);
    expect(mocks.fillCards).toHaveBeenCalledTimes(1);
    expect(mocks.pullShipTos).toHaveBeenCalledTimes(1);
    expect(mocks.queueChanged).toHaveBeenCalledTimes(1);
    expect(mocks.pullPriceLists).not.toHaveBeenCalled();
    expect(mocks.syncLines).not.toHaveBeenCalled();
  });

  it('the full sync runs every part', async () => {
    await syncBusinessCentralReceivables();
    const adapters = mocks.runAll.mock.calls[0][1] as { entityType: string }[];
    expect(adapters.map((a) => a.entityType)).toEqual(['customer', 'sales_invoice', 'customer_ledger_entry']);
    expect(mocks.pullPriceLists).toHaveBeenCalledTimes(1);
    expect(mocks.syncLines).toHaveBeenCalledTimes(1);
  });
});
