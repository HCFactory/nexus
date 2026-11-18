import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, type FakeSupabase, type Row } from '@/test/fakeSupabase';
import type { BillcomLookup, CardLabel } from '@/types/stripe';

const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/billcom/recordPayment', () => ({ recordBillcomCardPayment: (...a: unknown[]) => mocks.record(...a) }));

import {
  AUTH_REQUIRED_MESSAGE,
  CHARGE_CHANGED_MESSAGE,
  DUPLICATE_CHARGE_MESSAGE,
  businessDate,
  chargeEligibility,
  chargeInvoice,
  checkChargeStatus,
  MARKED_NOT_CHARGED_MESSAGE,
  NOT_CHARGED_MIN_AGE_MS,
  markNotCharged,
  markRecordedManually,
  retryBillcomRecord,
  invoiceChargeView,
  invoiceChargeStatus,
  type ChargeDeps,
} from './chargeInvoice';

const INV = '143fbb46-e8e0-f111-84e4-7ced8d88ddac';
// 2026-11-17 10:00 in Honolulu (UTC-10).
const NOW = new Date('2026-11-17T20:00:00.000Z');

const CARD: CardLabel = {
  id: 'card-1',
  brand: 'visa',
  last4: '4242',
  expMonth: 12,
  expYear: 2030,
  savedAt: '2026-11-01T00:00:00Z',
  stripePaymentMethodId: 'pm_1',
  stripeConnectionId: 'sc-1',
};

const status = (over: Record<string, unknown> = {}) => ({
  id: '00eBILL',
  invoiceNumber: 'W-100532',
  status: 'OPEN',
  statusLabel: 'Open',
  totalAmount: 100,
  dueAmount: 100,
  dueDate: '2026-11-01',
  customerId: '0cu1',
  ...over,
});
/** What staff confirmed: $100 on card-1 (the default lookup). */
const ARGS = { bcInvoiceId: INV, userId: 'u1', expectedAmountCents: 10000, cardId: 'card-1' };
const found = (over: Record<string, unknown> = {}): BillcomLookup => ({ kind: 'found', status: status(over), billcomCustomerId: '0cu1' });

describe('businessDate', () => {
  it('is the date in Honolulu, not UTC', () => {
    // 2026-11-18 05:00 UTC is still 2026-11-17 in Hawaii.
    expect(businessDate(new Date('2026-11-18T05:00:00Z'))).toBe('2026-11-17');
    expect(businessDate(new Date('2026-11-18T10:00:00Z'))).toBe('2026-11-18');
  });
});

describe('chargeEligibility', () => {
  const base = { canCharge: true, stripe: 'ready' as const, card: CARD, billcom: found(), today: '2026-11-17' };
  it.each([
    ['no permission', { canCharge: false }, "You don't have permission to charge cards."],
    ['stripe off', { stripe: 'off' as const }, "Stripe isn't set up."],
    ['no card', { card: null }, 'No card on file — send a setup link from the customer page.'],
    ['bill.com off', { billcom: { kind: 'off' } as BillcomLookup }, "This invoice isn't in Bill.com yet."],
    ['not linked', { billcom: { kind: 'not_linked' } as BillcomLookup }, "This invoice isn't in Bill.com yet."],
    ['not found', { billcom: { kind: 'not_found' } as BillcomLookup }, "This invoice isn't in Bill.com yet."],
    ['no customer id', { billcom: { kind: 'found', status: status(), billcomCustomerId: null } as BillcomLookup }, "This invoice isn't in Bill.com yet."],
    ['ambiguous', { billcom: { kind: 'ambiguous' } as BillcomLookup }, 'More than one Bill.com invoice matches this number.'],
    ['nothing due', { billcom: found({ dueAmount: 0 }) }, 'Nothing is due on this invoice.'],
    ['due unknown', { billcom: found({ dueAmount: null }) }, 'Nothing is due on this invoice.'],
    ['due today', { billcom: found({ dueDate: '2026-11-17' }) }, "This invoice isn't past due yet."],
    ['due later', { billcom: found({ dueDate: '2026-12-01' }) }, "This invoice isn't past due yet."],
    ['no due date', { billcom: found({ dueDate: null }) }, "This invoice isn't past due yet."],
    ['cancelled and replaced', { invoice: 'replaced' as const }, 'This invoice was cancelled and replaced — charge the corrected invoice.'],
    ['being changed', { invoice: 'changing' as const }, 'This invoice is being changed — try again once the change is done.'],
  ])('%s', (_name, over, reason) => {
    expect(chargeEligibility({ ...base, ...over })).toEqual({ ok: false, reason });
  });

  it('ok with the amount and due date when past due', () => {
    expect(chargeEligibility(base)).toEqual({ ok: true, amount: 100, dueDate: '2026-11-01' });
  });

  it('stripe defaults to ready when not given', () => {
    expect(chargeEligibility({ ...base, stripe: undefined })).toMatchObject({ ok: true });
  });
});

type Log = string[];

function stripeError(type: string, message: string, code?: string, pi?: Row) {
  return Object.assign(new Error(message), { type, code, payment_intent: pi });
}

