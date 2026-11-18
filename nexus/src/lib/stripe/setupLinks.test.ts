import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type Row } from '@/test/fakeSupabase';

import {
  SETUP_LINK_DAYS,
  cancelSetupLinks,
  createSetupLink,
  findUsableSetupLink,
  hashSetupToken,
  newSetupToken,
  setupLinkUrl,
  startSetupCheckout,
} from './setupLinks';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function linkRow(token: string, extra: Row = {}): Row {
  return {
    id: 'link-1',
    organization_id: 'org-1',
    stripe_connection_id: 'conn-1',
    bc_customer_number: 'C100',
    token_hash: hashSetupToken(token),
    created_by: 'user-1',
    created_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + DAY).toISOString(),
    canceled_at: null,
    completed_at: null,
    emailed_to: null,
    stripe_checkout_session_id: null,
    ...extra,
  };
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nexus.example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('newSetupToken', () => {
  it('newSetupToken gives 43-char base64url token and matching sha256 hex', () => {
    const { token, tokenHash } = newSetupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSetupToken(token)).toBe(tokenHash);
    expect(newSetupToken().token).not.toBe(token);
  });

  it('builds the public URL from NEXT_PUBLIC_APP_URL', () => {
    expect(setupLinkUrl('abc')).toBe('https://nexus.example.com/card-setup/abc');
  });

  it('uses CARD_SETUP_BASE_URL when set (trailing slash ignored)', () => {
    vi.stubEnv('CARD_SETUP_BASE_URL', 'https://payment.example.com/');
    expect(setupLinkUrl('abc')).toBe('https://payment.example.com/card-setup/abc');
  });

  it('a blank CARD_SETUP_BASE_URL falls back to NEXT_PUBLIC_APP_URL', () => {
    vi.stubEnv('CARD_SETUP_BASE_URL', '  ');
    expect(setupLinkUrl('abc')).toBe('https://nexus.example.com/card-setup/abc');
  });
});

describe('findUsableSetupLink', () => {
  const { token } = newSetupToken();

  it.each([
    ['expired', { expires_at: new Date(NOW.getTime() - 1000).toISOString() }],
    ['cancelled', { canceled_at: NOW.toISOString() }],
    ['completed', { completed_at: NOW.toISOString() }],
  ])('rejects expired/cancelled/completed tokens (%s)', async (_label, extra) => {
    const fake = fakeSupabase({ card_setup_links: [linkRow(token, extra)] });
    expect(await findUsableSetupLink(fake.client, token, NOW)).toBeNull();
  });

  it('rejects an unknown token', async () => {
    const fake = fakeSupabase({ card_setup_links: [linkRow(token)] });
    expect(await findUsableSetupLink(fake.client, newSetupToken().token, NOW)).toBeNull();
  });

  it('rejects a malformed token without querying', async () => {
    const fake = fakeSupabase({ card_setup_links: [] });
    const from = vi.spyOn(fake.client, 'from');
    expect(await findUsableSetupLink(fake.client, 'not a token', NOW)).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it('accepts a fresh token', async () => {
    const fake = fakeSupabase({ card_setup_links: [linkRow(token)] });
    const link = await findUsableSetupLink(fake.client, token, NOW);
    expect(link?.id).toBe('link-1');
  });
});

describe('createSetupLink', () => {
  it('createSetupLink cancels earlier unused links and expires in 14 days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fake = fakeSupabase({
      card_setup_links: [
        linkRow('old-unused', { id: 'old-1', token_hash: 'h1' }),
        linkRow('old-done', { id: 'old-2', token_hash: 'h2', completed_at: '2026-11-01T00:00:00.000Z' }),
        linkRow('other-cust', { id: 'old-3', token_hash: 'h3', bc_customer_number: 'C200' }),
      ],
    });

    const result = await createSetupLink(fake.client, {
      orgId: 'org-1',
      connectionId: 'conn-1',
      bcCustomerNumber: 'C100',
      createdBy: 'user-1',
      emailedTo: 'ap@customer.test',
    });

    expect(SETUP_LINK_DAYS).toBe(14);
    expect(result.expiresAt).toBe(new Date(NOW.getTime() + 14 * DAY).toISOString());

    // Cancel happens before the insert.
    const ops = fake.writes.map(([table, op]) => `${table}:${op}`);
    expect(ops).toEqual(['card_setup_links:update', 'card_setup_links:insert']);
    expect(fake.writes[0][2]).toHaveProperty('canceled_at');

    const rows = fake.tables.card_setup_links;
    expect(rows.find((r) => r.id === 'old-1')?.canceled_at).toBeTruthy();
    expect(rows.find((r) => r.id === 'old-2')?.canceled_at).toBeNull();
    expect(rows.find((r) => r.id === 'old-3')?.canceled_at).toBeNull();

    // The URL carries the raw token; the DB only has its hash.
    const token = result.url.split('/card-setup/')[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const inserted = fake.writes[1][2] as Row;
    expect(inserted.token_hash).toBe(hashSetupToken(token));
    expect(JSON.stringify(inserted)).not.toContain(token);
    expect(inserted).toMatchObject({
      organization_id: 'org-1',
      stripe_connection_id: 'conn-1',
      bc_customer_number: 'C100',
      created_by: 'user-1',
      emailed_to: 'ap@customer.test',
    });
    expect(result.id).toBe(rows[rows.length - 1].id);
  });
});

