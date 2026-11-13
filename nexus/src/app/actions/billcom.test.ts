import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every Supabase call in order, so tests can assert what was written and when. */
type Call =
  | { kind: 'update' | 'insert'; table: string; values: Record<string, unknown> }
  | { kind: 'rpc'; fn: string; args: Record<string, unknown> };

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  rpcResult: {} as Record<string, { data?: unknown; error?: unknown }>,
  owned: true,
  user: { id: 'u1', role: 'admin', organization_id: 'org-1' } as Record<string, unknown> | null,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/users', () => ({ getCurrentUser: async () => mocks.user }));
vi.mock('@/lib/auth/permissions', () => ({
  resolveUserAccess: (u: { role?: string } | null) => ({ isAdmin: u?.role === 'admin' }),
}));
vi.mock('@/lib/billcom/connection', () => ({ createBillcomClientForConnection: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      let pending: Call | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        neq: () => q,
        update: (values: Record<string, unknown>) => ((pending = { kind: 'update', table, values }), q),
        insert: (values: Record<string, unknown>) => ((pending = { kind: 'insert', table, values }), q),
        maybeSingle: async () => ({ data: mocks.owned ? { id: 'c1' } : null, error: null }),
        single: async () => {
          if (pending) mocks.calls.push(pending);
          return { data: { id: 'new-1' }, error: null };
        },
        then: (res: (v: unknown) => unknown) => {
          if (pending) mocks.calls.push(pending);
          return res({ data: null, error: null });
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.calls.push({ kind: 'rpc', fn, args });
      return { data: null, error: null, ...mocks.rpcResult[fn] };
    },
  }),
}));

import { deleteBillcomConnection, saveBillcomConnection } from './billcom';

const input = {
  displayName: 'Sandbox',
  environment: 'sandbox' as const,
  apiBaseUrl: 'https://gateway.stage.bill.com/connect',
  username: 'nexus',
  billcomOrganizationId: '008ORG',
  isDefault: false,
  devKey: '',
  password: '',
};

beforeEach(() => {
  mocks.calls = [];
  mocks.rpcResult = {};
  mocks.owned = true;
});

describe('saveBillcomConnection default flag', () => {
  it('a new default connection is inserted non-default, then made default in one database call', async () => {
    const id = await saveBillcomConnection({ ...input, isDefault: true });
    expect(id).toBe('new-1');
    expect(mocks.calls[0]).toMatchObject({ kind: 'insert', values: { is_default: false } });
    // No separate "clear the other defaults" update before the write.
    expect(mocks.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(mocks.calls.at(-1)).toEqual({
      kind: 'rpc',
      fn: 'set_default_billcom_connection',
      args: { p_connection_id: 'new-1', p_org_id: 'org-1' },
    });
  });

  it('editing the default leaves is_default untouched in the row write', async () => {
    await saveBillcomConnection({ ...input, id: 'c1', isDefault: true });
    const update = mocks.calls.find((c) => c.kind === 'update');
    expect(update && 'values' in update && 'is_default' in update.values).toBe(false);
    expect(mocks.calls.at(-1)).toMatchObject({ kind: 'rpc', fn: 'set_default_billcom_connection' });
  });

  it('a non-default save never calls the default function', async () => {
    await saveBillcomConnection({ ...input, id: 'c1', isDefault: false });
    expect(mocks.calls.find((c) => c.kind === 'update')).toMatchObject({ values: { is_default: false } });
    expect(mocks.calls.some((c) => c.kind === 'rpc')).toBe(false);
  });

  it('surfaces a failure to set the default', async () => {
    mocks.rpcResult.set_default_billcom_connection = { error: new Error('boom') };
    await expect(saveBillcomConnection({ ...input, isDefault: true })).rejects.toThrow('boom');
  });

  it('saves the password exactly as typed, spaces included', async () => {
    await saveBillcomConnection({ ...input, id: 'c1', password: '  pa ss  ' });
    expect(mocks.calls).toContainEqual({
      kind: 'rpc',
      fn: 'set_billcom_password',
      args: { p_connection_id: 'c1', p_secret: '  pa ss  ' },
    });
  });
});

describe('deleteBillcomConnection', () => {
  it('deletes the row and its secrets in one org-scoped database call', async () => {
    mocks.rpcResult.delete_billcom_connection = { data: true };
    await deleteBillcomConnection('c1');
    expect(mocks.calls).toEqual([
      { kind: 'rpc', fn: 'delete_billcom_connection', args: { p_connection_id: 'c1', p_org_id: 'org-1' } },
    ]);
  });

  it('reports a connection that is not in this org', async () => {
    mocks.rpcResult.delete_billcom_connection = { data: false };
    await expect(deleteBillcomConnection('other')).rejects.toThrow('was not found');
  });
});
