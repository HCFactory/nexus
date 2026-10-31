import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessCentralCustomer } from '@/types/database';
import { CustomersClient } from './CustomersClient';

const actions = vi.hoisted(() => ({ createCustomerAction: vi.fn(), updateCustomerAction: vi.fn(), deleteCustomerAction: vi.fn() }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/app/actions/customerEditing', () => actions);
vi.mock('@/app/actions/businessCentralReceivables', () => ({ syncBusinessCentralReceivables: vi.fn() }));
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