function setup(opts: {
  tables?: Record<string, Row[]>;
  lookup?: BillcomLookup;
  create?: (params: Row, options: Row) => Promise<unknown>;
  list?: (params: Row) => Promise<unknown>;
  retrieve?: (id: string) => Promise<unknown>;
  canCharge?: boolean;
  stripeConnectionId?: string | null;
  billcom?: boolean;
} = {}) {
  const log: Log = [];
  const db: FakeSupabase = fakeSupabase({
    customer_cards: [
      {
        id: 'card-1', organization_id: 'org-1', stripe_connection_id: 'sc-1', bc_customer_number: 'C1',
        stripe_payment_method_id: 'pm_1', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030,
        saved_at: '2026-11-01T00:00:00Z', removed_at: null,
      },
    ],
    stripe_customers: [{ id: 'scu-1', organization_id: 'org-1', stripe_connection_id: 'sc-1', bc_customer_number: 'C1', stripe_customer_id: 'cus_1' }],
    business_central_customers: [{ organization_id: 'org-1', bc_customer_number: 'C1', email: 'ap@example.com; boss@example.com' }],
    card_payments: [],
    ...opts.tables,
  });
  db.failOn = (table, op, payload) => {
    if (op !== 'select' && table === 'card_payments') {
      const p = payload as Row;
      log.push(`db:${op}:${String(p.status ?? p.billcom_state ?? '')}`);
    }
    return null;
  };
  const create = vi.fn(async (params: Row, options: Row) => {
    log.push('stripe');
    return opts.create ? opts.create(params, options) : { id: 'pi_1', status: 'succeeded' };
  });
  const search = vi.fn(async () => ({ data: [] }));
  const list = vi.fn(async (params: Row) => (opts.list ? opts.list(params) : { data: [], has_more: false }));
  const retrieve = vi.fn(async (id: string) => (opts.retrieve ? opts.retrieve(id) : { id, status: 'succeeded' }));
  const stripe = { paymentIntents: { create, search, list, retrieve } };
  mocks.record.mockImplementation(async () => {
    log.push('billcom');
    return { paymentId: '0pay1' };
  });
  const findBillcomInvoice = vi.fn(async () => opts.lookup ?? found());
  const deps: ChargeDeps = {
    supabase: db.client,
    orgId: 'org-1',
    canCharge: opts.canCharge ?? true,
    stripeConnectionId: opts.stripeConnectionId === undefined ? 'sc-1' : opts.stripeConnectionId,
    stripeClient: vi.fn(async () => stripe as never),
    billcom: vi.fn(async () => (opts.billcom === false ? null : ({ request: vi.fn() } as never))),
    loadInvoice: vi.fn(async (id: string) =>
      id === INV
        ? { bcInvoiceId: INV, customerNumber: 'C1', invoiceNumber: 'INV-100412', invoiceNumbers: ['W-100532', 'INV-100412'], salesOrderId: 'so-1', billcomInvoiceId: null }
        : null,
    ),
    findBillcomInvoice,
    now: () => NOW,
  };
  return { db, deps, log, create, search, list, retrieve, findBillcomInvoice };
}

const paymentRow = (over: Row = {}): Row => ({
  id: 'cp-1', organization_id: 'org-1', stripe_connection_id: 'sc-1', bc_customer_number: 'C1', sales_order_id: 'so-1',
  bc_invoice_id: INV, billcom_invoice_id: '00eBILL', billcom_customer_id: '0cu1', invoice_number: 'INV-100412',
  amount: 60, currency: 'usd', card_id: 'card-1', stripe_payment_intent_id: null, status: 'processing', failure_message: null,
  billcom_state: 'not_started', billcom_payment_id: null, billcom_error: null, charged_by: 'u1',
  charged_at: '2026-11-17T19:59:00.000Z', billcom_recorded_at: null, recorded_manually_by: null,
  billcom_attempt_at: null, not_charged_by: null, not_charged_at: null,
  ...over,
});

beforeEach(() => {
  mocks.record.mockReset();
});

describe('invoiceChargeStatus', () => {
  it('replaced when a finished change replaced it, changing while a change is open, else live', () => {
    expect(invoiceChargeStatus({ replacedBy: { id: 'x', number: 'INV-2' }, changes: [] })).toBe('replaced');
    expect(invoiceChargeStatus({ replacedBy: null, changes: [{ state: 'billcom_failed' }] })).toBe('changing');
    expect(invoiceChargeStatus({ replacedBy: null, changes: [{ state: 'done' }, { state: 'discarded' }] })).toBe('live');
  });
});

