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
  openPushDeps,
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
/** Tables where BC environment bc-1 uses the first of these Bill.com connections. */
const linked = (conns: Row[]) => ({
  billcom_connections: conns,
  business_central_connections: [{ id: 'bc-1', organization_id: 'org-1', billcom_connection_id: (conns[0]?.id as string | undefined) ?? null }],
});
const result = (p: Row = {}) => ({ created: 0, updated: 0, linked: 0, unchanged: 0, failed: 0, needsAttention: 0, remaining: 0, ...p });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createClient.mockResolvedValue({ request: vi.fn() });
  mocks.markPending.mockResolvedValue(undefined);
});

describe('resolveBillcomConnection', () => {
  const env = (billcom_connection_id: string | null, organization_id = 'org-1') => ({ id: 'bc-1', organization_id, billcom_connection_id });

  it("uses the Bill.com connection picked on the active BC environment, not the org default", async () => {
    const sb = fakeSupabase({ business_central_connections: [env('a')], billcom_connections: [conn('a', true), conn('b', true, true)] });
    expect(await resolveBillcomConnection(sb as never, 'org-1', 'bc-1')).toEqual({ id: 'a', enabled: true });
  });

  it('reports a picked connection that is disabled as disabled', async () => {
    const sb = fakeSupabase({ business_central_connections: [env('a')], billcom_connections: [conn('a', false)] });
    expect(await resolveBillcomConnection(sb as never, 'org-1', 'bc-1')).toEqual({ id: 'a', enabled: false });
  });

  it('nothing picked on the environment means off, even when the org has a default', async () => {
    const sb = fakeSupabase({ business_central_connections: [env(null)], billcom_connections: [conn('b', true, true)] });
    expect(await resolveBillcomConnection(sb as never, 'org-1', 'bc-1')).toBeNull();
  });

  it("never uses another organisation's environment or connection", async () => {
    const other = fakeSupabase({ business_central_connections: [env('a', 'org-2')], billcom_connections: [conn('a', true)] });
    expect(await resolveBillcomConnection(other as never, 'org-1', 'bc-1')).toBeNull();
    const foreign = fakeSupabase({ business_central_connections: [env('x')], billcom_connections: [{ ...conn('x', true), organization_id: 'org-2' }] });
    expect(await resolveBillcomConnection(foreign as never, 'org-1', 'bc-1')).toBeNull();
  });
});

describe('pushCustomerAfterSave', () => {
  const scope = (conns: Row[]) => ({ supabase: fakeSupabase({ ...linked(conns) }) as never, orgId: 'org-1', bcConnectionId: 'bc-1' });

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
      ...linked([conn('b1', true)]),
      business_central_customers: [same, changed, fresh] as unknown as Row[],
      billcom_customer_links: [link('C1', hash(same)), link('C2', 'old')],
    });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(2);
    expect(mocks.markPending.mock.calls[0][1]).toEqual(['C2', 'C3']);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.pushCustomers).not.toHaveBeenCalled();
  });

  it('skips entirely when Bill.com is off', async () => {
    const supabase = fakeSupabase({ ...linked([conn('b1', false)]), business_central_customers: [row('C1', 'x')] as unknown as Row[] });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBeNull();
    expect(mocks.markPending).not.toHaveBeenCalled();
  });

  it('pages past 1,000 customers', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => row(`C${String(i).padStart(4, '0')}`, `N${i}`));
    const supabase = fakeSupabase({ ...linked([conn('b1', true)]), business_central_customers: rows as unknown as Row[] });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(1001);
    expect(mocks.markPending.mock.calls[0][1]).toHaveLength(1001);
  });

  it('skips links that are already pending', async () => {
    const r = row('C1', 'Changed');
    const supabase = fakeSupabase({
      ...linked([conn('b1', true)]),
      business_central_customers: [r] as unknown as Row[],
      billcom_customer_links: [link('C1', 'old', 'pending')],
    });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(0);
  });

  it('queues links whose BC customer was deleted, so the next run archives them', async () => {
    const supabase = fakeSupabase({
      ...linked([conn('b1', true)]),
      business_central_customers: [],
      billcom_customer_links: [link('GONE', 'h'), link('DONE', 'deleted'), link('WAIT', 'h', 'pending')],
    });
    expect(await queueChangedCustomers({ supabase: supabase as never, orgId: 'org-1', bcConnectionId: 'bc-1' })).toBe(1);
    expect(mocks.markPending.mock.calls[0][1]).toEqual(['GONE']);
  });
});

describe('Bill.com connector mode (the environment has "invoices come from Bill.com\'s own BC connector")', () => {
  const viaConnector = (conns: Row[]) => ({
    billcom_connections: conns,
    business_central_connections: [{ id: 'bc-1', organization_id: 'org-1', billcom_connection_id: 'b1', billcom_via_connector: true }],
  });
  const scope = (extra: Record<string, Row[]> = {}) => ({
    supabase: fakeSupabase({ ...viaConnector([conn('b1', true)]), ...extra }) as never,
    orgId: 'org-1',
    bcConnectionId: 'bc-1',
  });

  it('a customer save never pushes or queues, and shows no Bill.com note', async () => {
    expect(await pushCustomerAfterSave(scope(), 'C1')).toEqual({ status: 'off' });
    expect(mocks.markPending).not.toHaveBeenCalled();
    expect(mocks.pushCustomers).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('the sync queues nothing', async () => {
    expect(await queueChangedCustomers(scope({ business_central_customers: [] }))).toBeNull();
    expect(mocks.markPending).not.toHaveBeenCalled();
  });

  it('no push deps (Push to Bill.com and Retry are off)', async () => {
    expect(await openPushDeps(scope())).toBeNull();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it('reading is still allowed: the connection still resolves for invoice lookups', async () => {
    expect(await resolveBillcomConnection(scope().supabase, 'org-1', 'bc-1')).toEqual({ id: 'b1', enabled: true });
  });
});
