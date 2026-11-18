import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createStripeForConnection, getWebhookSecret, resolveStripeConnection } from './connection';

const state = vi.hoisted(() => ({ rows: [] as unknown[], conn: null as unknown, rpcCalls: [] as string[], rpcData: {} as Record<string, unknown> }));

function fakeSupabase() {
  return {
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: state.conn, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: state.rows, error: null }),
      };
      return q;
    },
    rpc: async (fn: string) => {
      state.rpcCalls.push(fn);
      return { data: state.rpcData[fn] ?? null, error: null };
    },
  } as never;
}

beforeEach(() => {
  state.rows = [];
  state.conn = null;
  state.rpcCalls = [];
  state.rpcData = {};
});

describe('resolveStripeConnection', () => {
  type Row = Record<string, unknown>;
  function tables(t: Record<string, Row[]>) {
    return {
      from: (table: string) => {
        const filters: Array<(r: Row) => boolean> = [];
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
          maybeSingle: async () => ({ data: (t[table] ?? []).filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        };
        return q;
      },
    } as never;
  }
  const env = (stripe_connection_id: string | null, organization_id = 'org') => ({ id: 'bc-1', organization_id, stripe_connection_id });
  const stripeRow = (id: string, is_enabled = true, livemode = false, organization_id = 'org') => ({ id, organization_id, is_enabled, is_default: false, livemode });

  it("uses the Stripe connection picked on the active BC environment and reports livemode", async () => {
    const sb = tables({ business_central_connections: [env('b')], stripe_connections: [stripeRow('a'), stripeRow('b', true, true)] });
    expect(await resolveStripeConnection(sb, 'org', 'bc-1')).toEqual({ id: 'b', enabled: true, livemode: true });
  });

  it('reports a picked connection that is disabled as disabled', async () => {
    const sb = tables({ business_central_connections: [env('a')], stripe_connections: [stripeRow('a', false)] });
    expect(await resolveStripeConnection(sb, 'org', 'bc-1')).toEqual({ id: 'a', enabled: false, livemode: false });
  });

  it('nothing picked means off', async () => {
    const sb = tables({ business_central_connections: [env(null)], stripe_connections: [{ ...stripeRow('a'), is_default: true }] });
    expect(await resolveStripeConnection(sb, 'org', 'bc-1')).toBeNull();
  });

  it("never uses another organisation's environment or connection", async () => {
    expect(await resolveStripeConnection(tables({ business_central_connections: [env('a', 'org-2')], stripe_connections: [stripeRow('a')] }), 'org', 'bc-1')).toBeNull();
    expect(await resolveStripeConnection(tables({ business_central_connections: [env('a')], stripe_connections: [stripeRow('a', true, false, 'org-2')] }), 'org', 'bc-1')).toBeNull();
  });
});

describe('createStripeForConnection', () => {
  it('throws when disabled without calling Vault', async () => {
    state.conn = { id: 'c1', is_enabled: false };
    await expect(createStripeForConnection(fakeSupabase(), 'org', 'c1')).rejects.toThrow(/disabled/i);
    expect(state.rpcCalls).toEqual([]);
  });
  it('throws when the connection is not found', async () => {
    await expect(createStripeForConnection(fakeSupabase(), 'org', 'c1')).rejects.toThrow('Stripe connection c1 was not found.');
  });
  it('throws when the key is missing', async () => {
    state.conn = { id: 'c1', is_enabled: true };
    await expect(createStripeForConnection(fakeSupabase(), 'org', 'c1')).rejects.toThrow(/secret key is not set/i);
  });
  it('returns a Stripe client when the key exists', async () => {
    state.conn = { id: 'c1', is_enabled: true };
    state.rpcData['get_stripe_secret_key'] = 'sk_test_abc';
    const stripe = await createStripeForConnection(fakeSupabase(), 'org', 'c1');
    expect(typeof stripe.accounts.retrieve).toBe('function');
  });
});

describe('getWebhookSecret', () => {
  it('returns the secret or null', async () => {
    state.rpcData['get_stripe_webhook_secret'] = 'whsec_x';
    expect(await getWebhookSecret(fakeSupabase(), 'c1')).toBe('whsec_x');
    state.rpcData = {};
    expect(await getWebhookSecret(fakeSupabase(), 'c1')).toBeNull();
  });
});