describe('chargeInvoice', () => {
  it('refuses while the invoice is being changed, before asking Bill.com or Stripe', async () => {
    const s = setup();
    const load = vi.mocked(s.deps.loadInvoice);
    const ctx = await load(INV);
    load.mockResolvedValue(ctx && { ...ctx, status: 'changing' });
    await expect(chargeInvoice(s.deps, { bcInvoiceId: INV, userId: 'u1', expectedAmountCents: 10000, cardId: 'card-1' })).rejects.toThrow('This invoice is being changed — try again once the change is done.');
    expect(s.findBillcomInvoice).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
  });

  it('charges the fresh Bill.com due amount when it matches what staff confirmed', async () => {
    const s = setup({ lookup: found({ dueAmount: 60 }) });
    const row = await chargeInvoice(s.deps, { ...ARGS, expectedAmountCents: 6000 });
    expect(s.findBillcomInvoice).toHaveBeenCalledWith({ customerNumber: 'C1', invoiceNumbers: ['W-100532', 'INV-100412'], billcomInvoiceId: null });
    expect(s.create.mock.calls[0][0]).toMatchObject({ amount: 6000 });
    expect(row.amount).toBe(60);
  });

  it('refuses when the amount due changed since staff confirmed (page saw $100, Bill.com now says $60): no row, no Stripe', async () => {
    const s = setup({ lookup: found({ dueAmount: 60 }) });
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow(CHARGE_CHANGED_MESSAGE);
    expect(CHARGE_CHANGED_MESSAGE).toBe('The amount due or card on file changed since you opened this — refresh and review before charging.');
    expect(s.db.tables.card_payments).toHaveLength(0);
    expect(s.create).not.toHaveBeenCalled();
  });

  it('refuses when the card on file changed since staff confirmed: no row, no Stripe', async () => {
    const s = setup();
    await expect(chargeInvoice(s.deps, { ...ARGS, cardId: 'card-old' })).rejects.toThrow(CHARGE_CHANGED_MESSAGE);
    expect(s.db.tables.card_payments).toHaveLength(0);
    expect(s.create).not.toHaveBeenCalled();
  });

  it('refuses when nothing is due (no insert, no Stripe)', async () => {
    const s = setup({ lookup: found({ dueAmount: 0 }) });
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow('Nothing is due on this invoice.');
    expect(s.db.tables.card_payments).toHaveLength(0);
    expect(s.create).not.toHaveBeenCalled();
  });

  it('refuses without permission even if called directly', async () => {
    const s = setup({ canCharge: false });
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow("You don't have permission to charge cards.");
    expect(s.create).not.toHaveBeenCalled();
  });

  it('cents rounding: 1234.56 → 123456', async () => {
    const s = setup({ lookup: found({ dueAmount: 1234.56 }) });
    await chargeInvoice(s.deps, { ...ARGS, expectedAmountCents: 123456 });
    expect(s.create.mock.calls[0][0]).toMatchObject({ amount: 123456 });
  });

  it('creates the PaymentIntent off_session + confirm, with idempotency key = card_payments.id and receipt_email', async () => {
    const s = setup();
    const row = await chargeInvoice(s.deps, ARGS);
    const [params, options] = s.create.mock.calls[0];
    expect(params).toEqual({
      amount: 10000,
      currency: 'usd',
      customer: 'cus_1',
      payment_method: 'pm_1',
      off_session: true,
      confirm: true,
      receipt_email: 'ap@example.com',
      description: 'Invoice INV-100412',
      metadata: { organization_id: 'org-1', bc_customer_number: 'C1', card_payment_id: row.id, invoice_number: 'INV-100412' },
    });
    expect(options).toEqual({ idempotencyKey: row.id });
  });

  it('inserts the full processing row first', async () => {
    const s = setup();
    await chargeInvoice(s.deps, ARGS);
    const insert = s.db.writes.find(([t, op]) => t === 'card_payments' && op === 'insert')?.[2];
    expect(insert).toEqual({
      organization_id: 'org-1', stripe_connection_id: 'sc-1', bc_customer_number: 'C1', sales_order_id: 'so-1',
      bc_invoice_id: INV, billcom_invoice_id: '00eBILL', billcom_customer_id: '0cu1', invoice_number: 'INV-100412',
      amount: 100, currency: 'usd', card_id: 'card-1', status: 'processing', billcom_state: 'not_started',
      charged_by: 'u1', charged_at: NOW.toISOString(),
    });
  });

  it('success → succeeded, then Bill.com recorded, in that order', async () => {
    const s = setup();
    const row = await chargeInvoice(s.deps, ARGS);
    expect(s.log).toEqual(['db:insert:processing', 'stripe', 'db:update:succeeded', 'billcom', 'db:update:recorded']);
    expect(mocks.record.mock.calls[0][1]).toEqual({
      billcomInvoiceId: '00eBILL',
      customerId: '0cu1',
      amount: 100,
      paymentDate: '2026-11-17',
      description: 'Card payment via Stripe pi_1 (visa •••• 4242)',
    });
    expect(row).toMatchObject({
      status: 'succeeded', stripePaymentIntentId: 'pi_1', billcomState: 'recorded', billcomRecordedAt: NOW.toISOString(),
      cardBrand: 'visa', cardLast4: '4242', invoiceNumber: 'INV-100412', bcInvoiceId: INV,
    });
    expect(s.db.tables.card_payments[0].billcom_payment_id).toBe('0pay1');
    // The Bill.com attempt starts with the succeeded write.
    const succeededWrite = s.db.writes.find(([t, op, p]) => t === 'card_payments' && op === 'update' && (p as Row).status === 'succeeded')?.[2];
    expect(succeededWrite).toMatchObject({ billcom_attempt_at: NOW.toISOString() });
  });

  it('Bill.com failure → succeeded + billcom failed, error stored', async () => {
    const s = setup();
    mocks.record.mockRejectedValue(new Error('BDC_1234: not allowed'));
    const row = await chargeInvoice(s.deps, ARGS);
    expect(row).toMatchObject({ status: 'succeeded', billcomState: 'failed', billcomError: 'BDC_1234: not allowed' });
  });

  it('card declined → failed with Stripe’s message, no Bill.com call', async () => {
    const s = setup({
      create: async () => {
        throw stripeError('StripeCardError', 'Your card has insufficient funds.', 'card_declined', { id: 'pi_dec' });
      },
    });
    const row = await chargeInvoice(s.deps, ARGS);
    expect(row).toMatchObject({ status: 'failed', failureMessage: 'Your card has insufficient funds.', stripePaymentIntentId: 'pi_dec', billcomState: 'not_started' });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('authentication_required → failed with the approval message', async () => {
    const s = setup({
      create: async () => {
        throw stripeError('StripeCardError', 'This payment requires authentication.', 'authentication_required');
      },
    });
    const row = await chargeInvoice(s.deps, ARGS);
    expect(AUTH_REQUIRED_MESSAGE).toBe('The bank needs the customer to approve this charge — send a new setup link.');
    expect(row).toMatchObject({ status: 'failed', failureMessage: AUTH_REQUIRED_MESSAGE });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('network error → stays processing, no Bill.com call', async () => {
    const s = setup({
      create: async () => {
        throw stripeError('StripeConnectionError', 'socket hang up');
      },
    });
    const row = await chargeInvoice(s.deps, ARGS);
    expect(row.status).toBe('processing');
    expect(mocks.record).not.toHaveBeenCalled();
    expect(s.log).toEqual(['db:insert:processing', 'stripe']);
  });

  it.each(['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError', 'StripeRateLimitError'])(
    '%s is a definite no-charge → failed with Stripe’s message',
    async (type) => {
      const s = setup({
        create: async () => {
          throw stripeError(type, `${type} message`);
        },
      });
      expect(await chargeInvoice(s.deps, ARGS)).toMatchObject({ status: 'failed', failureMessage: `${type} message` });
      expect(mocks.record).not.toHaveBeenCalled();
    },
  );

  it.each(['StripeAPIError', 'StripeIdempotencyError', undefined])('%s is an unknown outcome → stays processing', async (type) => {
    const s = setup({
      create: async () => {
        throw stripeError(type as string, 'boom');
      },
    });
    expect((await chargeInvoice(s.deps, ARGS)).status).toBe('processing');
  });

  it('Bill.com recorded but saving that fails → not marked Bill.com failed; the error names the Bill.com payment id', async () => {
    const s = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = s.db.failOn!;
    s.db.failOn = (table, op, payload) => {
      base(table, op, payload);
      return table === 'card_payments' && op === 'update' && (payload as Row).billcom_state === 'recorded' ? 'db down' : null;
    };
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow(/0pay1.*Do not press Retry: after 10 minutes use Check status, then "I marked it paid in Bill.com"/);
    const stored = s.db.tables.card_payments[0];
    expect(stored.status).toBe('succeeded');
    expect(stored.billcom_state).toBe('not_started');
    expect(s.db.writes.some(([, , p]) => (p as Row).billcom_state === 'failed')).toBe(false);
  });

  it('second concurrent charge is rejected by the unique index (23505), no Stripe call', async () => {
    const s = setup();
    s.db.failOn = (table, op) => (table === 'card_payments' && op === 'insert' ? { message: 'duplicate key', code: '23505' } : null);
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow(DUPLICATE_CHARGE_MESSAGE);
    expect(DUPLICATE_CHARGE_MESSAGE).toBe('A charge for this invoice is already in progress or needs attention.');
    expect(s.create).not.toHaveBeenCalled();
  });

  it('any other insert failure never calls Stripe', async () => {
    const s = setup();
    s.db.failOn = (table, op) => (table === 'card_payments' && op === 'insert' ? 'db down' : null);
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow('db down');
    expect(s.create).not.toHaveBeenCalled();
  });

  it('refuses a card from a non-default connection', async () => {
    const s = setup({ stripeConnectionId: 'sc-2' });
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow('No card on file — send a setup link from the customer page.');
    expect(s.create).not.toHaveBeenCalled();
  });

  it('refuses when Stripe is off', async () => {
    const s = setup({ stripeConnectionId: null });
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow("Stripe isn't set up.");
  });

  it('refuses a removed card', async () => {
    const s = setup();
    s.db.tables.customer_cards[0].removed_at = '2026-11-10T00:00:00Z';
    await expect(chargeInvoice(s.deps, ARGS)).rejects.toThrow('No card on file');
  });

  it('refuses an unknown invoice', async () => {
    const s = setup();
    await expect(chargeInvoice(s.deps, { ...ARGS, bcInvoiceId: 'nope' })).rejects.toThrow('Invoice not found.');
  });

  it('a requires_payment_method result is failed with Stripe’s last error', async () => {
    const s = setup({ create: async () => ({ id: 'pi_2', status: 'requires_payment_method', last_payment_error: { message: 'Card expired.' } }) });
    const row = await chargeInvoice(s.deps, ARGS);
    expect(row).toMatchObject({ status: 'failed', failureMessage: 'Card expired.', stripePaymentIntentId: 'pi_2' });
  });

  it('a Stripe "processing" result stays processing with the intent id', async () => {
    const s = setup({ create: async () => ({ id: 'pi_3', status: 'processing' }) });
    const row = await chargeInvoice(s.deps, ARGS);
    expect(row).toMatchObject({ status: 'processing', stripePaymentIntentId: 'pi_3' });
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

const intent = (id: string, status: string, over: Row = {}) => ({ id, status, metadata: { card_payment_id: 'cp-1' }, ...over });

describe('checkChargeStatus', () => {
  it('lists the Stripe customer’s intents since just before the charge and settles from the one whose metadata matches', async () => {
    const s = setup({
      tables: { card_payments: [paymentRow()] },
      list: async () => ({ data: [intent('pi_other', 'succeeded', { metadata: { card_payment_id: 'cp-x' } }), intent('pi_9', 'succeeded')], has_more: false }),
    });
    const row = await checkChargeStatus(s.deps, 'cp-1');
    // charged_at 19:59:00Z minus 300 seconds.
    expect(s.list).toHaveBeenCalledWith({ customer: 'cus_1', created: { gte: Date.parse('2026-11-17T19:54:00.000Z') / 1000 }, limit: 100 });
    expect(row).toMatchObject({ status: 'succeeded', stripePaymentIntentId: 'pi_9', billcomState: 'recorded' });
    expect(mocks.record.mock.calls[0][1]).toMatchObject({ amount: 60, description: expect.stringContaining('pi_9') });
    expect(s.create).not.toHaveBeenCalled();
    expect(s.search).not.toHaveBeenCalled();
  });

  it('pages through the list', async () => {
    const s = setup({
      tables: { card_payments: [paymentRow()] },
      list: async (params) =>
        params.starting_after === 'pi_a'
          ? { data: [intent('pi_9', 'succeeded')], has_more: false }
          : { data: [intent('pi_a', 'succeeded', { metadata: {} })], has_more: true },
    });
    expect(await checkChargeStatus(s.deps, 'cp-1')).toMatchObject({ status: 'succeeded', stripePaymentIntentId: 'pi_9' });
    expect(s.list).toHaveBeenCalledTimes(2);
  });

  it('a stored intent id is retrieved directly (no search, no list)', async () => {
    const s = setup({
      tables: { card_payments: [paymentRow({ stripe_payment_intent_id: 'pi_3' })] },
      retrieve: async (id) => intent(id, 'succeeded'),
    });
    expect(await checkChargeStatus(s.deps, 'cp-1')).toMatchObject({ status: 'succeeded', stripePaymentIntentId: 'pi_3', billcomState: 'recorded' });
    expect(s.retrieve).toHaveBeenCalledWith('pi_3');
    expect(s.list).not.toHaveBeenCalled();
    expect(s.search).not.toHaveBeenCalled();
  });

  it('settles a failed intent as failed', async () => {
    const s = setup({
      tables: { card_payments: [paymentRow()] },
      list: async () => ({ data: [intent('pi_9', 'requires_payment_method', { last_payment_error: { message: 'Declined.' } })], has_more: false }),
    });
    expect(await checkChargeStatus(s.deps, 'cp-1')).toMatchObject({ status: 'failed', failureMessage: 'Declined.' });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('nothing in Stripe yet → still processing, flagged not_found', async () => {
    const s = setup({ tables: { card_payments: [paymentRow()] } });
    expect(await checkChargeStatus(s.deps, 'cp-1')).toMatchObject({ status: 'processing', stripeLookup: 'not_found' });
  });

  it('nothing in Stripe long after the attempt → still processing (never auto-failed)', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ charged_at: '2026-11-16T00:00:00.000Z' })] } });
    expect(await checkChargeStatus(s.deps, 'cp-1')).toMatchObject({ status: 'processing', stripeLookup: 'not_found', failureMessage: null });
    expect(s.db.tables.card_payments[0].status).toBe('processing');
  });

  it('uses the Stripe account the charge was made in', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ stripe_connection_id: 'sc-old' })] }, stripeConnectionId: 'sc-1' });
    await checkChargeStatus(s.deps, 'cp-1');
    expect(s.deps.stripeClient).toHaveBeenCalledWith('sc-old');
  });

  it('leaves a settled row alone', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ status: 'failed' })] } });
    expect((await checkChargeStatus(s.deps, 'cp-1')).status).toBe('failed');
    expect(s.list).not.toHaveBeenCalled();
    expect(s.retrieve).not.toHaveBeenCalled();
  });

  it('an interrupted Bill.com record (succeeded + not_started, long ago) becomes billcom failed so staff can retry', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ status: 'succeeded', stripe_payment_intent_id: 'pi_1', charged_at: '2026-11-17T18:00:00.000Z' })] } });
    expect(await checkChargeStatus(s.deps, 'cp-1')).toMatchObject({ billcomState: 'failed', billcomError: expect.stringContaining('interrupted') });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('the interrupted check measures from the Bill.com attempt: charged 20 min ago but attempt 2 min ago is NOT interrupted', async () => {
    const s = setup({
      tables: {
        card_payments: [
          paymentRow({ status: 'succeeded', stripe_payment_intent_id: 'pi_1', charged_at: '2026-11-17T19:40:00.000Z', billcom_attempt_at: '2026-11-17T19:58:00.000Z' }),
        ],
      },
    });
    expect(await checkChargeStatus(s.deps, 'cp-1')).toMatchObject({ billcomState: 'not_started', billcomStuck: false });
    expect(s.db.tables.card_payments[0].billcom_state).toBe('not_started');
    expect(s.db.writes).toHaveLength(0);
  });

  it('an attempt over 10 minutes ago is interrupted, and the message warns to check Bill.com before Retry', async () => {
    const s = setup({
      tables: {
        card_payments: [
          paymentRow({ status: 'succeeded', stripe_payment_intent_id: 'pi_1', charged_at: '2026-11-17T19:40:00.000Z', billcom_attempt_at: '2026-11-17T19:49:00.000Z' }),
        ],
      },
    });
    const row = await checkChargeStatus(s.deps, 'cp-1');
    expect(row.billcomState).toBe('failed');
    expect(row.billcomError).toContain('may already be in Bill.com');
    expect(row.billcomError).toContain('before pressing Retry');
  });

  it('flags a stuck Bill.com record on the row (billcomStuck) so the panel can offer Check status', async () => {
    const { deps } = setup({
      tables: {
        card_payments: [
          paymentRow({ id: 'cp-1', status: 'succeeded', billcom_attempt_at: '2026-11-17T19:49:00.000Z' }),
          paymentRow({ id: 'cp-2', status: 'succeeded', billcom_attempt_at: '2026-11-17T19:58:00.000Z', billcom_invoice_id: 'x2' }),
          paymentRow({ id: 'cp-3', status: 'succeeded', billcom_state: 'recorded', billcom_attempt_at: '2026-11-17T19:00:00.000Z', billcom_invoice_id: 'x3' }),
        ],
      },
    });
    const { payments } = await invoiceChargeView(deps, INV);
    const stuck = Object.fromEntries(payments.map((p) => [p.id, p.billcomStuck]));
    expect(stuck).toEqual({ 'cp-1': true, 'cp-2': false, 'cp-3': false });
  });

  it('is scoped to the org', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ organization_id: 'org-2' })] } });
    await expect(checkChargeStatus(s.deps, 'cp-1')).rejects.toThrow('Card payment not found.');
  });
});

