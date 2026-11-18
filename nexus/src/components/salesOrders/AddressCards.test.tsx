import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShipToRow } from '@/types/salesOrders';
import { BillingCard, ShipToCard } from './AddressCards';

afterEach(cleanup);

const values = {
  bill_name: 'Acme Co', bill_address: '1 Main St', bill_address_2: '', bill_city: 'Austin', bill_state: 'TX',
  bill_post_code: '78701', bill_country: '', bill_contact_no: '', bill_phone: '555-0100', bill_mobile: '',
  bill_email: 'a@acme.test', bill_email_cc: '',
};

describe('BillingCard', () => {
  it('shows text with no inputs, omitting empty lines', () => {
    render(<BillingCard values={values} editable onChange={vi.fn()} />);
    expect(screen.getByText('1 Main St')).toBeInTheDocument();
    expect(screen.getByText('Austin, TX 78701')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('pencil shows inputs; editing calls onChange; Done returns to text', () => {
    const onChange = vi.fn();
    render(<BillingCard values={values} editable onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit billing address' }));
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Hilo' } });
    expect(onChange).toHaveBeenCalledWith({ bill_city: 'Hilo' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('City')).toBeNull();
  });

  it('has no pencil when not editable', () => {
    render(<BillingCard values={values} editable={false} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Edit billing address' })).toBeNull();
  });
});

const row = (code: string, name: string): ShipToRow => ({ id: `id-${code}`, code, name }) as unknown as ShipToRow;
const address = {
  ship_to_name: 'Dock', ship_to_address: '9 Oak Ave', ship_to_address_2: '', ship_to_city: 'Hilo',
  ship_to_state: 'HI', ship_to_post_code: '96720', ship_to_country: 'US', ship_to_contact: '', ship_to_phone: '',
};
const shipProps = (over = {}) => ({
  rows: [row('MAIN', 'Main dock')],
  defaultCode: 'MAIN',
  choice: { kind: 'saved', code: 'MAIN' } as const,
  address,
  saveToCustomer: false,
  canSaveToCustomer: true,
  disabled: false,
  onChoose: vi.fn(),
  onAddressChange: vi.fn(),
  onSaveToCustomerChange: vi.fn(),
  editable: true,
  ...over,
});

describe('ShipToCard', () => {
  it('shows the address and code as text', () => {
    render(<ShipToCard {...shipProps()} />);
    expect(screen.getByText('9 Oak Ave')).toBeInTheDocument();
    expect(screen.getByText('MAIN')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('pencil reveals the picker and a one-off can be chosen', () => {
    const props = shipProps();
    render(<ShipToCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit ship-to' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Ship to' }), { target: { value: 'oneoff' } });
    expect(props.onChoose).toHaveBeenLastCalledWith({ kind: 'oneoff' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('has no pencil when not editable', () => {
    render(<ShipToCard {...shipProps({ editable: false })} />);
    expect(screen.queryByRole('button', { name: 'Edit ship-to' })).toBeNull();
  });
});
