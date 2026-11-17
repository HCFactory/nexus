import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/app/actions/customerCards', () => ({
  createCardSetupLink: mocks.create,
  cancelCardSetupLink: mocks.cancel,
  removeCustomerCard: mocks.remove,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { CardOnFileCard } from './CardOnFileCard';
import type { CustomerCardView } from '@/types/stripe';

const base: CustomerCardView = { stripe: 'ready', card: null, openLink: null, canEdit: true };
const visa = { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028, savedAt: '2026-11-16T12:00:00Z' };

const ui = (view: Partial<CustomerCardView> = {}) =>
  render(<CardOnFileCard customerNumber="C1" customerEmail="c@x.com" view={{ ...base, ...view }} />);

afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});

describe('CardOnFileCard', () => {
  it('no card shows the empty state and both buttons', () => {
    ui();
    expect(screen.getByText('No card on file.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Email link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('card shows the label and replace/remove buttons', () => {
    ui({ card: visa });
    expect(screen.getByText(/Visa •••• 4242, exp 08\/28/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send new link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove card' })).toBeTruthy();
  });

  it('open link shows sent/expires and Cancel link', () => {
    ui({ openLink: { createdAt: '2026-11-16T12:00:00Z', expiresAt: '2026-11-30T12:00:00Z', emailedTo: null } });
    expect(screen.getByText('Link sent Nov 16 · expires Nov 30')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel link' }));
    expect(mocks.cancel).toHaveBeenCalledWith('C1');
  });

  it('Copy writes the URL to the clipboard and says when it expires', async () => {
    mocks.create.mockResolvedValue({ url: 'https://app/card-setup/tok', expiresAt: '2026-11-30T12:00:00Z' });
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByText('Copied — expires Nov 30')).toBeTruthy());
    expect(mocks.create).toHaveBeenCalledWith('C1', { email: null });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://app/card-setup/tok');
  });

  it('Email opens a dialog prefilled with the customer email and sends', async () => {
    mocks.create.mockResolvedValue({ url: 'u', expiresAt: '2026-11-30T12:00:00Z' });
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    const input = (await screen.findByLabelText('Email address')) as HTMLInputElement;
    expect(input.value).toBe('c@x.com');
    fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('C1', { email: 'c@x.com' }));
  });

  it('shows the error when sending fails', async () => {
    mocks.create.mockRejectedValue(new Error('Enter a valid email address.'));
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Email link' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send link' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
  });

  it('stripe off explains where to set it up', () => {
    ui({ stripe: 'off' });
    expect(screen.getByText("Stripe isn't set up — an admin can add it in Admin.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('view-only hides the buttons', () => {
    ui({ canEdit: false, card: visa });
    expect(screen.queryByRole('button', { name: 'Remove card' })).toBeNull();
  });
});