describe('retryBillcomRecord', () => {
  it('records a billcom-failed payment', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ status: 'succeeded', stripe_payment_intent_id: 'pi_1', billcom_state: 'failed', billcom_error: 'x' })] } });
    const row = await retryBillcomRecord(s.deps, 'cp-1');
    expect(row).toMatchObject({ billcomState: 'recorded', billcomError: null });
    expect(mocks.record.mock.calls[0][1]).toMatchObject({ billcomInvoiceId: '00eBILL', customerId: '0cu1', amount: 60, paymentDate: '2026-11-17' });
  });

  it.each([
    ['processing', { status: 'processing' }],
    ['recorded', { status: 'succeeded', billcom_state: 'recorded' }],
    ['recorded manually', { status: 'succeeded', billcom_state: 'recorded_manually' }],
    ['not started', { status: 'succeeded', billcom_state: 'not_started' }],
    ['charge failed', { status: 'failed' }],
  ])('only from billcom failed: refuses %s', async (_n, over) => {
    const s = setup({ tables: { card_payments: [paymentRow(over)] } });
    await expect(retryBillcomRecord(s.deps, 'cp-1')).rejects.toThrow("This payment isn't waiting for a Bill.com retry.");
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('the retry claim sets billcom_attempt_at (so the interrupted check measures from the retry)', async () => {
    const s = setup({
      tables: { card_payments: [paymentRow({ status: 'succeeded', billcom_state: 'failed', billcom_attempt_at: '2026-11-17T18:00:00.000Z' })] },
    });
    await retryBillcomRecord(s.deps, 'cp-1');
    const claim = s.db.writes.find(([t, op, p]) => t === 'card_payments' && op === 'update' && (p as Row).billcom_state === 'not_started')?.[2];
    expect(claim).toEqual({ billcom_state: 'not_started', billcom_error: null, billcom_attempt_at: NOW.toISOString() });
    expect(s.db.tables.card_payments[0].billcom_attempt_at).toBe(NOW.toISOString());
  });

  it('Bill.com recorded but the row changed meanwhile (marked interrupted): logs loudly, notes the payment, keeps billcom failed, surfaces "I marked it paid"', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    errors.mockClear();
    const s = setup({ tables: { card_payments: [paymentRow({ status: 'succeeded', stripe_payment_intent_id: 'pi_1', billcom_state: 'failed' })] } });
    mocks.record.mockImplementation(async () => {
      // Check status marked it interrupted while Bill.com was recording.
      s.db.tables.card_payments[0].billcom_state = 'failed';
      return { paymentId: '0pay9' };
    });
    await expect(retryBillcomRecord(s.deps, 'cp-1')).rejects.toThrow(/Recorded in Bill.com \(payment 0pay9\).*I marked it paid in Bill.com/);
    const stored = s.db.tables.card_payments[0];
    expect(stored).toMatchObject({ billcom_state: 'failed', billcom_payment_id: '0pay9' });
    expect(stored.billcom_error).toContain('0pay9');
    expect(stored.billcom_error).toContain('Do not press Retry');
    expect(errors.mock.calls.map((c) => String(c[0])).join('\n')).toContain('BILL.COM RECORDED BUT NOT SAVED');
    errors.mockRestore();
  });

  it('a second failure stays failed with the new error', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ status: 'succeeded', billcom_state: 'failed', billcom_error: 'old' })] } });
    mocks.record.mockRejectedValue(new Error('new'));
    expect(await retryBillcomRecord(s.deps, 'cp-1')).toMatchObject({ billcomState: 'failed', billcomError: 'new' });
  });

  it('refuses when Bill.com is not connected, leaving the row failed', async () => {
    const s = setup({ billcom: false, tables: { card_payments: [paymentRow({ status: 'succeeded', billcom_state: 'failed', billcom_error: 'old' })] } });
    await expect(retryBillcomRecord(s.deps, 'cp-1')).rejects.toThrow("Bill.com isn't connected.");
    expect(s.db.tables.card_payments[0].billcom_state).toBe('failed');
  });
});

