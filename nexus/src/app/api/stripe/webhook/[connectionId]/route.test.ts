import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  connection: null as null | { id: string; organization_id: string },
  constructEvent: vi.fn(),
  getWebhookSecret: vi.fn(),
  createStripeForConnection: vi.fn(),
  saveCardFromCheckoutSession: vi.fn(),
}));

vi.mock('stripe', () => ({ default: { webhooks: { constructEvent: m.constructEvent } } }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: m.connection, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/stripe/connection', () => ({
  getWebhookSecret: m.getWebhookSecret,
  createStripeForConnection: m.createStripeForConnection,
}));
vi.mock('@/lib/stripe/saveCard', () => ({ saveCardFromCheckoutSession: m.saveCardFromCheckoutSession }));

import { POST } from './route';

const CONN = '11111111-2222-4333-8444-555555555555';
const stripeClient = { tag: 'stripe-client' };

function call(body = '{"id":"evt_1"}', sig: string | null = 't=1,v1=abc', id = CONN) {
  const headers = new Headers();
  if (sig) headers.set('stripe-signature', sig);
  const req = new Request(`https://nexus.example.com/api/stripe/webhook/${id}`, { method: 'POST', body, headers });
  return POST(req, { params: Promise.resolve({ connectionId: id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.connection = { id: CONN, organization_id: 'org-1' };
  m.getWebhookSecret.mockResolvedValue('whsec_test');
  m.createStripeForConnection.mockResolvedValue(stripeClient);
  m.saveCardFromCheckoutSession.mockResolvedValue({ brand: 'visa', last4: '4242' });
});

describe('POST /api/stripe/webhook/[connectionId]', () => {
  it('unknown connection id → 404', async () => {
    m.connection = null;
    const res = await call();
    expect(res.status).toBe(404);
    expect(m.constructEvent).not.toHaveBeenCalled();
  });

  it('malformed connection id → 404', async () => {
    const res = await call(undefined, undefined, 'not-a-uuid');
    expect(res.status).toBe(404);
  });

  it('bad signature → 400', async () => {
    m.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const res = await call();
    expect(res.status).toBe(400);
    expect(m.saveCardFromCheckoutSession).not.toHaveBeenCalled();
  });

  it('missing signature → 400', async () => {
    const res = await call(undefined, null);
    expect(res.status).toBe(400);
    expect(m.constructEvent).not.toHaveBeenCalled();
  });

  it('checkout.session.completed → saves card, 200', async () => {
    m.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', mode: 'setup' } },
    });
    const res = await call('raw-body');
    expect(res.status).toBe(200);
    expect(m.constructEvent).toHaveBeenCalledWith('raw-body', 't=1,v1=abc', 'whsec_test');
    expect(m.createStripeForConnection).toHaveBeenCalledWith(expect.anything(), 'org-1', CONN);
    expect(m.saveCardFromCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', connectionId: CONN, stripe: stripeClient }),
      'cs_1',
    );
  });

  it('other event → 200, no save', async () => {
    m.constructEvent.mockReturnValue({ type: 'customer.updated', data: { object: { id: 'cus_1' } } });
    const res = await call();
    expect(res.status).toBe(200);
    expect(m.saveCardFromCheckoutSession).not.toHaveBeenCalled();
  });

  it('save failure → 500 so Stripe retries', async () => {
    m.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', mode: 'setup' } },
    });
    m.saveCardFromCheckoutSession.mockRejectedValue(new Error('db down'));
    const res = await call();
    expect(res.status).toBe(500);
  });
});
