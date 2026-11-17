import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: { canChargeSavedCards: true },
  charge: vi.fn(),
  retry: vi.fn(),
  manual: vi.fn(),
  notCharged: vi.fn(),
  check: vi.fn(),
  view: vi.fn(),
  getPage: vi.fn(),
  resolveStripe: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/auth/currentUserAccess', () => ({
  requireOrganizationContext: async () => ({ orgId: 'org-1', user: { id: 'u1' }, access: mocks.access }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/stripe/connection', () => ({
  resolveDefaultStripeConnection: mocks.resolveStripe,
  createStripeForConnection: vi.fn(),
}));
vi.mock('@/lib/billcom/customerSyncHooks', () => ({ resolveBillcomConnection: vi.fn(async () => null) }));
vi.mock('@/lib/billcom/connection', () => ({ createBillcomClientForConnection: vi.fn() }));
vi.mock('@/lib/receivables/salesInvoicePage', () => ({
  getSalesInvoicePage: mocks.getPage,
  findBillcomInvoiceForCharge: vi.fn(),
}));
vi.mock('@/lib/stripe/chargeInvoice', () => ({
  chargeInvoice: mocks.charge,
  retryBillcomRecord: mocks.retry,
  markRecordedManually: mocks.manual,
  markNotCharged: mocks.notCharged,
  checkChargeStatus: mocks.check,
  invoiceChargeView: mocks.view,
}));

import {
  chargeInvoiceCard,
  checkCardPaymentStatus,
  getInvoiceChargeView,
  markCardPaymentNotCharged,
  markCardPaymentRecordedManually,
  retryCardPaymentBillcom,
} from './cardPayments';

const INV = '143fbb46-e8e0-f111-84e4-7ced8d88ddac';
const CP = '7aa0c3d1-0000-4000-8000-000000000415';
const ROW = { id: CP, bcInvoiceId: INV, status: 'succeeded' };
const CONFIRMED = { expectedAmountCents: 10000, cardId: 'card-1' };

beforeEach(() => {
  mocks.access.canChargeSavedCards = true;
  for (const m of [mocks.charge, mocks.retry, mocks.manual, mocks.check, mocks.notCharged]) m.mockReset().mockResolvedValue(ROW);
  mocks.view.mockReset().mockResolvedValue({ eligibility: { ok: false, reason: 'x' }, card: null, payments: [] });
  mocks.resolveStripe.mockReset().mockResolvedValue({ id: 'sc-1', enabled: true, livemode: false });
  mocks.getPage.mockReset().mockResolvedValue({
    invoice: { bc_invoice_id: INV, customer_number: 'C1', bc_invoice_number: 'INV-1', external_document_number: 'W-1' },
    salesOrder: { id: 'so-1', bcOrderNumber: 'W-1', billcomInvoiceId: '00e1' },
  });
});

describe('permission enforced on every mutating action', () => {
  const actions: [string, () => Promise<unknown>, ReturnType<typeof vi.fn>][] = [
    ['chargeInvoiceCard', () => chargeInvoiceCard(INV, CONFIRMED), mocks.charge],
    ['retryCardPaymentBillcom', () => retryCardPaymentBillcom(CP), mocks.retry],
    ['markCardPaymentRecordedManually', () => markCardPaymentRecordedManually(CP), mocks.manual],
    ['checkCardPaymentStatus', () => checkCardPaymentStatus(CP), mocks.check],
    ['markCardPaymentNotCharged', () => markCardPaymentNotCharged(CP), mocks.notCharged],
  ];

  it.each(actions)('%s refuses without Charge saved cards', async (_n, run, impl) => {
    mocks.access.canChargeSavedCards = false;
    await expect(run()).rejects.toThrow("You don't have permission to charge cards.");
    expect(impl).not.toHaveBeenCalled();
  });

  it.each(actions)('%s runs and revalidates the invoice page with permission', async (_n, run, impl) => {
    expect(await run()).toEqual(ROW);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledWith(`/receivables/invoices/${INV}`);
  });
});

it('the read is allowed without the charge permission (the view says why not)', async () => {
  mocks.access.canChargeSavedCards = false;
  await getInvoiceChargeView(INV);
  expect(mocks.view).toHaveBeenCalledTimes(1);
  expect(mocks.view.mock.calls[0][0]).toMatchObject({ canCharge: false });
});

it('rejects a card payment id that is not a UUID', async () => {
  await expect(retryCardPaymentBillcom("x' or 1=1")).rejects.toThrow('Card payment not found.');
  expect(mocks.retry).not.toHaveBeenCalled();
});

it('chargeInvoiceCard passes the current user and the default Stripe connection', async () => {
  await chargeInvoiceCard(INV, CONFIRMED);
  const [deps, args] = mocks.charge.mock.calls[0];
  expect(args).toEqual({ bcInvoiceId: INV, userId: 'u1', expectedAmountCents: 10000, cardId: 'card-1' });
  expect(deps).toMatchObject({ orgId: 'org-1', canCharge: true, stripeConnectionId: 'sc-1' });
  expect(await deps.loadInvoice(INV)).toEqual({
    bcInvoiceId: INV,
    customerNumber: 'C1',
    invoiceNumber: 'INV-1',
    invoiceNumbers: ['W-1', 'INV-1'],
    salesOrderId: 'so-1',
    billcomInvoiceId: '00e1',
  });
});

it('chargeInvoiceCard refuses without the confirmed amount and card', async () => {
  await expect(chargeInvoiceCard(INV, { expectedAmountCents: 1.5, cardId: 'card-1' })).rejects.toThrow('Refresh and review before charging.');
  await expect(chargeInvoiceCard(INV, undefined as never)).rejects.toThrow('Refresh and review before charging.');
  expect(mocks.charge).not.toHaveBeenCalled();
});

it('a disabled Stripe connection is passed as off', async () => {
  mocks.resolveStripe.mockResolvedValue({ id: 'sc-1', enabled: false, livemode: false });
  await chargeInvoiceCard(INV, CONFIRMED);
  expect(mocks.charge.mock.calls[0][0]).toMatchObject({ stripeConnectionId: null });
});

it('markCardPaymentNotCharged passes the current user', async () => {
  await markCardPaymentNotCharged(CP);
  expect(mocks.notCharged.mock.calls[0].slice(1)).toEqual([CP, 'u1']);
});
