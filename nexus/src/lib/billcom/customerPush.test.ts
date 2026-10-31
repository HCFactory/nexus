import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { BillcomClient } from './client';
import { payloadHash, shouldBeArchived, toBillcomCustomer } from './customerPayload';
import { markPending, planInitialPush, pushCustomers, type PushDeps } from './customerPush';
import { BillcomApiError, BillcomRateLimitError } from './errors';
import type { BillcomCustomerLink, BusinessCentralCustomer } from '@/types/database';

type Row = Record<string, unknown>;

/** Minimal in-memory Supabase: select/eq/in/order/range, upsert, update. */
function fakeSupabase(tables: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: string }> = [];
  let seq = 0;
  function from(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let range: [number, number] | null = null;
    let mode: 'select' | 'update' = 'select';
    let patch: Row = {};
    const run = () => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (mode === 'update') {
        matched.forEach((r) => Object.assign(r, patch));
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      const sorted = [...matched].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const page = range ? sorted.slice(range[0], range[1] + 1) : sorted;
      return { data: page.map((r) => ({ ...r })), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
      order: () => q,
      range: (a: number, b: number) => ((range = [a, b]), q),
      update: (p: Row) => {
        writes.push({ table, op: 'update' });
        mode = 'update';
        patch = p;
        return q;
      },
      upsert: async (input: Row | Row[]) => {
        writes.push({ table, op: 'upsert' });
        for (const r of Array.isArray(input) ? input : [input]) {
          const key = ['organization_id', 'bc_connection_id', 'billcom_connection_id', 'bc_customer_number'];
          const hit = rows.find((x) => key.every((k) => x[k] === r[k]));
          if (hit) Object.assign(hit, r);
          else rows.push({ id: `link-${++seq}`, billcom_customer_id: null, last_pushed_hash: null, last_error: null, ...r });
        }
        return { data: null, error: null };
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return q;
  }
  return { client: { from } as unknown as SupabaseClient, tables, writes };
}

interface BcCust {
  id: string;
  archived: boolean;
  name: string;
  accountNumber: string;
  [k: string]: unknown;
}

/** Fake Bill.com: records calls, keeps a customer list, can fail per call. */
function fakeBillcom(initial: BcCust[] = [], opts: { failOn?: (path: string, body: Row | undefined) => Error | null } = {}) {
  const customers = initial.map((c) => ({ ...c }));
  const calls: Array<{ method: string; path: string; body?: Row }> = [];
  let n = 0;
  const client: BillcomClient = {
    login: async () => 's',
    getSession: async () => null,
    request: async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const method = init.method ?? 'GET';
      const body = init.body ? (JSON.parse(String(init.body)) as Row) : undefined;
      calls.push({ method, path, body });
      const err = opts.failOn?.(path, body);
      if (err) throw err;
      if (method === 'GET' && path.startsWith('/v3/customers')) {
        const archivedOnly = path.includes('archived%3Aeq%3Atrue') || path.includes('archived:eq:true');
        return { results: customers.filter((c) => (archivedOnly ? c.archived : !c.archived)) } as T;
      }
      if (method === 'POST' && path === '/v3/customers') {
        const c = { ...(body as Row), id: `0cu${++n}`, archived: false } as BcCust;
        customers.push(c);
        return c as T;
      }
      const m = path.match(/^\/v3\/customers\/([^/]+)(\/(archive|restore))?$/);
      const c = m && customers.find((x) => x.id === m[1]);
      if (!c) throw new BillcomApiError({ status: 404, statusText: 'NF', message: 'not found', url: path });
      if (m[3] === 'archive') c.archived = true;
      else if (m[3] === 'restore') c.archived = false;
      else Object.assign(c, body);
      return c as T;
    },
  };
  return { client, calls, customers };
}

const ORG = 'org-1';
const BC = 'bc-1';
const BILL = 'bill-1';

function bcRow(no: string, over: Partial<BusinessCentralCustomer> = {}): BusinessCentralCustomer {
  return {
    id: `bcrow-${no}`,
    organization_id: ORG,
    bc_connection_id: BC,
    bc_customer_number: no,
    display_name: `Customer ${no}`,
    email: `${no}@x.com`,
    phone_number: '555',
    address_line_1: '1 Main',
    address_line_2: null,
    city: 'Town',
    state: 'CA',
    postal_code: '90000',
    country: 'US',
    blocked: null,
    ...over,
  } as BusinessCentralCustomer;
}

function link(no: string, over: Partial<BillcomCustomerLink> = {}): Row {
  return {
    id: `link-${no}`,
    organization_id: ORG,
    bc_connection_id: BC,
    billcom_connection_id: BILL,
    business_central_customer_id: `bcrow-${no}`,
    bc_customer_number: no,
    billcom_customer_id: null,
    status: 'pending',
    last_pushed_hash: null,
    last_pushed_at: null,
    last_error: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function setup(bcRows: BusinessCentralCustomer[], links: Row[], bill: ReturnType<typeof fakeBillcom>, now?: () => number) {
  const sb = fakeSupabase({
    business_central_customers: bcRows as unknown as Row[],
    billcom_customer_links: links,
  });
  const deps: PushDeps = {
    supabase: sb.client,
    billcom: bill.client,
    orgId: ORG,
    bcConnectionId: BC,
    billcomConnectionId: BILL,
    now,
  };
  return { deps, sb };
}

const linkRow = (sb: ReturnType<typeof fakeSupabase>, no: string) =>
  sb.tables.billcom_customer_links.find((l) => l.bc_customer_number === no)!;
const writesToBillcom = (bill: ReturnType<typeof fakeBillcom>) => bill.calls.filter((c) => c.method !== 'GET');

describe('pushCustomers', () => {
  it('creates with account number = BC number', async () => {
    const bill = fakeBillcom();
    const { deps, sb } = setup([bcRow('C1')], [link('C1')], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.created).toBe(1);
    const post = bill.calls.find((c) => c.method === 'POST' && c.path === '/v3/customers')!;
    expect(post.body).toMatchObject({ accountNumber: 'C1', name: 'Customer C1' });
    const l = linkRow(sb, 'C1');
    expect(l.status).toBe('synced');
    expect(l.billcom_customer_id).toBe('0cu1');
    expect(l.last_pushed_hash).toBe(payloadHash(toBillcomCustomer(bcRow('C1')), false));
  });

  it('duplicate account numbers need attention', async () => {
    const bill = fakeBillcom([
      { id: '0cuA', archived: false, name: 'A', accountNumber: 'C1' },
      { id: '0cuB', archived: true, name: 'B', accountNumber: 'C1' },
    ]);
    const { deps, sb } = setup([bcRow('C1')], [link('C1')], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.needsAttention).toBe(1);
    const l = linkRow(sb, 'C1');
    expect(l.status).toBe('needs_attention');
    expect(l.last_error).toContain('0cuA');
    expect(l.last_error).toContain('0cuB');
    expect(l.billcom_customer_id).toBeNull();
    expect(writesToBillcom(bill)).toHaveLength(0);
  });

  it('existing account number is linked, never duplicated', async () => {
    const bill = fakeBillcom([{ id: '0cuX', archived: false, name: 'Old name', accountNumber: 'C1' }]);
    const { deps, sb } = setup([bcRow('C1')], [link('C1')], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.linked).toBe(1);
    expect(res.created).toBe(0);
    expect(bill.calls.some((c) => c.method === 'POST' && c.path === '/v3/customers')).toBe(false);
    expect(bill.customers).toHaveLength(1);
    expect(bill.customers[0].name).toBe('Customer C1');
    expect(linkRow(sb, 'C1').billcom_customer_id).toBe('0cuX');
    expect(linkRow(sb, 'C1').status).toBe('synced');
  });

  it('rate limit stops the run and leaves the rest pending', async () => {
    const rows = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((n) => bcRow(n));
    const bill = fakeBillcom([], {
      failOn: (path, body) =>
        path === '/v3/customers' && body?.accountNumber === 'C2'
          ? new BillcomRateLimitError({ status: 429, statusText: 'x', code: 'BDC_1144', message: 'busy', url: path })
          : null,
    });
    const { deps, sb } = setup(rows, rows.map((r) => link(r.bc_customer_number!)), bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.stoppedReason).toBe('rate_limit');
    expect(linkRow(sb, 'C2').status).toBe('pending');
    expect(linkRow(sb, 'C6').status).toBe('pending');
    expect(res.remaining).toBeGreaterThan(0);
    expect(res.failed).toBe(0);
  });

  it('inactive match is reused and reactivated', async () => {
    const bill = fakeBillcom([{ id: '0cuZ', archived: true, name: 'Z', accountNumber: 'C1' }]);
    const { deps, sb } = setup([bcRow('C1')], [link('C1')], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.linked).toBe(1);
    expect(bill.calls.some((c) => c.path === '/v3/customers/0cuZ/restore')).toBe(true);
    expect(bill.customers).toHaveLength(1);
    expect(bill.customers[0].archived).toBe(false);
    expect(linkRow(sb, 'C1').billcom_customer_id).toBe('0cuZ');
  });

  it('archives a blocked customer after creating it', async () => {
    const bill = fakeBillcom();
    const { deps } = setup([bcRow('C1', { blocked: 'All' })], [link('C1')], bill);
    await pushCustomers(deps, { budgetMs: 10_000 });
    expect(bill.customers[0].archived).toBe(true);
  });

  it('unchanged hash makes no call', async () => {
    const row = bcRow('C1');
    const hash = payloadHash(toBillcomCustomer(row), shouldBeArchived(row));
    const bill = fakeBillcom([{ id: '0cu9', archived: false, name: 'x', accountNumber: 'C1' }]);
    const { deps, sb } = setup([row], [link('C1', { billcom_customer_id: '0cu9', last_pushed_hash: hash })], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.unchanged).toBe(1);
    expect(bill.calls).toHaveLength(0);
    expect(linkRow(sb, 'C1').status).toBe('synced');
  });

  it('budget stop leaves remaining pending', async () => {
    let t = 0;
    const now = () => t;
    const rows = ['C1', 'C2', 'C3', 'C4', 'C5'].map((n) => bcRow(n));
    const bill = fakeBillcom();
    const orig = bill.client.request;
    bill.client.request = async (p, i) => {
      t += 400;
      return orig(p, i);
    };
    const { deps, sb } = setup(rows, rows.map((r) => link(r.bc_customer_number!)), bill, now);
    const res = await pushCustomers(deps, { budgetMs: 1_000 });
    expect(res.stoppedReason).toBe('budget');
    expect(res.remaining).toBeGreaterThan(0);
    const pending = sb.tables.billcom_customer_links.filter((l) => l.status === 'pending');
    expect(pending.length).toBe(res.remaining);
  });

  it('deleted customer is made inactive', async () => {
    const bill = fakeBillcom([{ id: '0cuD', archived: false, name: 'D', accountNumber: 'C9' }]);
    const { deps, sb } = setup(
      [],
      [link('C9', { business_central_customer_id: null, billcom_customer_id: '0cuD', last_pushed_hash: 'old' })],
      bill,
    );
    await pushCustomers(deps, { budgetMs: 10_000 });
    expect(bill.calls.some((c) => c.path === '/v3/customers/0cuD/archive')).toBe(true);
    expect(linkRow(sb, 'C9').status).toBe('synced');
  });

  it('other errors mark failed with the Bill.com message and the run continues', async () => {
    const bill = fakeBillcom([], {
      failOn: (path, body) =>
        path === '/v3/customers' && body?.accountNumber === 'C1'
          ? new BillcomApiError({ status: 400, statusText: 'Bad', message: 'Name is invalid', url: path })
          : null,
    });
    const { deps, sb } = setup([bcRow('C1'), bcRow('C2')], [link('C1'), link('C2')], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.failed).toBe(1);
    expect(res.created).toBe(1);
    expect(linkRow(sb, 'C1').status).toBe('failed');
    expect(linkRow(sb, 'C1').last_error).toBe('Name is invalid');
  });

  it('scopes links to org + both connections', async () => {
    const bill = fakeBillcom();
    const { deps, sb } = setup([bcRow('C1')], [link('C1', { billcom_connection_id: 'other' })], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.created).toBe(0);
    expect(linkRow(sb, 'C1').status).toBe('pending');
  });

  it('pushes only the given numbers', async () => {
    const bill = fakeBillcom();
    const { deps, sb } = setup([bcRow('C1'), bcRow('C2')], [link('C1'), link('C2')], bill);
    const res = await pushCustomers(deps, { numbers: ['C2'], budgetMs: 10_000 });
    expect(res.created).toBe(1);
    expect(linkRow(sb, 'C1').status).toBe('pending');
    expect(linkRow(sb, 'C2').status).toBe('synced');
  });
});

describe('pushCustomers review fixes', () => {
  it('two concurrent runs over the same pending link make exactly one POST', async () => {
    const bill = fakeBillcom();
    const { deps } = setup([bcRow('C1')], [link('C1')], bill);
    await Promise.all([pushCustomers(deps, { budgetMs: 10_000 }), pushCustomers(deps, { budgetMs: 10_000 })]);
    expect(bill.calls.filter((c) => c.method === 'POST' && c.path === '/v3/customers')).toHaveLength(1);
    expect(bill.customers).toHaveLength(1);
  });

  it('skips the create when the link gained a Bill.com id meanwhile', async () => {
    const bill = fakeBillcom();
    const { deps, sb } = setup([bcRow('C1')], [link('C1')], bill);
    const orig = bill.client.request;
    bill.client.request = async <T,>(p: string, i?: RequestInit): Promise<T> => {
      const r = await orig<T>(p, i);
      if (p.startsWith('/v3/customers?')) linkRow(sb, 'C1').billcom_customer_id = '0cuOther';
      return r;
    };
    await pushCustomers(deps, { budgetMs: 10_000 });
    expect(bill.calls.filter((c) => c.method === 'POST' && c.path === '/v3/customers')).toHaveLength(0);
  });

  it('numbers path + budget stop leaves unprocessed links pending', async () => {
    let t = 0;
    const nos = ['C1', 'C2', 'C3', 'C4', 'C5'];
    const rows = nos.map((n) => bcRow(n));
    const bill = fakeBillcom(nos.map((n) => ({ id: `0cu${n}`, archived: false, name: 'x', accountNumber: n })));
    const orig = bill.client.request;
    bill.client.request = async (p, i) => {
      t += 400;
      return orig(p, i);
    };
    const links = nos.map((n) => link(n, { status: 'synced', billcom_customer_id: `0cu${n}`, last_pushed_hash: 'stale' }));
    const { deps, sb } = setup(rows, links, bill, () => t);
    const res = await pushCustomers(deps, { numbers: nos, budgetMs: 1_000 });
    expect(res.stoppedReason).toBe('budget');
    const pending = sb.tables.billcom_customer_links.filter((l) => l.status === 'pending');
    expect(pending.length).toBe(res.remaining);
    expect(res.remaining).toBeGreaterThan(0);
  });

  it('a DB error while recording a failure does not reject the run', async () => {
    const bill = fakeBillcom([], {
      failOn: (path, body) =>
        path === '/v3/customers' && body?.accountNumber === 'C1'
          ? new BillcomApiError({ status: 400, statusText: 'Bad', message: 'bad', url: path })
          : null,
    });
    const { deps, sb } = setup([bcRow('C1'), bcRow('C2')], [link('C1'), link('C2')], bill);
    const from = sb.client.from.bind(sb.client);
    (sb.client as unknown as { from: unknown }).from = (t: string) => {
      const q = from(t) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const upd = q.update;
      q.update = (p: unknown) => {
        if ((p as Row).status === 'failed') throw new Error('db down');
        return upd(p);
      };
      return q;
    };
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.created).toBe(1);
    expect(res.failed).toBe(1);
  });

  it('a failed Bill.com list read stops the run and leaves links as they were', async () => {
    const bill = fakeBillcom([], {
      failOn: (path) =>
        path.startsWith('/v3/customers?')
          ? new BillcomApiError({ status: 500, statusText: 'x', message: 'Bill.com is down', url: path })
          : null,
    });
    const { deps, sb } = setup([bcRow('C1'), bcRow('C2')], [link('C1'), link('C2')], bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.stoppedReason).toBe('list_failed');
    expect(res.error).toBe('Bill.com is down');
    expect(res.failed).toBe(0);
    expect(sb.tables.billcom_customer_links.every((l) => l.status === 'pending' && l.last_error === null)).toBe(true);
  });

  it('never has more than 3 Bill.com requests in flight', async () => {
    const nos = Array.from({ length: 10 }, (_, i) => `C${i}`);
    const bill = fakeBillcom();
    const orig = bill.client.request;
    let inFlight = 0;
    let peak = 0;
    bill.client.request = async <T,>(p: string, i?: RequestInit): Promise<T> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return await orig<T>(p, i);
      } finally {
        inFlight--;
      }
    };
    const { deps } = setup(nos.map((n) => bcRow(n)), nos.map((n) => link(n)), bill);
    const res = await pushCustomers(deps, { budgetMs: 10_000 });
    expect(res.created).toBe(10);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('markPending', () => {
  it('upserts links to pending with the BC row id', async () => {
    const bill = fakeBillcom();
    const { deps, sb } = setup([bcRow('C1'), bcRow('C2')], [link('C1', { status: 'synced' })], bill);
    await markPending(deps, ['C1', 'C2']);
    expect(linkRow(sb, 'C1').status).toBe('pending');
    expect(linkRow(sb, 'C2')).toMatchObject({ status: 'pending', business_central_customer_id: 'bcrow-C2' });
    expect(sb.tables.billcom_customer_links).toHaveLength(2);
  });
});

describe('planInitialPush', () => {
  it('preview writes nothing', async () => {
    const bill = fakeBillcom([
      { id: '0cu1', archived: false, name: 'Old', accountNumber: 'C1' },
      { id: '0cu2', archived: false, name: 'a', accountNumber: 'C3' },
      { id: '0cu3', archived: false, name: 'b', accountNumber: 'C3' },
    ]);
    const { deps, sb } = setup([bcRow('C1'), bcRow('C2'), bcRow('C3'), bcRow('C4', { blocked: 'Invoice' })], [], bill);
    const p = await planInitialPush(deps);
    expect(p.link).toBe(1);
    expect(p.create).toBe(2);
    expect(p.deactivate).toBe(1);
    expect(p.needsAttention).toEqual([{ number: 'C3', reason: expect.stringContaining('0cu2') }]);
    expect(p.sample.find((s) => s.number === 'C1')?.changes.name).toEqual(['Old', 'Customer C1']);
    expect(sb.writes).toHaveLength(0);
    expect(writesToBillcom(bill)).toHaveLength(0);
  });

  it('reads archived Bill.com customers and pages', async () => {
    const bill = fakeBillcom([{ id: '0cuA', archived: true, name: 'A', accountNumber: 'C1' }]);
    const { deps } = setup([bcRow('C1')], [], bill);
    const p = await planInitialPush(deps);
    expect(p.link).toBe(1);
    expect(p.create).toBe(0);
  });
});
