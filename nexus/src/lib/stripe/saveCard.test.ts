import { describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type Row } from '@/test/fakeSupabase';

import { ensureStripeCustomer, saveCardFromCheckoutSession } from './saveCard';

const ALLOWED_CARD_KEYS = [
  'organization_id',
  'stripe_connection_id',
  'bc_customer_number',
  'stripe_payment_method_id',
  'brand',
  'last4',
  'exp_month',
  'exp_year',
];

function session(over: Record<string, unknown> = {}, pmId = 'pm_new') {
  return {
    id: 'cs_1',
    mode: 'setup',
    status: 'complete',
    customer: 'cus_1',
    metadata: { organization_id: 'org-1', bc_customer_number: 'C100', card_setup_link_id: 'link-1' },
    setup_intent: {
      id: 'seti_1',
      payment_method: {
        id: pmId,
        card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, fingerprint: 'fp', funding: 'credit' },
      },
    },
    ...over,
  };
}

function fakeStripe(sess: unknown) {
  return {
    checkout: { sessions: { retrieve: vi.fn(async () => sess) } },
    paymentMethods: { detach: vi.fn(async () => ({})), retrieve: vi.fn() },
    customers: { update: vi.fn(async () => ({})), create: vi.fn(async () => ({ id: 'cus_new' })) },
  };
}

function setup(cards: Row[] = [], sess: unknown = session()) {
  const fake = fakeSupabase({
    customer_cards: cards,
    card_setup_links: [{ id: 'link-1', organization_id: 'org-1', completed_at: null }],
    stripe_customers: [],
  });
  const stripe = fakeStripe(sess);
  const scope = { supabase: fake.client, orgId: 'org-1', connectionId: 'conn-1', stripe: stripe as never };
  return { fake, stripe, scope };
}

const writesTo = (fake: ReturnType<typeof fakeSupabase>, table: string, op: string) =>
  fake.writes.filter(([t, o]) => t === table && o === op);

describe('saveCardFromCheckoutSession', () => {
  it('saveCardFromCheckoutSession saves brand/last4/expiry only', async () => {
    const { fake, stripe, scope } = setup();
    const result = await saveCardFromCheckoutSession(scope, 'cs_1');

    expect(result).toEqual({ brand: 'visa', last4: '4242' });
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_1', { expand: ['setup_intent.payment_method'] });

    const inserts = writesTo(fake, 'customer_cards', 'insert');
    expect(inserts).toHaveLength(1);
    const values = inserts[0][2] as Row;
    for (const key of Object.keys(values)) expect(ALLOWED_CARD_KEYS).toContain(key);
    expect(values).not.toHaveProperty('number');
    expect(values).not.toHaveProperty('cvc');
    expect(values).toEqual({
      organization_id: 'org-1',
      stripe_connection_id: 'conn-1',
      bc_customer_number: 'C100',
      stripe_payment_method_id: 'pm_new',
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: 2030,
    });

    expect(stripe.customers.update).toHaveBeenCalledWith('cus_1', {
      invoice_settings: { default_payment_method: 'pm_new' },
    });
    expect(fake.tables.card_setup_links[0].completed_at).toBeTruthy();
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });

  it('saving twice is idempotent', async () => {
    const { fake, stripe, scope } = setup([
      {
        id: 'old',
        organization_id: 'org-1',
        stripe_connection_id: 'conn-1',
        bc_customer_number: 'C100',
        stripe_payment_method_id: 'pm_old',
        removed_at: null,
      },
    ]);
    await saveCardFromCheckoutSession(scope, 'cs_1');
    const second = await saveCardFromCheckoutSession(scope, 'cs_1');

    expect(second).toEqual({ brand: 'visa', last4: '4242' });
    expect(writesTo(fake, 'customer_cards', 'insert')).toHaveLength(1);
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1);
  });

  it('replacing a card removes and detaches the old one', async () => {
    const { fake, stripe, scope } = setup([
      {
        id: 'old',
        organization_id: 'org-1',
        stripe_connection_id: 'conn-1',
        bc_customer_number: 'C100',
        stripe_payment_method_id: 'pm_old',
        removed_at: null,
      },
    ]);
    await saveCardFromCheckoutSession(scope, 'cs_1');

    const old = fake.tables.customer_cards.find((r) => r.id === 'old');
    expect(old?.removed_at).toBeTruthy();
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_old');
    // The old card is marked removed before the new one is inserted (one-active index).
    const ops = fake.writes.filter(([t]) => t === 'customer_cards').map(([, o]) => o);
    expect(ops).toEqual(['update', 'insert']);
  });

  it('treats a unique violation on insert as already saved', async () => {
    const { fake, stripe, scope } = setup();
    fake.failOn = (table, op) =>
      table === 'customer_cards' && op === 'insert' ? { message: 'duplicate key', code: '23505' } : null;
    const result = await saveCardFromCheckoutSession(scope, 'cs_1');
    expect(result).toEqual({ brand: 'visa', last4: '4242' });
    expect(stripe.customers.update).toHaveBeenCalled();
    expect(fake.tables.card_setup_links[0].completed_at).toBeTruthy();
  });

  it('ignores sessions from another organization', async () => {
    const { fake, stripe, scope } = setup(
      [],
      session({ metadata: { organization_id: 'org-2', bc_customer_number: 'C100', card_setup_link_id: 'link-1' } }),
    );
    expect(await saveCardFromCheckoutSession(scope, 'cs_1')).toBeNull();
    expect(fake.writes).toEqual([]);
    expect(stripe.customers.update).not.toHaveBeenCalled();
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });

  it.each([
    ['payment mode', { mode: 'payment' }],
    ['open status', { status: 'open' }],
  ])('ignores sessions that are not completed setup sessions (%s)', async (_l, over) => {
    const { fake, scope } = setup([], session(over));
    expect(await saveCardFromCheckoutSession(scope, 'cs_1')).toBeNull();
    expect(fake.writes).toEqual([]);
  });
});

describe('ensureStripeCustomer', () => {
  it('reuses the stored Stripe customer', async () => {
    const fake = fakeSupabase({
      stripe_customers: [{ id: 's1', stripe_connection_id: 'conn-1', bc_customer_number: 'C100', stripe_customer_id: 'cus_9' }],
    });
    const stripe = fakeStripe(null);
    const scope = { supabase: fake.client, orgId: 'org-1', connectionId: 'conn-1', stripe: stripe as never };
    expect(await ensureStripeCustomer(scope, { bcCustomerNumber: 'C100', name: 'G', email: null })).toBe('cus_9');
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('creates and stores a Stripe customer when missing', async () => {
    const fake = fakeSupabase({ stripe_customers: [] });
    const stripe = fakeStripe(null);
    const scope = { supabase: fake.client, orgId: 'org-1', connectionId: 'conn-1', stripe: stripe as never };
    const id = await ensureStripeCustomer(scope, { bcCustomerNumber: 'C100', name: 'Gallery One', email: 'ap@g.test' });
    expect(id).toBe('cus_new');
    expect(stripe.customers.create).toHaveBeenCalledWith(
      { name: 'Gallery One', email: 'ap@g.test', metadata: { organization_id: 'org-1', bc_customer_number: 'C100' } },
      { idempotencyKey: 'nexus-stripe-customer-conn-1-C100' },
    );
    expect(fake.tables.stripe_customers[0]).toMatchObject({
      organization_id: 'org-1',
      stripe_connection_id: 'conn-1',
      bc_customer_number: 'C100',
      stripe_customer_id: 'cus_new',
    });
  });
});
