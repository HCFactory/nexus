import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queueChanged: vi.fn(),
  fillCards: vi.fn(),
  calls: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/currentUserAccess', () => ({
  requirePermission: vi.fn().mockResolvedValue({ orgId: 'org-1', user: { id: 'u1' } }),
}));
vi.mock('@/lib/businessCentral/activeConnection', () => ({
  resolveActiveBcConnection: vi.fn().mockResolvedValue({ id: 'bc-1', environment: 'TEST', company_id: 'c' }),
}));
vi.mock('@/lib/supabase/server', () => {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'update', 'upsert']) q[m] = () => q;
  q.range = () => Promise.resolve({ data: [], error: null });
  q.then = (r: (v: unknown) => unknown) => r({ data: null, error: null });
  return { createServiceClient: () => ({ from: () => q }) };
});
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/businessCentral/customerLedgerClient', () => ({ createCustomerLedgerClientForOrg: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/businessCentral/arSyncAdapters', () => ({ buildArSyncAdapters: () => [] }));
vi.mock('@/lib/businessCentral/syncRunner', () => ({ runAllEntitySyncs: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/businessCentral/salesInvoiceLineSync', () => ({
  syncSalesInvoiceLines: vi.fn().mockResolvedValue({ entityType: 'sales_invoice_line', recordsSynced: 0, complete: true, cursor: null }),
}));
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({
  createReferenceTransportForOrg: vi.fn().mockResolvedValue({ list: vi.fn().mockResolvedValue([]) }),
}));
vi.mock('@/lib/businessCentral/customers/customerCardFill', () => ({
  CUSTOMER_CARD_SOURCE: 'card',
  fillCustomerCardFields: (...a: unknown[]) => (mocks.calls.push('fill'), mocks.fillCards(...a)),
}));
vi.mock('@/lib/billcom/customerSyncHooks', () => ({
  queueChangedCustomers: (...a: unknown[]) => (mocks.calls.push('queue'), mocks.queueChanged(...a)),
}));

import { syncBusinessCentralReceivables } from './businessCentralReceivables';

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.queueChanged.mockReset().mockResolvedValue(3);
  mocks.fillCards.mockReset().mockResolvedValue(undefined);
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
