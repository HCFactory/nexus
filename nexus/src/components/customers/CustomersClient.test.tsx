import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessCentralCustomer } from '@/types/database';
import { CustomersClient } from './CustomersClient';

const actions = vi.hoisted(() => ({ createCustomerAction: vi.fn(), updateCustomerAction: vi.fn(), deleteCustomerAction: vi.fn() }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/app/actions/customerEditing', () => actions);
const sync = vi.hoisted(() => ({ syncBusinessCentralReceivables: vi.fn() }));
const bc = vi.hoisted(() => ({ previewInitialPush: vi.fn(), confirmInitialPush: vi.fn(), runPendingPush: vi.fn() }));
vi.mock('@/app/actions/businessCentralReceivables', () => sync);
vi.mock('@/app/actions/billcomCustomers', () => bc);
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

const customers = [
  { id: 'c1', display_name: 'Acme', bc_customer_number: 'C1', email: null, city: null, currency_code: null, balance: 0 },
] as unknown as BusinessCentralCustomer[];
const edit = { canEdit: true, templates: [], selectOptions: {} };

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('CustomersClient editing', () => {
  it('hides New customer, Edit and Delete without canEditCustomers', () => {
    render(<CustomersClient customers={customers} canSync={false} edit={{ ...edit, canEdit: false }} />);
    expect(screen.queryByRole('button', { name: /new customer/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('shows New customer and per-customer Edit with canEditCustomers', () => {
    render(<CustomersClient customers={customers} canSync={false} edit={edit} />);
    expect(screen.getByRole('button', { name: /new customer/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /edit acme/i }));
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('asks before deleting and does nothing when cancelled', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<CustomersClient customers={customers} canSync={false} edit={edit} />);
    fireEvent.click(screen.getByRole('button', { name: /delete acme/i }));
    expect(confirm).toHaveBeenCalledWith("Delete this customer? This can't be undone.");
    expect(actions.deleteCustomerAction).not.toHaveBeenCalled();
  });

  it('deletes after confirming and shows the error text', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    actions.deleteCustomerAction.mockResolvedValue({ ok: false, error: 'In use. You can set Blocked to All instead.' });
    render(<CustomersClient customers={customers} canSync={false} edit={edit} />);
    fireEvent.click(screen.getByRole('button', { name: /delete acme/i }));
    await waitFor(() => expect(actions.deleteCustomerAction).toHaveBeenCalledWith('c1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('In use. You can set Blocked to All instead.');
  });

  it('a pending delete does not show the Sync button as Syncing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finish: (v: unknown) => void = () => undefined;
    actions.deleteCustomerAction.mockReturnValue(new Promise((r) => { finish = r; }));
    render(<CustomersClient customers={customers} canSync={true} edit={edit} />);
    fireEvent.click(screen.getByRole('button', { name: /delete acme/i }));
    await waitFor(() => expect(actions.deleteCustomerAction).toHaveBeenCalledWith('c1'));
    expect(screen.queryByText('Syncing…')).toBeNull();
    expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument();
    finish({ ok: true });
    expect(await screen.findByText('Deleted Acme.')).toBeInTheDocument();
  });
});

const billcomOn = (over: Record<string, unknown> = {}) => ({
  on: true, isAdmin: true, canRetry: true, pendingCount: 0,
  links: { C1: { status: 'failed' as const, lastError: 'Bad email' } }, ...over,
});

describe('CustomersClient Bill.com', () => {
  it('shows a status badge per customer when Bill.com is on', () => {
    render(<CustomersClient customers={customers} canSync={false} edit={edit} billcom={billcomOn()} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('labels each status in plain words', () => {
    const many = ['C1', 'C2', 'C3', 'C4'].map((n, i) => ({ ...customers[0], id: `c${i}`, bc_customer_number: n }));
    const links = {
      C1: { status: 'synced', lastError: null }, C2: { status: 'pending', lastError: null },
      C3: { status: 'failed', lastError: 'x' }, C4: { status: 'needs_attention', lastError: 'y' },
    };
    render(<CustomersClient customers={many as never} canSync={false} billcom={billcomOn({ links }) as never} />);
    for (const label of ['Synced', 'Waiting', 'Failed', 'Needs attention']) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('shows no badges or panel when Bill.com is off', () => {
    render(<CustomersClient customers={customers} canSync={false} edit={edit} billcom={billcomOn({ on: false })} />);
    expect(screen.queryByText('Failed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Push to Bill.com' })).toBeNull();
  });

  it('shows the push panel to admins only', () => {
    const { unmount } = render(<CustomersClient customers={customers} canSync={false} billcom={billcomOn()} />);
    expect(screen.getByRole('button', { name: 'Push to Bill.com' })).toBeInTheDocument();
    unmount();
    render(<CustomersClient customers={customers} canSync={false} billcom={billcomOn({ isAdmin: false })} />);
    expect(screen.queryByRole('button', { name: 'Push to Bill.com' })).toBeNull();
  });

  it('starts a pending run after a successful Sync (admin, Bill.com on)', async () => {
    sync.syncBusinessCentralReceivables.mockResolvedValue([{ entityType: 'customers', recordsSynced: 1, complete: true }]);
    bc.runPendingPush.mockResolvedValue({ ok: true, result: { created: 0, updated: 0, linked: 0, unchanged: 0, failed: 0, needsAttention: 0, remaining: 0 } });
    render(<CustomersClient customers={customers} canSync={true} billcom={billcomOn()} />);
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(bc.runPendingPush).toHaveBeenCalledTimes(1));
  });

  it('does not start a run after Sync for non-admins', async () => {
    sync.syncBusinessCentralReceivables.mockResolvedValue([{ entityType: 'customers', recordsSynced: 1, complete: true }]);
    render(<CustomersClient customers={customers} canSync={true} billcom={billcomOn({ isAdmin: false })} />);
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    expect(await screen.findByText('Complete')).toBeInTheDocument();
    expect(bc.runPendingPush).not.toHaveBeenCalled();
  });

  it('shows the Bill.com message after a delete that did not sync', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    actions.deleteCustomerAction.mockResolvedValue({ ok: true, billcom: { status: 'failed', message: 'Bill.com said no' } });
    render(<CustomersClient customers={customers} canSync={false} edit={edit} billcom={billcomOn()} />);
    fireEvent.click(screen.getByRole('button', { name: /delete acme/i }));
    expect(await screen.findByText(/Bill.com said no/)).toBeInTheDocument();
  });
});
