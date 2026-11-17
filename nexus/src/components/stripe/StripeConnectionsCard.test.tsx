import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const summary = {
  id: 'c1',
  displayName: 'Main Stripe',
  isEnabled: true,
  isDefault: true,
  livemode: false,
  stripeAccountId: 'acct_1',
  hasCredentials: true,
  hasWebhookSecret: true,
};
const actions = vi.hoisted(() => ({
  listStripeConnections: vi.fn(),
  saveStripeConnection: vi.fn(async () => 'new-1'),
  deleteStripeConnection: vi.fn(),
  setStripeConnectionEnabled: vi.fn(),
  testStripeConnection: vi.fn(),
}));
vi.mock('@/app/actions/stripe', () => actions);

import { StripeConnectionsCard } from './StripeConnectionsCard';

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nexus.example.com');
  actions.listStripeConnections.mockResolvedValue([summary]);
});

describe('StripeConnectionsCard', () => {
  it('lists connections with a Test badge and the webhook URL', async () => {
    render(<StripeConnectionsCard />);
    await flush();
    expect(screen.getByText('Main Stripe')).toBeTruthy();
    expect(screen.getByText('Test')).toBeTruthy();
    expect(screen.getByText('https://nexus.example.com/api/stripe/webhook/c1')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('shows a Live badge for a live connection', async () => {
    actions.listStripeConnections.mockResolvedValue([{ ...summary, livemode: true }]);
    render(<StripeConnectionsCard />);
    await flush();
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('key inputs are password-type and never prefilled on edit', async () => {
    render(<StripeConnectionsCard />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sk = document.getElementById('stripeSecretKey') as HTMLInputElement;
    const wh = document.getElementById('stripeWebhookSecret') as HTMLInputElement;
    expect(sk.type).toBe('password');
    expect(wh.type).toBe('password');
    expect(sk.value).toBe('');
    expect(wh.value).toBe('');
  });

  it('sends typed keys on save', async () => {
    actions.listStripeConnections.mockResolvedValue([]);
    render(<StripeConnectionsCard />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '+ New Connection' }));
    fireEvent.change(document.getElementById('stripeDisplayName')!, { target: { value: 'Main' } });
    fireEvent.change(document.getElementById('stripeSecretKey')!, { target: { value: 'sk_test_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Connection' }));
    await flush();
    expect(actions.saveStripeConnection).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Main', secretKey: 'sk_test_1' }),
    );
  });
});
