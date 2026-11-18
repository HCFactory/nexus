import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipToRow } from '@/types/salesOrders';
import { ShipToSection } from './ShipToSection';

const actions = vi.hoisted(() => ({
  saveShipToAction: vi.fn(),
  deleteShipToAction: vi.fn(),
  setDefaultShipToAction: vi.fn(),
}));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/app/actions/shipToAddresses', () => actions);
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
vi.spyOn(window, 'confirm');
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const row = (code: string, name: string): ShipToRow =>
  ({ id: `id-${code}`, customer_number: 'C1', code, name, city: 'Austin', state: 'TX' }) as unknown as ShipToRow;
const rows = [row('MAIN', 'Main dock'), row('SIDE', 'Side door')];
const options = {
  taxAreas: [{ code: 'TX', label: 'TX' }],
  locations: [{ code: 'W1', label: 'W1' }],
  shipmentMethods: [{ code: 'UPS', label: 'UPS' }],
};
const renderSection = (canEdit = true) =>
  render(<ShipToSection customerNumber="C1" defaultCode="MAIN" rows={rows} canEdit={canEdit} options={options} />);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ShipToSection', () => {
  it('renders the columns and a filled star only on the default row', () => {
    renderSection();
    for (const h of ['Code', 'Name', 'City / State']) expect(screen.getByText(h)).toBeInTheDocument();
    const main = screen.getByText('MAIN').closest('tr')!;
    const side = screen.getByText('SIDE').closest('tr')!;
    expect(within(main).getByText('★')).toBeInTheDocument();
    expect(within(main).queryByText('☆')).toBeNull();
    expect(within(side).getByText('☆')).toBeInTheDocument();
    expect(within(side).queryByText('★')).toBeNull();
  });

  it('clicking an empty star sets the default', async () => {
    actions.setDefaultShipToAction.mockResolvedValue({ ok: true });
    renderSection();
    fireEvent.click(screen.getByText('☆'));
    await waitFor(() => expect(actions.setDefaultShipToAction).toHaveBeenCalledWith('C1', 'SIDE'));
  });

  it('hides edit, delete and star controls without permission', () => {
    renderSection(false);
    expect(screen.queryByText('☆')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit|delete|add/i })).toBeNull();
  });

  it('Add opens the dialog with every field', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    const code = screen.getByPlaceholderText('Leave blank to use the street address');
    expect(code).toHaveAttribute('maxlength', '10');
    for (const l of ['Name', 'Address', 'Address 2', 'City', 'State', 'ZIP', 'Country', 'Contact', 'Phone', 'Email', 'Tax area', 'Location', 'Shipment method']) {
      expect(screen.getByLabelText(l)).toBeInTheDocument();
    }
    expect(screen.getByRole('switch', { name: 'Tax liable' })).toBeInTheDocument();
  });

  it('Save calls saveShipToAction; a failure shows the error in the dialog', async () => {
    actions.saveShipToAction.mockResolvedValue({ ok: false, error: 'BC said no' });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New dock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(actions.saveShipToAction).toHaveBeenCalled());
    const arg = actions.saveShipToAction.mock.calls[0][0];
    expect(arg.customerNumber).toBe('C1');
    expect(arg.values.name).toBe('New dock');
    expect(await screen.findByText('BC said no')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a successful save closes the dialog and refreshes', async () => {
    actions.saveShipToAction.mockResolvedValue({ ok: true, row: row('NEW', 'x') });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Delete confirms through the dialog, not window.confirm', async () => {
    actions.deleteShipToAction.mockResolvedValue({ ok: true });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Delete SIDE' }));
    expect(actions.deleteShipToAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(actions.deleteShipToAction).toHaveBeenCalledWith('id-SIDE'));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('Cancel in the delete dialog does not delete', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Delete SIDE' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(actions.deleteShipToAction).not.toHaveBeenCalled();
  });

  it('editing row A then row B shows row B values', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Edit MAIN' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Main dock');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit SIDE' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Side door');
    expect(screen.getByLabelText('Code')).toHaveValue('SIDE');
  });
});
