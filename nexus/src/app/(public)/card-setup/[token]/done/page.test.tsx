import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findLink: vi.fn(),
  createStripe: vi.fn(),
  saveCard: vi.fn(),
}));
vi.mock('@/lib/stripe/setupLinks', () => ({ findSetupLinkByToken: mocks.findLink }));
vi.mock('@/lib/stripe/connection', () => ({ createStripeForConnection: mocks.createStripe }));
vi.mock('@/lib/stripe/saveCard', () => ({ saveCardFromCheckoutSession: mocks.saveCard }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({})) }));

import CardSetupDonePage from './page';

const link = (over: Record<string, unknown> = {}) => ({
  id: 'link-1', organization_id: 'org-1', stripe_connection_id: 'conn-1', bc_customer_number: 'C100',
  stripe_checkout_session_id: 'cs_1', completed_at: null, canceled_at: null, ...over,
});

async function open(sessionId = 'cs_1') {
  render(await CardSetupDonePage({ params: Promise.resolve({ token: 't' }), searchParams: Promise.resolve({ session_id: sessionId }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createStripe.mockResolvedValue({});
  mocks.saveCard.mockResolvedValue({ brand: 'visa', last4: '4242' });
});

describe('card setup done page', () => {
  it('a cancelled or replaced link says no longer valid and never calls Stripe', async () => {
    mocks.findLink.mockResolvedValue(link({ canceled_at: '2026-11-17T00:00:00Z' }));
    await open();
    expect(screen.getByText('This link is no longer valid — please contact us.')).toBeTruthy();
    expect(mocks.createStripe).not.toHaveBeenCalled();
    expect(mocks.saveCard).not.toHaveBeenCalled();
  });

  it('its own session saves the card', async () => {
    mocks.findLink.mockResolvedValue(link());
    await open();
    expect(mocks.saveCard).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', connectionId: 'conn-1' }), 'cs_1');
  });
});