describe('markRecordedManually', () => {
  it('sets recorded_manually with who and when', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ status: 'succeeded', billcom_state: 'failed', billcom_error: 'x' })] } });
    const row = await markRecordedManually(s.deps, 'cp-1', 'u2');
    expect(row).toMatchObject({ billcomState: 'recorded_manually', recordedManuallyBy: 'u2', billcomRecordedAt: NOW.toISOString() });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ['processing', { status: 'processing' }],
    ['charge failed', { status: 'failed' }],
    ['already recorded', { status: 'succeeded', billcom_state: 'recorded' }],
  ])('refuses %s', async (_n, over) => {
    const s = setup({ tables: { card_payments: [paymentRow(over)] } });
    await expect(markRecordedManually(s.deps, 'cp-1', 'u2')).rejects.toThrow('Only a charged payment that Bill.com failed to record can be marked paid.');
  });
});

describe('markNotCharged', () => {
  // Exactly NOT_CHARGED_MIN_AGE_MS before NOW.
  const OLD = { charged_at: '2026-11-17T19:50:00.000Z' };

  it('the minimum age is 10 minutes', () => {
    expect(NOT_CHARGED_MIN_AGE_MS).toBe(10 * 60 * 1000);
  });

  it('refused at 9m59s after the attempt: no Stripe lookup, no write', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ charged_at: '2026-11-17T19:50:01.000Z' })] } });
    await expect(markNotCharged(s.deps, 'cp-1', 'u2')).rejects.toThrow(
      'Wait at least 10 minutes after the charge attempt before marking it as not charged.',
    );
    expect(s.list).not.toHaveBeenCalled();
    expect(s.retrieve).not.toHaveBeenCalled();
    expect(s.db.writes).toHaveLength(0);
    expect(s.db.tables.card_payments[0].status).toBe('processing');
  });

  it('at 10m, with nothing in Stripe → failed with the message; who and when in their own columns', async () => {
    const s = setup({ tables: { card_payments: [paymentRow(OLD)] } });
    const row = await markNotCharged(s.deps, 'cp-1', 'u2');
    expect(MARKED_NOT_CHARGED_MESSAGE).toBe('Marked as not charged by staff after checking Stripe.');
    expect(row.status).toBe('failed');
    expect(row.failureMessage).toBe(MARKED_NOT_CHARGED_MESSAGE);
    expect(row).toMatchObject({ notChargedBy: 'u2', notChargedAt: NOW.toISOString() });
    expect(s.db.tables.card_payments[0]).toMatchObject({ not_charged_by: 'u2', not_charged_at: NOW.toISOString() });
    expect(s.list).toHaveBeenCalledTimes(1);
  });

  it('refuses when Stripe has a succeeded intent, and settles the row from it instead', async () => {
    const s = setup({
      tables: { card_payments: [paymentRow(OLD)] },
      list: async () => ({ data: [intent('pi_9', 'succeeded')], has_more: false }),
    });
    await expect(markNotCharged(s.deps, 'cp-1', 'u2')).rejects.toThrow('Stripe has a payment for this charge');
    expect(s.db.tables.card_payments[0]).toMatchObject({ status: 'succeeded', stripe_payment_intent_id: 'pi_9' });
  });

  it('refuses when a stored intent is still processing in Stripe', async () => {
    const s = setup({ tables: { card_payments: [paymentRow({ ...OLD, stripe_payment_intent_id: 'pi_3' })] }, retrieve: async (id) => intent(id, 'processing') });
    await expect(markNotCharged(s.deps, 'cp-1', 'u2')).rejects.toThrow('Stripe has a payment for this charge');
    expect(s.db.tables.card_payments[0].status).toBe('processing');
  });

  it.each(['requires_payment_method', 'canceled'])('a %s intent settles the row as failed and returns it (no error)', async (status) => {
    const s = setup({
      tables: { card_payments: [paymentRow(OLD)] },
      list: async () => ({ data: [intent('pi_9', status, { last_payment_error: { message: 'Declined.' } })], has_more: false }),
    });
    const row = await markNotCharged(s.deps, 'cp-1', 'u2');
    expect(row).toMatchObject({ status: 'failed', failureMessage: 'Declined.', stripePaymentIntentId: 'pi_9' });
  });

  it.each([
    ['succeeded', { status: 'succeeded' }],
    ['failed', { status: 'failed' }],
  ])('refuses from %s', async (_n, over) => {
    const s = setup({ tables: { card_payments: [paymentRow({ ...OLD, ...over })] } });
    await expect(markNotCharged(s.deps, 'cp-1', 'u2')).rejects.toThrow('Only a charge still being checked with Stripe can be marked as not charged.');
    expect(s.list).not.toHaveBeenCalled();
  });
});

