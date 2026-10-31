import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  markPending: vi.fn(),
  pushCustomers: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./connection', () => ({ createBillcomClientForConnection: mocks.createClient }));
vi.mock('./customerPush', () => ({ markPending: mocks.markPending, pushCustomers: mocks.pushCustomers }));

import { payloadHash, shouldBeArchived, toBillcomCustomer } from './customerPayload';
import { BillcomConnectionDisabledError } from './errors';
import {
  OFF_MESSAGE,
  pushCustomerAfterSave,
  queueChangedCustomers,
  resolveBillcomConnection,
} from './customerSyncHooks';
import type { BusinessCentralCustomer } from '@/types/database';

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let range: [number, number] | null = null;
      const result = () => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null };
      };
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        order: () => q,
        range: (a: number, b: number) => ((range = [a, b]), q),
        maybeSingle: () => Promise.resolve({ data: result().data[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res(result()),
      };
      return q;
    },
  };
}

const conn = (id: string, is_enabled: boolean, is_default = false) => ({ id, organization_id: 'org-1', is_enabled, is_default });
const result = (p: Row = {}) => ({ created: 0, updated: 0, linked: 0, unchanged: 0, failed: 0, needsAttention: 0, remaining: 0, ...p });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createClient.mockResolvedValue({ request: vi.fn() });
  mocks.markPending.mockResolvedValue(undefined);
});

describe('resolveBillcomConnection', () => {
  it('prefers the enabled default, else the only enabled one', async () => {
    const sb = fakeSupabase({ billcom_connections: [conn('a', true), conn('b', true, true), conn('c', false, true)] });
    expect(await resolveBillcomConnection(sb as never, 'org-1')).toEqual({ id: 'b', enabled: true });
    const one = fakeSupabase({ billcom_connections: [conn('a', true), conn('c', false)] });
    expect(await resolveBillcomConnection(one as never, 'org-1')).toEqual({ id: 'a', enabled: true });
  });

  it('returns null when there is no connection', async () => {
    expect(await resolveBillcomConnection(fakeSupabase({}) as never, 'org-1')).toBeNull();
  });
});

describe('pushCustomerAfterSave', () => {
  const scope = (conns: Row[]) => ({ supabase: fakeSupabase({ billcom_connections: conns }) as never, orgId: 'org-1', bcConnectionId: 'bc-1' });

  it('marks pending then pushes the one number with a 10 s budget', async () => {
    mocks.pushCustomers.mockResolvedValue(result({ updated: 1 }));
    expect(await pushCustomerAfterSave(scope([conn('b1', true)]), 'C1')).toEqual({ status: 'synced' });
    expect(mocks.markPending.mock.calls[0][1]).toEqual(['C1']);
    expect(mocks.markPending.mock.calls[0][0]).toMatchObject({ orgId: 'org-1', bcConnectionId: 'bc-1', billcomConnectionId: 'b1' });
    expect(mocks.pushCustomers.mock.calls[0][1]).toEqual({ numbers: ['C1'], budgetMs: 10000 });
  });

  it('disabled Bill.com keeps the save and leaves it pending', async () => {
    expect(await pushCustomerAfterSave(scope([conn('b1', false)]), 'C1')).toEqual({ status: 'off', message: OFF_MESSAGE });
    expect(mocks.markPending).toHaveBeenCalled();
    expect(mocks.pushCustomers).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('treats a disabled-connection error from the client as off', async () => {
    mocks.createClient.mockRejectedValue(new BillcomConnectionDisabledError('b1'));
    expect((await pushCustomerAfterSave(scope([conn('b1', true)]), 'C1')).status).toBe('off');
  });

  it('no connection is off and queues nothing', async () => {
    expect((await pushCustomerAfterSave(scope([]), 'C1')).status).toBe('off');
    expect(mocks.markPending).not.toHaveBeenCalled();
  });

  it('a budget stop is pending; a failure is failed; a thrown error never escapes', async () => {
    mocks.pushCustomers.mockResolvedValueOnce(result({ remaining: 1, stoppedReason: 'budget' }));
    expect((await pushCustomerAfterSave(scope([conn('b1', true)]), 'C1')).status).toBe('pending');
    mocks.pushCustomers.mockResolvedValueOnce(result({ failed: 1 }));
    expect((await pushCustomerAfterSave(scope([conn('b1', true)]), 'C1')).status).toBe('failed');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.pushCustomers.mockRejectedValueOnce(new Error('boom'));
    const r = await pushCustomerAfterSave(scope([conn('b1', true)]), 'C1');
    expect(r.status).toBe('failed');
    expect(r.message).toContain('boom');
  });
});

describe('queueChangedCustomers', () => {
  const row = (no: string, name: string) =>
    ({ id: `r-${no}`, organization_id: 'org-1', bc_connection_id: 'bc-1', bc_customer_number: no, display_name: name }) as unknown as BusinessCentralCustomer;
  const hash = (r: BusinessCentralCustomer) => payloadHash(toBillcomCustomer(r), shouldBeArchived(r));
  const link = (no: string, h: string | null, status = 'synced') => ({
    id: `l-${no}`, organization_id: 'org-1', bc_connection_id: 'bc-1', billcom_connection_id: 'b1', bc_customer_number: no, last_pushed_hash: h, status,
  });

  it('marks changed and never-pushed customers pending, without Bill.com calls', async () => {
    const same = row('C1', 'Same');
    const changed = row('C2', 'New name');
    const fresh = row('C3', 'Fresh');
    const supabase = fakeSupabase({
      billcom_connections: [conn('b1', true)],
      business_central_customers: [same, changed, fresh] as unknown as Row[],
      billcom_customer_links: [link('C1', hash(same)), link('C2', 'old')],
    });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(2);
    expect(mocks.markPending.mock.calls[0][1]).toEqual(['C2', 'C3']);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.pushCustomers).not.toHaveBeenCalled();
  });

  it('skips entirely when Bill.com is off', async () => {
    const supabase = fakeSupabase({ billcom_connections: [conn('b1', false)], business_central_customers: [row('C1', 'x')] as unknown as Row[] });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBeNull();
    expect(mocks.markPending).not.toHaveBeenCalled();
  });

  it('pages past 1,000 customers', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => row(`C${String(i).padStart(4, '0')}`, `N${i}`));
    const supabase = fakeSupabase({ billcom_connections: [conn('b1', true)], business_central_customers: rows as unknown as Row[] });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(1001);
    expect(mocks.markPending.mock.calls[0][1]).toHaveLength(1001);
  });

  it('skips links that are already pending', async () => {
    const r = row('C1', 'Changed');
    const supabase = fakeSupabase({
      billcom_connections: [conn('b1', true)],
      business_central_customers: [r] as unknown as Row[],
      billcom_customer_links: [link('C1', 'old', 'pending')],
    });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(0);
  });

  it('queues links whose BC customer was deleted, so the next run archives them', async () => {
    const supabase = fakeSupabase({
      billcom_connections: [conn('b1', true)],
      business_central_customers: [],
      billcom_customer_links: [link('GONE', 'h'), link('DONE', 'deleted'), link('WAIT', 'h', 'pending')],
    });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(1);
    expect(mocks.markPending.mock.calls[0][1]).toEqual(['GONE']);
  });
});
