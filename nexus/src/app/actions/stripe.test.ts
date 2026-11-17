import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call =
  | { kind: 'update' | 'insert'; table: string; values: Record<string, unknown> }
  | { kind: 'rpc'; fn: string; args: Record<string, unknown> };

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  owned: true,
  user: { id: 'u1', role: 'admin', organization_id: 'org-1' } as Record<string, unknown> | null,
  retrieve: vi.fn(),
  balance: vi.fn(),
  createStripe: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/users', () => ({ getCurrentUser: async () => mocks.user }));
vi.mock('@/lib/auth/permissions', () => ({
  resolveUserAccess: (u: { role?: string } | null) => ({ isAdmin: u?.role === 'admin' }),
}));
vi.mock('@/lib/stripe/connection', () => ({ createStripeForConnection: mocks.createStripe }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from(table: string) {
      let pending: Call | null = null;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        neq: () => q,
        order: () => q,
        update: (values: Record<string, unknown>) => ((pending = { kind: 'update', table, values }), q),
        insert: (values: Record<string, unknown>) => ((pending = { kind: 'insert', table, values }), q),
        delete: () => ((pending = { kind: 'update', table, values: { deleted: true } }), q),
        maybeSingle: async () => ({ data: mocks.owned ? { id: 'c1' } : null, error: null }),
        single: async () => {
          if (pending) mocks.calls.push(pending);
          return { data: { id: 'new-1' }, error: null };
        },
        then: (res: (v: unknown) => unknown) => {
          if (pending) mocks.calls.push(pending);
          return res({ data: [], error: null });
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.calls.push({ kind: 'rpc', fn, args });
      return { data: null, error: null };
    },
  }),
}));

import {
  deleteStripeConnection,
  listStripeConnections,
  saveStripeConnection,
  setStripeConnectionEnabled,
  testStripeConnection,
} from './stripe';

const SK = 'sk_test_SECRETVALUE';
const WH = 'whsec_SECRETVALUE';
const input = { displayName: 'Main', isDefault: false };

beforeEach(() => {
  mocks.calls = [];
  mocks.owned = true;
  mocks.user = { id: 'u1', role: 'admin', organization_id: 'org-1' };
  mocks.retrieve.mockReset();
  mocks.balance.mockReset();
  mocks.createStripe.mockReset();
  mocks.createStripe.mockResolvedValue({ accounts: { retrieve: mocks.retrieve }, balance: { retrieve: mocks.balance } });
});

describe('admin only', () => {
  it('non-admin is refused for every action', async () => {
    mocks.user = { id: 'u2', role: 'member', organization_id: 'org-1' };
    const msg = 'You do not have permission to manage Stripe connections';
    await expect(listStripeConnections()).rejects.toThrow(msg);
    await expect(saveStripeConnection(input)).rejects.toThrow(msg);
    await expect(setStripeConnectionEnabled('c1', true)).rejects.toThrow(msg);
    await expect(deleteStripeConnection('c1')).rejects.toThrow(msg);
    await expect(testStripeConnection('c1')).rejects.toThrow(msg);
    expect(mocks.calls).toEqual([]);
  });
});

describe('saveStripeConnection', () => {
  it('stores keys via Vault RPCs and never on the row', async () => {
    const id = await saveStripeConnection({ ...input, secretKey: SK, webhookSecret: WH });
    expect(id).toBe('new-1');
    expect(mocks.calls).toContainEqual({ kind: 'rpc', fn: 'set_stripe_secret_key', args: { p_connection_id: 'new-1', p_secret: SK } });
    expect(mocks.calls).toContainEqual({ kind: 'rpc', fn: 'set_stripe_webhook_secret', args: { p_connection_id: 'new-1', p_secret: WH } });
    for (const c of mocks.calls) {
      if (c.kind !== 'rpc') expect(JSON.stringify(c.values)).not.toMatch(/SECRETVALUE/);
    }
  });

  it('foreign connection id fails closed', async () => {
    mocks.owned = false;
    await expect(saveStripeConnection({ ...input, id: 'x' })).rejects.toThrow('Stripe connection x was not found.');
    expect(mocks.calls).toEqual([]);
  });

  it('validates key prefixes', async () => {
    await expect(saveStripeConnection({ ...input, secretKey: 'pk_test_1' })).rejects.toThrow(/sk_test_ or sk_live_/);
    await expect(saveStripeConnection({ ...input, webhookSecret: 'abc' })).rejects.toThrow(/whsec_/);
    expect(mocks.calls).toEqual([]);
  });

  it('blank secrets leave stored values alone', async () => {
    await saveStripeConnection({ ...input, id: 'c1', secretKey: '', webhookSecret: '' });
    expect(mocks.calls.filter((c) => c.kind === 'rpc')).toEqual([]);
  });

  it('making a connection default clears the other default first', async () => {
    await saveStripeConnection({ ...input, isDefault: true });
    const updates = mocks.calls.filter((c) => c.kind === 'update');
    expect(updates[0]).toMatchObject({ values: { is_default: false } });
    expect(updates.at(-1)).toMatchObject({ values: { is_default: true } });
  });
});

describe('testStripeConnection', () => {
  it('stores livemode and account id', async () => {
    mocks.retrieve.mockResolvedValue({ id: 'acct_1' });
    mocks.balance.mockResolvedValue({ livemode: true });
    const result = await testStripeConnection('c1');
    expect(result).toMatchObject({ ok: true, livemode: true, stripeAccountId: 'acct_1' });
    expect(mocks.calls).toContainEqual(
      expect.objectContaining({ kind: 'update', table: 'stripe_connections', values: expect.objectContaining({ livemode: true, stripe_account_id: 'acct_1' }) }),
    );
  });
  it('returns ok:false on Stripe failure', async () => {
    mocks.retrieve.mockRejectedValue(new Error('Invalid API Key'));
    expect(await testStripeConnection('c1')).toEqual({ ok: false, message: 'Invalid API Key' });
  });
});

describe('deleteStripeConnection', () => {
  it('removes Vault secrets before the row', async () => {
    await deleteStripeConnection('c1');
    expect(mocks.calls[0]).toEqual({ kind: 'rpc', fn: 'delete_stripe_secrets', args: { p_connection_id: 'c1' } });
    expect(mocks.calls[1]).toMatchObject({ kind: 'update', table: 'stripe_connections' });
  });
  it('fails closed on a foreign id', async () => {
    mocks.owned = false;
    await expect(deleteStripeConnection('x')).rejects.toThrow('Stripe connection x was not found.');
    expect(mocks.calls).toEqual([]);
  });
});
