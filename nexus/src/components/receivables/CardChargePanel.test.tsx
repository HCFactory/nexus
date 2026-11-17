import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  charge: vi.fn(),
  retry: vi.fn(),
  manual: vi.fn(),
  check: vi.fn(),
  notCharged: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/app/actions/cardPayments', () => ({
  chargeInvoiceCard: mocks.charge,
  retryCardPaymentBillcom: mocks.retry,
  markCardPaymentRecordedManually: mocks.manual,
  checkCardPaymentStatus: mocks.check,
  markCardPaymentNotCharged: mocks.notCharged,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

import { CardChargePanel } from './CardChargePanel';
import type { CardLabel, CardPaymentRow, ChargeEligibility } from '@/types/stripe';

const card: CardLabel = {
  id: 'c1', brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028, savedAt: '2026-11-01T00:00:00Z',
  stripePaymentMethodId: 'pm_1', stripeConnectionId: 'sc1',
};
const ok: ChargeEligibility = { ok: true, amount: 1234.56, dueDate: '2026-11-01' };
const payment = (over: Partial<CardPaymentRow> = {}): CardPaymentRow => ({
  id: 'p1', bcInvoiceId: 'bc1', invoiceNumber: '1043', billcomInvoiceId: 'b1', amount: 50, currency: 'usd',
  status: 'succeeded', failureMessage: null, stripePaymentIntentId: 'pi_1', billcomState: 'recorded',
  billcomError: null, billcomRecordedAt: '2026-11-10T00:00:00Z', chargedAt: '2026-11-10T12:00:00Z',
  chargedBy: 'u1', recordedManuallyBy: null, cardBrand: 'visa', cardLast4: '4242', ...over,
});

const ui = (over: Partial<React.ComponentProps<typeof CardChargePanel>> = {}) =>
  render(
    <CardChargePanel bcInvoiceId="bc1" invoiceNumber="1043" eligibility={ok} card={card} payments={[]} canCharge {...over} />,
  );

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('CardChargePanel', () => {
  it('eligible: Charge card opens the exact confirm text and Confirm charges', async () => {
    mocks.charge.mockResolvedValue(payment());
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Charge card' }));
    expect(screen.getByText('Charge Visa •••• 4242 $1,234.56 for Invoice 1043?')).toBeTruthy();
    expect(mocks.charge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.charge).toHaveBeenCalledWith('bc1'));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it('not eligible: shows the reason and no button', () => {
    ui({ eligibility: { ok: false, reason: 'No card on file — send a setup link from the customer page' } });
    expect(screen.getByText('No card on file — send a setup link from the customer page')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Charge card' })).toBeNull();
  });

  it('without the permission there is no Charge card button', () => {
    ui({ canCharge: false });
    expect(screen.queryByRole('button', { name: 'Charge card' })).toBeNull();
  });

  it('lists payments: date, amount, card, who, Stripe and Bill.com status', () => {
    ui({ payments: [payment()] });
    expect(screen.getByText('Nov 10, 2026')).toBeTruthy();
    expect(screen.getByText('$50.00')).toBeTruthy();
    expect(screen.getByText('Visa •••• 4242')).toBeTruthy();
    expect(screen.getByText('By staff')).toBeTruthy();
    expect(screen.getByText('Charged')).toBeTruthy();
    expect(screen.getByText('Recorded in Bill.com')).toBeTruthy();
  });

  it('shows who charged by name and who marked it paid manually', () => {
    ui({
      payments: [
        payment({ chargedByName: 'Jane Doe', billcomState: 'recorded_manually', recordedManuallyBy: 'u2', recordedManuallyByName: 'Sam Lee' }),
      ],
    });
    expect(screen.getByText('By Jane Doe')).toBeTruthy();
    expect(screen.getByText('Marked paid in Bill.com by Sam Lee')).toBeTruthy();
  });

  it('billcom failed: shows the state, hint, Retry, and a confirmed manual mark', async () => {
    mocks.retry.mockResolvedValue(payment());
    mocks.manual.mockResolvedValue(payment());
    ui({ payments: [payment({ billcomState: 'failed', billcomError: 'Bill.com said no' })] });
    expect(screen.getByText('Charged in Stripe — Bill.com not updated')).toBeTruthy();
    expect(
      screen.getByText('If the payment already shows in Bill.com, use "I marked it paid in Bill.com" instead of Retry.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Bill.com' }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith('p1'));

    fireEvent.click(screen.getByRole('button', { name: 'I marked it paid in Bill.com' }));
    expect(mocks.manual).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.manual).toHaveBeenCalledWith('p1'));
  });

  it('processing: shows Checking with Stripe… and Check status', async () => {
    mocks.check.mockResolvedValue(payment({ status: 'succeeded' }));
    ui({ payments: [payment({ status: 'processing', billcomState: 'not_started' })] });
    expect(screen.getByText('Checking with Stripe…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(mocks.check).toHaveBeenCalledWith('p1'));
    expect(screen.queryByRole('button', { name: 'Mark as not charged' })).toBeNull();
  });

  it('processing + not_found: offers Mark as not charged with confirm; shows server errors', async () => {
    mocks.check.mockResolvedValue(payment({ status: 'processing', billcomState: 'not_started', stripeLookup: 'not_found' }));
    mocks.notCharged.mockRejectedValue(new Error('Wait at least 10 minutes after the charge attempt before marking it as not charged.'));
    ui({ payments: [payment({ status: 'processing', billcomState: 'not_started' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await screen.findByText('No charge found in Stripe yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Mark as not charged' }));
    expect(screen.getByText('Only do this after checking the Stripe dashboard. Mark this charge as not charged?')).toBeTruthy();
    expect(mocks.notCharged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.notCharged).toHaveBeenCalledWith('p1'));
    expect((await screen.findByRole('alert')).textContent).toContain('Wait at least 10 minutes');
  });

  it('charge error from the server is shown inline', async () => {
    mocks.charge.mockRejectedValue(new Error('A charge for this invoice is already in progress or needs attention.'));
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Charge card' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A charge for this invoice is already in progress or needs attention.');
  });

  it('disables the buttons while a request is in flight (no double submit)', async () => {
    let release: (v: CardPaymentRow) => void = () => {};
    mocks.charge.mockReturnValue(new Promise<CardPaymentRow>((r) => { release = r; }));
    ui();
    fireEvent.click(screen.getByRole('button', { name: 'Charge card' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Charge card' }) as HTMLButtonElement).disabled).toBe(true));
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    release(payment());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Charge card' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
