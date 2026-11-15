import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShipToRow } from '@/types/salesOrders';
import { oneOffShipToName, ShipToPicker, type ShipToAddressFields } from './ShipToPicker';

afterEach(cleanup);

const row = (code: string, name: string): ShipToRow => ({ id: `id-${code}`, code, name }) as unknown as ShipToRow;
const rows = [row('MAIN', 'Main dock'), row('SIDE', 'Side door')];
const address: ShipToAddressFields = {
  ship_to_name: 'Acme', ship_to_address: '1 Main St', ship_to_address_2: '', ship_to_city: 'Austin',
  ship_to_state: 'TX', ship_to_post_code: '78701', ship_to_country: 'US', ship_to_contact: '', ship_to_phone: '',
};

const setup = (over: Partial<React.ComponentProps<typeof ShipToPicker>> = {}) => {
  const props = {
    rows,
    defaultCode: 'MAIN',
    choice: { kind: 'saved', code: 'MAIN' } as const,
    address,
    saveToCustomer: false,
    canSaveToCustomer: true,
    disabled: false,
    onChoose: vi.fn(),
    onAddressChange: vi.fn(),
    onSaveToCustomerChange: vi.fn(),
    ...over,
  };
  render(<ShipToPicker {...props} />);
  return props;
};

describe('ShipToPicker', () => {
  it('lists saved ship-tos with a star on the default, then Billing address and One-off', () => {
    setup();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['★ MAIN – Main dock', 'SIDE – Side door', 'Billing address', 'One-off address…']);
  });

  it('reports the picked option', () => {
    const props = setup();
    const select = screen.getByRole('combobox', { name: 'Ship to' });
    fireEvent.change(select, { target: { value: 'saved:SIDE' } });
    expect(props.onChoose).toHaveBeenLastCalledWith({ kind: 'saved', code: 'SIDE' });
    fireEvent.change(select, { target: { value: 'billing' } });
    expect(props.onChoose).toHaveBeenLastCalledWith({ kind: 'billing' });
    fireEvent.change(select, { target: { value: 'oneoff' } });
    expect(props.onChoose).toHaveBeenLastCalledWith({ kind: 'oneoff' });
  });

  it('a saved ship-to hides the one-off fields', () => {
    setup();
    expect(screen.queryByRole('checkbox', { name: 'Save to customer' })).toBeNull();
  });

  it('One-off shows the address fields and a Save to customer checkbox', () => {
    const props = setup({ choice: { kind: 'oneoff' } });
    expect(screen.getByLabelText('Ship-to name')).toHaveValue('Acme');
    expect(screen.getByLabelText('Ship-to address')).toHaveValue('1 Main St');
    expect(screen.getByLabelText('Ship-to city')).toHaveValue('Austin');
    fireEvent.change(screen.getByLabelText('Ship-to city'), { target: { value: 'Dallas' } });
    expect(props.onAddressChange).toHaveBeenCalledWith({ ship_to_city: 'Dallas' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save to customer' }));
    expect(props.onSaveToCustomerChange).toHaveBeenCalledWith(true);
  });

  it('no Save to customer checkbox without ship-to permission', () => {
    setup({ choice: { kind: 'oneoff' }, canSaveToCustomer: false });
    expect(screen.queryByRole('checkbox', { name: 'Save to customer' })).toBeNull();
  });

  it('keeps an order’s saved code visible when it is not in the list', () => {
    setup({ choice: { kind: 'saved', code: 'GONE' }, address: { ...address, ship_to_name: 'Old dock' } });
    expect(screen.getByRole('option', { name: 'GONE – Old dock' })).toBeInTheDocument();
  });
});

describe('oneOffShipToName', () => {
  it('is "address, city", skipping blanks, cut to 100 characters', () => {
    expect(oneOffShipToName({ ship_to_address: ' 1 Main St ', ship_to_city: 'Austin' })).toBe('1 Main St, Austin');
    expect(oneOffShipToName({ ship_to_address: '', ship_to_city: 'Austin' })).toBe('Austin');
    expect(oneOffShipToName({ ship_to_address: '', ship_to_city: '' })).toBe('');
    expect(oneOffShipToName({ ship_to_address: 'x'.repeat(120), ship_to_city: 'Austin' })).toHaveLength(100);
  });
});
