import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessCentralCustomer } from '@/types/database';
import { CustomersClient } from './CustomersClient';

const actions = vi.hoisted(() => ({ createCustomerAction: vi.fn(), updateCustomerAction: vi.fn(), deleteCustomerAction: vi.fn() }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/app/actions/customerEditing', () => actions);
const sync = vi.hoisted(() => ({ syncBusinessCentralReceivables: vi.fn(), syncCustomersLight: vi.fn() }));
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
    sync.syncCustomersLight.mockResolvedValue([{ entityType: 'customers', recordsSynced: 1, complete: true }]);
    bc.runPendingPush.mockResolvedValue({ ok: true, result: { created: 0, updated: 0, linked: 0, unchanged: 0, failed: 0, needsAttention: 0, remaining: 0 } });
    render(<CustomersClient customers={customers} canSync={true} billcom={billcomOn()} />);
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(bc.runPendingPush).toHaveBeenCalledTimes(1));
  });

  it('does not start a run after Sync for non-admins', async () => {
    sync.syncCustomersLight.mockResolvedValue([{ entityType: 'customers', recordsSynced: 1, complete: true }]);
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

describe('Sync keeps going until everything is complete', () => {
  const r = (entityType: string, recordsSynced: number, complete: boolean, cursor: string | null = null, error: string | null = null) => ({
    entityType, recordsSynced, complete, cursor, error,
  });
  const clickSync = () => fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

  it('runs another round while something is incomplete and moving, then stops when all complete', async () => {
    sync.syncCustomersLight
      .mockResolvedValueOnce([r('customer', 1, true), r('sales_invoice_line', 300, false, 'inv-50')])
      .mockResolvedValueOnce([r('customer', 0, true), r('sales_invoice_line', 120, true, 'inv-80')]);
    render(<CustomersClient customers={customers} canSync={true} />);
    clickSync();
    await waitFor(() => expect(screen.getAllByText('Complete')).toHaveLength(2));
    expect(sync.syncCustomersLight).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled();
  });

  it('shows the round while running, and Stop finishes the current round then stops', async () => {
    let finishRound2: (v: unknown) => void = () => {};
    sync.syncCustomersLight
      .mockResolvedValueOnce([r('sales_invoice_line', 300, false, 'inv-50')])
      .mockImplementationOnce(() => new Promise((res) => { finishRound2 = res; }));
    render(<CustomersClient customers={customers} canSync={true} />);
    clickSync();
    expect(await screen.findByText(/round 2/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText(/stopping…/i)).toBeInTheDocument();
    finishRound2([r('sales_invoice_line', 300, false, 'inv-100')]);
    expect(await screen.findByText('Incomplete — click Sync again to continue')).toBeInTheDocument();
    expect(sync.syncCustomersLight).toHaveBeenCalledTimes(2);
  });

  it('stops when a round makes no progress (nothing synced, same place)', async () => {
    sync.syncCustomersLight.mockResolvedValue([r('sales_invoice_line', 0, false, 'inv-50')]);
    render(<CustomersClient customers={customers} canSync={true} />);
    clickSync();
    expect(await screen.findByText('Incomplete — click Sync again to continue')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled());
    expect(sync.syncCustomersLight).toHaveBeenCalledTimes(2);
  });

  it('does not repeat for an error alone (e.g. a missing BC page), and shows it', async () => {
    sync.syncCustomersLight.mockResolvedValue([
      r('customer', 0, false, null, 'Ship-to addresses: 404'),
      r('sales_invoice_line', 10, true, 'inv-9'),
    ]);
    render(<CustomersClient customers={customers} canSync={true} />);
    clickSync();
    expect(await screen.findByText('Ship-to addresses: 404')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled());
    expect(sync.syncCustomersLight).toHaveBeenCalledTimes(1);
  });

  it('keeps going past an error while another part is still moving', async () => {
    sync.syncCustomersLight
      .mockResolvedValueOnce([r('customer', 0, false, null, 'Ship-to addresses: 404'), r('customer_ledger_entry', 500, false, 'e500')])
      .mockResolvedValueOnce([r('customer', 0, false, null, 'Ship-to addresses: 404'), r('customer_ledger_entry', 20, true, 'e520')]);
    render(<CustomersClient customers={customers} canSync={true} />);
    clickSync();
    expect(await screen.findByText('Complete')).toBeInTheDocument();
    expect(sync.syncCustomersLight).toHaveBeenCalledTimes(2);
  });

  it('a failed round stops and shows the error', async () => {
    sync.syncCustomersLight
      .mockResolvedValueOnce([r('sales_invoice_line', 300, false, 'inv-50')])
      .mockRejectedValueOnce(new Error('Sync already in progress by someone'));
    render(<CustomersClient customers={customers} canSync={true} />);
    clickSync();
    expect(await screen.findByText('Sync already in progress by someone')).toBeInTheDocument();
    expect(sync.syncCustomersLight).toHaveBeenCalledTimes(2);
  });
});

describe('long customer lists', () => {
  const many = Array.from({ length: 450 }, (_, i) => ({
    id: `c${i}`, display_name: `Customer ${String(i).padStart(3, '0')}`, bc_customer_number: `N${i}`, email: null, city: null, currency_code: null, balance: 0,
  })) as unknown as BusinessCentralCustomer[];
  const rows = () => screen.getAllByRole('row').length - 1; // minus the header row

  it('draws the first 200 and adds 200 more per "Show more" until all are shown', () => {
    render(<CustomersClient customers={many} canSync={false} />);
    expect(rows()).toBe(200);
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(rows()).toBe(400);
    fireEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(rows()).toBe(450);
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();
  });

  it('search looks through every customer, not just the ones drawn', () => {
    render(<CustomersClient customers={many} canSync={false} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'Customer 449' } });
    expect(screen.getByText('Customer 449')).toBeInTheDocument();
    expect(rows()).toBe(1);
  });
});

describe('customer form popup', () => {
  it('New customer opens the form in a dialog, and Cancel closes it', () => {
    render(<CustomersClient customers={customers} canSync={false} edit={edit} />);
    fireEvent.click(screen.getByRole('button', { name: /new customer/i }));
    const dialog = screen.getByRole('dialog', { name: 'New customer' });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Edit from the list opens the form in a dialog too', () => {
    render(<CustomersClient customers={customers} canSync={false} edit={edit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Acme' }));
    expect(screen.getByRole('dialog', { name: 'Edit customer' })).toBeInTheDocument();
  });
});

describe('Customers page Sync now is the light sync', () => {
  it('calls the light sync, never the full one', async () => {
    sync.syncCustomersLight.mockResolvedValue([{ entityType: 'customer', recordsSynced: 1, complete: true, cursor: null, error: null }]);
    render(<CustomersClient customers={customers} canSync={true} />);
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    expect(await screen.findByText('Complete')).toBeInTheDocument();
    expect(sync.syncCustomersLight).toHaveBeenCalledTimes(1);
    expect(sync.syncBusinessCentralReceivables).not.toHaveBeenCalled();
  });
});