describe('cancelSetupLinks', () => {
  it('cancels only unused links for that customer and connection', async () => {
    const fake = fakeSupabase({
      card_setup_links: [
        linkRow('a', { id: 'a', token_hash: 'ha' }),
        linkRow('b', { id: 'b', token_hash: 'hb', stripe_connection_id: 'conn-2' }),
      ],
    });
    await cancelSetupLinks(fake.client, { orgId: 'org-1', connectionId: 'conn-1', bcCustomerNumber: 'C100' });
    expect(fake.tables.card_setup_links.find((r) => r.id === 'a')?.canceled_at).toBeTruthy();
    expect(fake.tables.card_setup_links.find((r) => r.id === 'b')?.canceled_at).toBeNull();
  });

  it('without a Stripe client (auto-cancel on a new link) never expires a session', async () => {
    const fake = fakeSupabase({ card_setup_links: [linkRow('a', { id: 'a', token_hash: 'ha', stripe_checkout_session_id: 'cs_a' })] });
    await cancelSetupLinks(fake.client, { orgId: 'org-1', connectionId: 'conn-1', bcCustomerNumber: 'C100' });
    expect(fake.tables.card_setup_links[0].canceled_at).toBeTruthy();
  });

  it('with a Stripe client expires open links’ Checkout sessions, skipping links without one and completed links', async () => {
    const fake = fakeSupabase({
      card_setup_links: [
        linkRow('a', { id: 'a', token_hash: 'ha', stripe_checkout_session_id: 'cs_a' }),
        linkRow('b', { id: 'b', token_hash: 'hb' }),
        linkRow('c', { id: 'c', token_hash: 'hc', stripe_checkout_session_id: 'cs_done', completed_at: NOW.toISOString() }),
      ],
    });
    const expire = vi.fn(async () => ({}));
    await cancelSetupLinks(fake.client, { orgId: 'org-1', connectionId: 'conn-1', bcCustomerNumber: 'C100' }, { stripe: { checkout: { sessions: { expire } } } as never });
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith('cs_a');
    expect(fake.tables.card_setup_links.find((r) => r.id === 'a')?.canceled_at).toBeTruthy();
    expect(fake.tables.card_setup_links.find((r) => r.id === 'b')?.canceled_at).toBeTruthy();
  });

  it('an already-expired/complete session is ignored quietly; any other Stripe error is logged; the link is cancelled either way', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const already = Object.assign(new Error('Only Checkout Sessions with a status in ["open"] can be expired.'), { type: 'StripeInvalidRequestError' });
    const fake1 = fakeSupabase({ card_setup_links: [linkRow('a', { id: 'a', token_hash: 'ha', stripe_checkout_session_id: 'cs_a' })] });
    await cancelSetupLinks(fake1.client, { orgId: 'org-1', connectionId: 'conn-1', bcCustomerNumber: 'C100' }, {
      stripe: { checkout: { sessions: { expire: vi.fn(async () => { throw already; }) } } } as never,
    });
    expect(fake1.tables.card_setup_links[0].canceled_at).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();

    const fake2 = fakeSupabase({ card_setup_links: [linkRow('a', { id: 'a', token_hash: 'ha', stripe_checkout_session_id: 'cs_a' })] });
    await cancelSetupLinks(fake2.client, { orgId: 'org-1', connectionId: 'conn-1', bcCustomerNumber: 'C100' }, {
      stripe: { checkout: { sessions: { expire: vi.fn(async () => { throw Object.assign(new Error('boom'), { type: 'StripeAPIError' }); }) } } } as never,
    });
    expect(fake2.tables.card_setup_links[0].canceled_at).toBeTruthy();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('cs_a');
    errors.mockRestore();
  });
});

describe('startSetupCheckout', () => {
  it('creates a setup-mode session with consent text and metadata and stores its id', async () => {
    const token = newSetupToken().token;
    const link = linkRow(token, { emailed_to: 'ap@customer.test' });
    const fake = fakeSupabase({
      card_setup_links: [link],
      stripe_customers: [
        { id: 'sc-1', stripe_connection_id: 'conn-1', bc_customer_number: 'C100', stripe_customer_id: 'cus_1' },
      ],
      organizations: [{ id: 'org-1', name: 'Acme Art' }],
      business_central_customers: [
        { id: 'bc-1', organization_id: 'org-1', bc_customer_number: 'C100', display_name: 'Gallery One', email: 'x@y.test' },
      ],
    });
    const create = vi.fn(async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/cs_test_1' }));
    const stripe = { checkout: { sessions: { create } }, customers: { create: vi.fn() } };

    const url = await startSetupCheckout(
      { supabase: fake.client, orgId: 'org-1', connectionId: 'conn-1', stripe: stripe as never },
      link as never,
      token,
    );

    expect(url).toBe('https://checkout.stripe.com/c/cs_test_1');
    expect(create).toHaveBeenCalledWith({
      mode: 'setup',
      customer: 'cus_1',
      currency: 'usd',
      allowed_payment_method_types: ['card'],
      success_url: `https://nexus.example.com/card-setup/${token}/done?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://nexus.example.com/card-setup/${token}`,
      custom_text: {
        submit: { message: 'By saving this card you authorize Acme Art to charge it for past-due invoices.' },
      },
      metadata: { organization_id: 'org-1', bc_customer_number: 'C100', card_setup_link_id: 'link-1' },
    });
    expect(fake.tables.card_setup_links[0].stripe_checkout_session_id).toBe('cs_test_1');
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });
});
