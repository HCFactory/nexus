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

import { CUSTOMER_FIELDS } from '@/lib/businessCentral/customers/customerFields';
import { getCustomersPageData } from './businessCentralReceivables';

// Fake supabase: a fresh query per from(), the 1,000-row cap, count: 'exact', and in-flight tracking.
function fakeSupabase(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: `id-${String(i).padStart(5, '0')}`, display_name: `C${i}` }));
  const eqs: [string, unknown][] = [];
  const orders: string[] = [];
  const ranges: [number, number][] = [];
  const selects: string[] = [];
  const stats = { inFlight: 0, maxInFlight: 0 };
  const from = () => {
    const q: Record<string, unknown> = {};
    let range: [number, number] | null = null;
    let counted = false;
    q.select = (cols: string, opts?: { count?: string }) => { selects.push(cols); counted = opts?.count === 'exact'; return q; };
    q.eq = (c: string, v: unknown) => { eqs.push([c, v]); return q; };
    q.order = (c: string) => { orders.push(c); return q; };
    q.range = (a: number, b: number) => { range = [a, b]; ranges.push([a, b]); return q; };
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      return new Promise((r) => setTimeout(r, 5)).then(() => {
        stats.inFlight--;
        const [a, b] = range ?? [0, 999];
        return { data: all.slice(a, Math.min(b, a + 999) + 1), error: null, count: counted ? total : null };
      }).then(resolve, reject);
    };
    return q;
  };
  return { client: { from }, all, eqs, orders, ranges, selects, stats };
}

describe('getCustomersPageData paging', () => {
  beforeEach(() => {
    mocks.requirePermission.mockResolvedValue({ orgId: 'org-1', user: { id: 'u' }, access: { isAdmin: true } });
    mocks.resolveConnection.mockResolvedValue({ id: 'conn-1' });
  });

  it('returns all 3,644 customers in order, fetching the pages after the first at the same time', async () => {
    const f = fakeSupabase(3644);
    mocks.createServiceClient.mockReturnValue(f.client);
    const { customers } = await getCustomersPageData();
    expect(customers).toHaveLength(3644);
    expect(customers.map((c) => c.id)).toEqual(f.all.map((c) => c.id));
    expect([...f.ranges].sort((x, y) => x[0] - y[0])).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3999]]);
    expect(f.stats.maxInFlight).toBe(3);
    expect(f.eqs).toContainEqual(['organization_id', 'org-1']);
    expect(f.eqs).toContainEqual(['bc_connection_id', 'conn-1']);
    expect(f.orders.filter((o) => o === 'display_name')).toHaveLength(4);
  });

  it('an exact multiple of 1,000 needs no extra empty page', async () => {
    const f = fakeSupabase(2000);
    mocks.createServiceClient.mockReturnValue(f.client);
    const { customers } = await getCustomersPageData();
    expect(customers).toHaveLength(2000);
    expect(f.ranges).toHaveLength(2);
  });

  it('asks only for the columns the list and edit form use, never the raw BC record', async () => {
    const f = fakeSupabase(3);
    mocks.createServiceClient.mockReturnValue(f.client);
    await getCustomersPageData();
    const cols = f.selects[0].split(',').map((c) => c.trim());
    expect(cols).not.toContain('*');
    expect(cols).not.toContain('bc_raw_payload');
    for (const c of ['id', 'bc_customer_number', 'display_name', 'email', 'city', 'currency_code', 'balance', ...CUSTOMER_FIELDS.map((x) => x.name)]) {
      expect(cols).toContain(c);
    }
  });
});
