import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createStripeForConnection, getWebhookSecret, resolveDefaultStripeConnection } from './connection';

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

describe('resolveDefaultStripeConnection', () => {
  it('prefers the enabled default and reports livemode', async () => {
    state.rows = [
      { id: 'a', is_enabled: true, is_default: false, livemode: false },
      { id: 'b', is_enabled: true, is_default: true, livemode: true },
    ];
    expect(await resolveDefaultStripeConnection(fakeSupabase(), 'org')).toEqual({ id: 'b', enabled: true, livemode: true });
  });
  it('returns null when there are none', async () => {
    expect(await resolveDefaultStripeConnection(fakeSupabase(), 'org')).toBeNull();
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
