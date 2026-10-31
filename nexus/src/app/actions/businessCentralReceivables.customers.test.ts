import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  resolveConnection: vi.fn(),
  createServiceClient: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/currentUserAccess', () => ({ requirePermission: mocks.requirePermission }));
vi.mock('@/lib/businessCentral/activeConnection', () => ({ resolveActiveBcConnection: mocks.resolveConnection }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock('@/lib/businessCentral/client', () => ({ createBcClientForOrg: vi.fn() }));
vi.mock('@/lib/businessCentral/customerReferences/transport', () => ({ createReferenceTransportForOrg: vi.fn() }));
vi.mock('@/lib/businessCentral/customerLedgerClient', () => ({ createCustomerLedgerClientForOrg: vi.fn() }));

import { getCustomersPageData } from './businessCentralReceivables';

// Fake supabase that enforces the 1,000-row cap unless .range() is used.
function fakeSupabase(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: `id-${String(i).padStart(5, '0')}`, display_name: `C${i}` }));
  const eqs: [string, unknown][] = [];
  const orders: string[] = [];
  const ranges: [number, number][] = [];
  const q: Record<string, unknown> = {};
  let range: [number, number] | null = null;
  q.select = () => q;
  q.eq = (c: string, v: unknown) => { eqs.push([c, v]); return q; };
  q.order = (c: string) => { orders.push(c); return q; };
  q.range = (a: number, b: number) => { range = [a, b]; ranges.push([a, b]); return q; };
  q.then = (resolve: (v: unknown) => unknown) => {
    const [a, b] = range ?? [0, 999];
    return resolve({ data: all.slice(a, Math.min(b, a + 999) + 1), error: null });
  };
  return { client: { from: () => q }, all, eqs, orders, ranges };
}

describe('getCustomersPageData paging', () => {
  beforeEach(() => {
    mocks.requirePermission.mockResolvedValue({ orgId: 'org-1', user: { id: 'u' }, access: { isAdmin: true } });
    mocks.resolveConnection.mockResolvedValue({ id: 'conn-1' });
  });

  it('returns all 1,973 customers in order across pages', async () => {
    const f = fakeSupabase(1973);
    mocks.createServiceClient.mockReturnValue(f.client);
    const { customers } = await getCustomersPageData();
    expect(customers).toHaveLength(1973);
    expect(customers.map((c) => c.id)).toEqual(f.all.map((c) => c.id));
    expect(f.ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(f.orders).toEqual(['display_name', 'id', 'display_name', 'id']);
    expect(f.eqs).toContainEqual(['organization_id', 'org-1']);
    expect(f.eqs).toContainEqual(['bc_connection_id', 'conn-1']);
  });

  it('fetches an extra empty page when the total is an exact multiple of 1,000', async () => {
    const f = fakeSupabase(2000);
    mocks.createServiceClient.mockReturnValue(f.client);
    const { customers } = await getCustomersPageData();
    expect(customers).toHaveLength(2000);
  });
});
