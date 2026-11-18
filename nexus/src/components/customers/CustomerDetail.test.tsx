import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessCentralCustomer } from '@/types/database';
import { CustomerDetail } from './CustomerDetail';

const actions = vi.hoisted(() => ({ createCustomerAction: vi.fn(), updateCustomerAction: vi.fn(), deleteCustomerAction: vi.fn() }));
const bc = vi.hoisted(() => ({ retryCustomerPush: vi.fn() }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/app/actions/customerEditing', () => actions);
vi.mock('@/app/actions/billcomCustomers', () => bc);
vi.mock('@/app/actions/shipToAddresses', () => ({ saveShipToAction: vi.fn(), deleteShipToAction: vi.fn(), setDefaultShipToAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

const customer = { id: 'c1', display_name: 'Acme', bc_customer_number: 'C1', balance: 0 } as unknown as BusinessCentralCustomer;
const billcom = (over: Record<string, unknown> = {}) => ({
  on: true, isAdmin: false, canRetry: true, pendingCount: 0,
  links: { C1: { status: 'failed' as const, lastError: 'The email address is not valid' } }, ...over,
});
const renderDetail = (b: ReturnType<typeof billcom>) =>
  render(<CustomerDetail customer={customer} invoices={[]} ledgerEntries={[]} billcom={b} />);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CustomerDetail Bill.com', () => {
  it('shows status, last error and the CC note', () => {
    renderDetail(billcom());
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('The email address is not valid')).toBeInTheDocument();
    expect(screen.getByText("Bill.com has no CC email field, so the CC address isn't sent.")).toBeInTheDocument();
  });

  it('Retry calls retryCustomerPush and shows a non-synced message', async () => {
    bc.retryCustomerPush.mockResolvedValue({ ok: true, billcom: { status: 'failed', message: 'Still broken' } });
    renderDetail(billcom());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bc.retryCustomerPush).toHaveBeenCalledWith('C1'));
    expect(await screen.findByText(/Still broken/)).toBeInTheDocument();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it('hides Retry without permission', () => {
    renderDetail(billcom({ canRetry: false }));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says not sent yet when there is no link', () => {
    renderDetail(billcom({ links: {} }));
    expect(screen.getByText('Not sent yet')).toBeInTheDocument();
  });

  it('shows nothing about Bill.com when it is off', () => {
    renderDetail(billcom({ on: false }));
    expect(screen.queryByText(/Bill.com/)).toBeNull();
  });
});

describe('CustomerDetail billing address', () => {
  it('shows the address fields under a Billing address heading', () => {
    renderDetail(billcom());
    const card = screen.getByText('Billing address').closest('div')!;
    for (const l of ['Address', 'City / State / Postal', 'Country']) expect(within(card.parentElement!).getByText(l)).toBeInTheDocument();
  });
});

describe('CustomerDetail note after create', () => {
  it('shows the note it was opened with', () => {
    render(<CustomerDetail customer={customer} invoices={[]} ledgerEntries={[]} initialNotice="Bill.com is turned off." />);
    expect(screen.getByText('Bill.com is turned off.')).toBeInTheDocument();
  });
});