describe('a charge that succeeds after the row was marked failed', () => {
  it('logs loudly and notes it on the row, without flipping status or recording in Bill.com', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    errors.mockClear();
    const tables: Record<string, Row[]> = { card_payments: [] };
    const s = setup({
      tables,
      create: async () => {
        // Staff marked it not charged while the create was still in flight.
        tables.card_payments[0].status = 'failed';
        tables.card_payments[0].failure_message = 'Marked as not charged by staff after checking Stripe.';
        return { id: 'pi_late', status: 'succeeded' };
      },
    });
    const row = await chargeInvoice(s.deps, ARGS);
    expect(row.status).toBe('failed');
    expect(row.failureMessage).toBe(
      'Marked as not charged by staff after checking Stripe. Stripe later reported this charge succeeded (pi_late) — check Stripe and refund or reconcile.',
    );
    expect(mocks.record).not.toHaveBeenCalled();
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('CARD WAS CHARGED');
    expect(logged).toContain(row.id);
    expect(logged).toContain('pi_late');
    expect(logged).toContain('100');
    errors.mockRestore();
  });

  it('a lost transition to an already-succeeded row stays quiet', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    errors.mockClear();
    const s = setup({
      tables: { card_payments: [paymentRow({ status: 'succeeded', stripe_payment_intent_id: 'pi_9', billcom_state: 'recorded' })] },
      list: async () => ({ data: [intent('pi_9', 'succeeded')], has_more: false }),
    });
    // Simulate a racing settle: the row is processing when read, succeeded by the time we write.
    s.db.tables.card_payments[0].status = 'processing';
    const base = s.db.failOn!;
    s.db.failOn = (table, op, payload) => {
      if (table === 'card_payments' && op === 'update' && (payload as Row).status === 'succeeded') s.db.tables.card_payments[0].status = 'succeeded';
      return base(table, op, payload);
    };
    // The fake applies the guard after failOn runs, so the processing→succeeded update matches nothing.
    await checkChargeStatus(s.deps, 'cp-1');
    expect(errors).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe('invoiceChargeView names', () => {
  it('resolves charged-by and recorded-by user ids to display names (org-scoped)', async () => {
    const { deps } = setup({
      tables: {
        card_payments: [paymentRow({ status: 'succeeded', billcom_state: 'recorded_manually', charged_by: 'u1', recorded_manually_by: 'u2' })],
        users: [
          { id: 'u1', organization_id: 'org-1', display_name: 'Jane Doe', email: 'j@x.com' },
          { id: 'u2', organization_id: 'org-1', display_name: '', email: 'sam@x.com' },
          { id: 'u3', organization_id: 'org-2', display_name: 'Other Org', email: 'o@x.com' },
        ],
      },
    });
    const { payments } = await invoiceChargeView(deps, INV);
    expect(payments[0]).toMatchObject({ chargedByName: 'Jane Doe', recordedManuallyByName: 'sam@x.com' });
  });

  it('resolves who marked it not charged to a display name', async () => {
    const { deps } = setup({
      tables: {
        card_payments: [paymentRow({ status: 'failed', not_charged_by: 'u2', not_charged_at: NOW.toISOString() })],
        users: [{ id: 'u2', organization_id: 'org-1', display_name: 'Sam Lee', email: 'sam@x.com' }],
      },
    });
    const { payments } = await invoiceChargeView(deps, INV);
    expect(payments[0]).toMatchObject({ notChargedBy: 'u2', notChargedByName: 'Sam Lee', notChargedAt: NOW.toISOString() });
  });

  it('leaves names off when the user is unknown', async () => {
    const { deps } = setup({ tables: { card_payments: [paymentRow({ charged_by: 'ghost' })], users: [] } });
    const { payments } = await invoiceChargeView(deps, INV);
    expect(payments[0].chargedByName).toBeUndefined();
  });
});
