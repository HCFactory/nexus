import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesOrderFormContext } from '@/app/actions/salesOrders';
import type { CustomerRow, SalesOrderLineRow, SalesOrderRow, SalesPriceListLineRow, ShipToRow } from '@/types/salesOrders';
import type { InvoiceChangeRow } from '@/types/invoiceChanges';
import { SalesOrderForm } from './SalesOrderForm';

const orderActions = vi.hoisted(() => ({
  saveSalesOrder: vi.fn(),
  setSalesOrderStatus: vi.fn(),
  deleteSalesOrder: vi.fn(),
  retrySalesOrderSync: vi.fn(),
  overwriteBcWithNexus: vi.fn(),
  // Never resolves by default: the form keeps the context's lines (each test sets its own when it matters).
  getSalesOrderPriceLines: vi.fn((): Promise<SalesPriceListLineRow[]> => new Promise(() => {})),
}));
vi.mock('@/app/actions/salesOrderNotes', () => ({ addSalesOrderNote: vi.fn(), updateSalesOrderNote: vi.fn(), deleteSalesOrderNote: vi.fn() }));
const shipActions = vi.hoisted(() => ({ refreshShipTos: vi.fn(), saveShipToAction: vi.fn() }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/app/actions/salesOrders', () => orderActions);
vi.mock('@/app/actions/shipToAddresses', () => shipActions);
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
vi.mock('@/app/actions/salesOrderInvoicing', () => ({ createInvoice: vi.fn(), retryInvoice: vi.fn() }));
const changeActions = vi.hoisted(() => ({ startChangeInvoice: vi.fn(), retryChangeInvoice: vi.fn(), discardChangeInvoice: vi.fn() }));
vi.mock('@/app/actions/salesInvoiceChanges', () => changeActions);
const customerActions = vi.hoisted(() => ({ setCustomerDeliveryMethod: vi.fn() }));
vi.mock('@/app/actions/customerEditing', () => customerActions);
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const customer = (over: Partial<CustomerRow>): CustomerRow => ({
  id: 'cust-1', bc_customer_number: 'C1', display_name: 'Acme Foods', address_line_1: '1 Main St', address_line_2: '',
  city: 'Austin', state: 'TX', postal_code: '78701', country: 'US', phone_number: '555-0100', email: 'a@acme.test',
  email_cc: 'cc@acme.test', contact_no: 'CT1', mobile_phone_no: '555-0101', ship_to_code: 'DOCK',
  shipment_method_code: 'UPS', payment_terms_code: 'NET30', tax_area_code: 'TX', tax_liable: true,
  customer_posting_group: 'DOMESTIC', gen_bus_posting_group: 'DOM', location_code: 'W1', customer_price_group: 'WHSL', ...over,
});
const acme = customer({});
const beta = customer({
  id: 'cust-2', bc_customer_number: 'C2', display_name: 'Beta Bakery', address_line_1: '9 Oak Ave', city: 'Hilo',
  state: 'HI', postal_code: '96720', phone_number: '555-0200', email: 'b@beta.test', email_cc: '', contact_no: 'CT2',
  mobile_phone_no: '', ship_to_code: '', shipment_method_code: 'GROUND', payment_terms_code: 'NET15',
  tax_area_code: 'HI', tax_liable: false, customer_posting_group: 'EXPORT', gen_bus_posting_group: 'EXP',
  customer_price_group: '',
});

const opts = (...codes: string[]) => codes.map((c) => ({ code: c, label: c }));
const context: SalesOrderFormContext = {
  customers: [acme, beta],
  items: [{ bc_item_number: 'P100', display_name: 'Pesto sauce', unit_price: 12.5, base_unit_of_measure_code: 'CASE', tax_group_code: 'TAXABLE' }],
  selectOptions: {
    paymentTerms: opts('NET30', 'NET15'),
    taxAreas: opts('TX', 'HI'),
    generalBusinessPostingGroups: opts('DOM', 'EXP'),
    customerPostingGroups: opts('DOMESTIC', 'EXPORT'),
    shipmentMethods: opts('UPS', 'GROUND'),
  },
  companyLocation: 'MAIN',
  today: '2026-11-13',
  priceListLines: [],
  taxAreaLines: [],
  taxDetails: [],
};

/** Texas at 8.25% for TAXABLE items. */
const taxed: SalesOrderFormContext = {
  ...context,
  taxAreaLines: [{ tax_area_code: 'TX', tax_jurisdiction_code: 'TX-ST' }],
  taxDetails: [
    { tax_jurisdiction_code: 'TX-ST', tax_group_code: 'TAXABLE', tax_type: 'Sales Tax', effective_date: '2020-01-01', tax_below_maximum: 8.25 },
  ],
};
const priceInputs = () => screen.getAllByLabelText('Unit price').map((el) => (el as HTMLInputElement).value);
const totals = () => ['total-subtotal', 'total-tax', 'total-total'].map((id) => screen.getByTestId(id).textContent);
const addItem = (label: string) => {
  fireEvent.click(screen.getByPlaceholderText('Add item…'));
  fireEvent.click(screen.getByRole('option', { name: label }));
};

const priceLine = (o: Partial<SalesPriceListLineRow>): SalesPriceListLineRow => ({
  id: 'p', organization_id: 'o', bc_connection_id: 'b', price_list_code: 'PL1', line_no: 1, list_status: 'Active',
  source_type: 'Customer Price Group', source_no: 'WHSL', item_number: 'P100', unit_of_measure_code: '',
  minimum_quantity: 0, starting_date: null, ending_date: null, unit_price: 10, line_discount_percent: 0,
  amount_type: 'Price', last_synced_at: null, created_at: '', updated_at: '', ...o,
});

const dock = {
  id: 'st-1', customer_number: 'C1', code: 'DOCK', name: 'Loading dock', address: '2 Dock Rd', address_2: '',
  city: 'Austin', state: 'TX', post_code: '78702', country: 'US', contact: 'Sam', phone: '555-0111', email: '',
  tax_area_code: '', location_code: '', shipment_method_code: '', tax_liable: false,
} as unknown as ShipToRow;

const order = (over: Partial<SalesOrderRow> = {}): SalesOrderRow => ({
  id: 'so-1', status: 'draft', customer_id: 'cust-1', customer_number: 'C1', order_date: '2026-11-10',
  requested_delivery_date: null, invoice_number: null, customer_po: 'PO-1', notes: '',
  bill_name: 'Acme Foods', bill_address: '1 Main St', bill_address_2: '', bill_city: 'Austin', bill_state: 'TX',
  bill_post_code: '78701', bill_country: 'US', bill_contact_no: 'CT1', bill_phone: '555-0100', bill_mobile: '',
  bill_email: 'a@acme.test', bill_email_cc: '', ship_to_code: 'DOCK', ship_to_name: 'Loading dock',
  ship_to_address: '2 Dock Rd', ship_to_address_2: '', ship_to_city: 'Austin', ship_to_state: 'TX',
  ship_to_post_code: '78702', ship_to_country: 'US', ship_to_contact: 'Sam', ship_to_phone: '555-0111',
  payment_terms_code: 'NET30', tax_area_code: 'TX', gen_bus_posting_group: 'DOM', customer_posting_group: 'DOMESTIC',
  shipment_method_code: 'UPS', location_code: 'W1', tax_liable: true, bc_order_number: 'SO-10234', bc_etag: null,
  bc_create_marker: null, bc_due_date: '2026-12-10', bc_document_date: null, bc_posting_date: null,
  total_excl_tax: 100, total_tax: 8.25, total_incl_tax: 108.25, sync_state: 'synced', sync_error: null,
  sync_attempts: 0, claimed_until: null, last_synced_at: null, local_version: 3, synced_version: 3,
  created_by: null, bc_snapshot: null, invoice_state: 'none', invoice_error: null, bc_posted_invoice_id: null, bc_posted_invoice_number: null, posted_at: null, invoice_date: null, invoice_due_date: null, posted_total_excl_tax: null, posted_total_tax: null, posted_total_incl_tax: null, billcom_invoice_id: null, billcom_invoiced_at: null, invoice_started_by: null, created_at: '', updated_at: '', organization_id: 'o', bc_connection_id: 'b', ...over,
});
const lineRow = { id: 'l1', item_number: 'P100', description: 'Pesto sauce', quantity: 2, unit_price: null,
  discount_percent: 0, unit_of_measure_code: 'CASE', amount_incl_tax: 27, position: 0 } as unknown as SalesOrderLineRow;

type Props = React.ComponentProps<typeof SalesOrderForm>;
const renderForm = (over: Partial<Props> = {}) =>
  render(
    <SalesOrderForm
      order={null}
      lines={[]}
      context={context}
      shipTos={[]}
      canEdit
      canSaveShipTo
      {...over}
    />,
  );

const billing = () => {
  const pencil = screen.queryByRole('button', { name: 'Edit billing address' });
  if (pencil) fireEvent.click(pencil);
  return within(screen.getByRole('group', { name: 'Billing address' }));
};
const shipSelect = () => {
  const pencil = screen.queryByRole('button', { name: 'Edit ship-to' });
  if (pencil) fireEvent.click(pencil);
  return screen.getByRole('combobox', { name: 'Ship to' });
};
const pickCustomer = (label: string) => {
  const input = screen.getByRole('combobox', { name: 'Customer' });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: label.split(' ')[0] } });
  fireEvent.click(screen.getByRole('option', { name: label }));
};

beforeEach(() => {
  vi.clearAllMocks();
  shipActions.refreshShipTos.mockResolvedValue([]);
});
afterEach(cleanup);

describe('SalesOrderForm — picking a customer', () => {
  it('fills billing, terms, tax liable and the default ship-to, and refreshes ship-tos once', async () => {
    shipActions.refreshShipTos.mockResolvedValue([dock]);
    renderForm();
    pickCustomer('C1 – Acme Foods');

    expect(billing().getByLabelText('Address')).toHaveValue('1 Main St');
    expect(billing().getByLabelText('City')).toHaveValue('Austin');
    expect(billing().getByLabelText('Contact no.')).toHaveValue('CT1');
    expect(billing().getByLabelText('Email CC')).toHaveValue('cc@acme.test');
    expect(screen.getByLabelText('Payment terms')).toHaveValue('NET30');
    expect(screen.getByLabelText('Delivery method')).toHaveValue('UPS');
    expect(screen.getByLabelText('Tax area')).toHaveValue('TX');
    expect(screen.getByRole('switch', { name: 'Tax liable' })).toBeChecked();

    expect(shipActions.refreshShipTos).toHaveBeenCalledTimes(1);
    expect(shipActions.refreshShipTos).toHaveBeenCalledWith('C1');
    await waitFor(() => expect(shipSelect()).toHaveValue('saved:DOCK'));
    expect(screen.getByRole('option', { name: '★ DOCK – Loading dock' })).toBeInTheDocument();
  });

  it('keeps going when the ship-to refresh throws', async () => {
    shipActions.refreshShipTos.mockRejectedValue(new Error('Select a Business Central environment first'));
    renderForm();
    pickCustomer('C1 – Acme Foods');
    await waitFor(() => expect(shipActions.refreshShipTos).toHaveBeenCalled());
    expect(billing().getByLabelText('Address')).toHaveValue('1 Main St');
    expect(shipSelect()).toHaveValue('billing');
  });

  it('switching customer silently refills, keeping lines, customer PO and invoice #', async () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.change(screen.getByLabelText('Customer PO'), { target: { value: 'PO-9' } });
    fireEvent.change(screen.getByLabelText('Invoice # (Ext. Doc No.)'), { target: { value: 'INV-7' } });

    pickCustomer('C2 – Beta Bakery');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(billing().getByLabelText('Address')).toHaveValue('9 Oak Ave');
    expect(billing().getByLabelText('City')).toHaveValue('Hilo');
    expect(screen.getByLabelText('Payment terms')).toHaveValue('NET15');
    expect(screen.getByLabelText('Tax area')).toHaveValue('HI');
    expect(screen.getByRole('switch', { name: 'Tax liable' })).not.toBeChecked();
    expect(screen.getByLabelText('Customer PO')).toHaveValue('PO-9');
    expect(screen.getByLabelText('Invoice # (Ext. Doc No.)')).toHaveValue('INV-7');
    expect(screen.getByText('Pesto sauce')).toBeInTheDocument();
    await waitFor(() => expect(shipActions.refreshShipTos).toHaveBeenCalledWith('C2'));
  });
});

describe('SalesOrderForm — ship-to', () => {
  it('a one-off with Save to customer saves the ship-to first and uses its code', async () => {
    shipActions.saveShipToAction.mockResolvedValue({ ok: true, row: { ...dock, id: 'st-9', code: 'NEWDOCK', name: 'New dock' } });
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'so-new' });
    renderForm();
    pickCustomer('C2 – Beta Bakery');
    await waitFor(() => expect(shipActions.refreshShipTos).toHaveBeenCalled());

    fireEvent.change(shipSelect(), { target: { value: 'oneoff' } });
    fireEvent.change(screen.getByLabelText('Ship-to name'), { target: { value: 'New dock' } });
    fireEvent.change(screen.getByLabelText('Ship-to address'), { target: { value: '5 Pier St' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save to customer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(orderActions.saveSalesOrder).toHaveBeenCalled());
    expect(shipActions.saveShipToAction).toHaveBeenCalledTimes(1);
    const shipArg = shipActions.saveShipToAction.mock.calls[0][0];
    expect(shipArg.customerNumber).toBe('C2');
    expect(shipArg.values).toMatchObject({ name: 'New dock', address: '5 Pier St' });
    expect(shipActions.saveShipToAction.mock.invocationCallOrder[0]).toBeLessThan(
      orderActions.saveSalesOrder.mock.invocationCallOrder[0],
    );
    const input = orderActions.saveSalesOrder.mock.calls[0][0];
    expect(input.ship_to_code).toBe('NEWDOCK');
    expect(input.customer_number).toBe('C2');
    expect(input.id).toBeUndefined();
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/sales-orders/so-new'));
  });

  it('an unsaved one-off travels as ship_to_* fields with an empty code', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'so-new' });
    renderForm();
    pickCustomer('C2 – Beta Bakery');
    fireEvent.change(shipSelect(), { target: { value: 'oneoff' } });
    fireEvent.change(screen.getByLabelText('Ship-to address'), { target: { value: '5 Pier St' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(orderActions.saveSalesOrder).toHaveBeenCalled());
    expect(shipActions.saveShipToAction).not.toHaveBeenCalled();
    const input = orderActions.saveSalesOrder.mock.calls[0][0];
    expect(input.ship_to_code).toBe('');
    expect(input.ship_to_address).toBe('5 Pier St');
  });

  it('a one-off starts with the customer name and keeps a typed name', () => {
    renderForm();
    pickCustomer('C2 – Beta Bakery');
    fireEvent.change(shipSelect(), { target: { value: 'oneoff' } });
    const name = screen.getByLabelText('Ship-to name') as HTMLInputElement;
    expect(name.value).toBe('Beta Bakery');
    fireEvent.change(screen.getByLabelText('Ship-to address'), { target: { value: '5 Pier St' } });
    expect(name.value).toBe('Beta Bakery');
    fireEvent.change(name, { target: { value: 'Pier warehouse' } });
    expect(name.value).toBe('Pier warehouse');
  });

  it('does not save the order when saving the ship-to fails', async () => {
    shipActions.saveShipToAction.mockResolvedValue({ ok: false, error: 'BC said no' });
    renderForm();
    pickCustomer('C2 – Beta Bakery');
    fireEvent.change(shipSelect(), { target: { value: 'oneoff' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save to customer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('BC said no')).toBeInTheDocument();
    expect(orderActions.saveSalesOrder).not.toHaveBeenCalled();
  });
});

describe('SalesOrderForm — fields', () => {
  it('Invoice # placeholder; no Customer PO helper text', () => {
    renderForm();
    expect(screen.getByLabelText('Invoice # (Ext. Doc No.)')).toHaveAttribute('placeholder', 'Set when sent to BC');
    expect(screen.getByLabelText('Invoice # (Ext. Doc No.)')).toHaveAttribute('maxlength', '35');
    expect(screen.queryByText(/Not sent to BC on its own/)).toBeNull();
  });

  it('keeps the order date and requested date; document, posting and due dates are gone', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    expect(screen.getByLabelText('Order date')).toHaveValue('2026-11-10');
    expect(screen.queryByText(/Due date/)).toBeNull();
    expect(screen.queryByText(/Posting date/)).toBeNull();
    expect(screen.queryByText(/Document date/)).toBeNull();
  });

  it('a new order defaults its order date to today', () => {
    renderForm();
    expect(screen.getByLabelText('Order date')).toHaveValue('2026-11-13');
  });

  it('a synced blank-price line shows BC’s unit price; an unsynced one shows the estimate', () => {
    const synced = { ...lineRow, bc_unit_price: 11.25 } as SalesOrderLineRow;
    const unsynced = { ...lineRow, id: 'l2', bc_unit_price: null } as SalesOrderLineRow;
    renderForm({ order: order(), lines: [synced, unsynced], shipTos: [dock] });
    expect(priceInputs()).toEqual(['11.25', '12.50']);
  });

  it('the estimate uses the customer price group price; quantity crossing the minimum changes it', () => {
    const ctx = {
      ...context,
      priceListLines: [
        priceLine({ id: 'p1', unit_price: 10, minimum_quantity: 0 }),
        priceLine({ id: 'p2', unit_price: 9, minimum_quantity: 5 }),
        priceLine({ id: 'p3', source_no: 'OTHER', unit_price: 1 }),
        priceLine({ id: 'p4', amount_type: 'Discount', unit_price: 0, line_discount_percent: 4 }),
      ],
    };
    const row = { ...lineRow, bc_unit_price: null, discount_percent: null } as SalesOrderLineRow;
    renderForm({ order: order(), lines: [row], shipTos: [dock], context: ctx });
    expect(priceInputs()).toEqual(['10.00']);
    expect(screen.getByLabelText('Disc %')).toHaveValue(4);
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '5' } });
    expect(priceInputs()).toEqual(['9.00']);
  });

  it('the estimate falls back to the item price for a customer without a matching price group', () => {
    const ctx = { ...context, priceListLines: [priceLine({ unit_price: 10 })] };
    const row = { ...lineRow, bc_unit_price: null } as SalesOrderLineRow;
    renderForm({ order: order({ customer_id: 'cust-2', customer_number: 'C2' }), lines: [row], context: ctx });
    expect(priceInputs()).toEqual(['12.50']);
  });

  it('the estimate follows the order date (a list that has not started yet does not apply)', () => {
    const ctx = { ...context, priceListLines: [priceLine({ unit_price: 10, starting_date: '2026-12-01' })] };
    const row = { ...lineRow, bc_unit_price: null } as SalesOrderLineRow;
    renderForm({ order: order(), lines: [row], shipTos: [dock], context: ctx });
    expect(priceInputs()).toEqual(['12.50']);
    fireEvent.change(screen.getByLabelText('Order date'), { target: { value: '2026-12-02' } });
    expect(priceInputs()).toEqual(['10.00']);
  });

  it('a typed price is saved when the form is submitted without leaving the field (Enter)', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'so-1' });
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '9.5' } });
    fireEvent.change(screen.getByLabelText('Disc %'), { target: { value: '3' } });
    fireEvent.submit(screen.getByLabelText('Unit price').closest('form')!);
    await waitFor(() => expect(orderActions.saveSalesOrder).toHaveBeenCalled());
    expect(orderActions.saveSalesOrder.mock.calls[0][0].lines[0]).toMatchObject({ unit_price: 9.5, discount_percent: 3 });
  });

  it('saves a blank discount as null', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'so-1' });
    const row = { ...lineRow, discount_percent: null } as SalesOrderLineRow;
    renderForm({ order: order(), lines: [row], shipTos: [dock] });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(orderActions.saveSalesOrder).toHaveBeenCalled());
    expect(orderActions.saveSalesOrder.mock.calls[0][0].lines[0].discount_percent).toBeNull();
  });

  it('a synced, unchanged order shows BC’s totals; line amounts are excl. tax', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock], context: taxed });
    expect(totals()).toEqual(['100.00', '8.25', '108.25']);
    expect(screen.getByText('Tax (8.25%)')).toBeInTheDocument();
    expect(screen.getByText('25.00', { selector: 'td div' })).toBeInTheDocument();
  });

  it('editing a synced order switches to live totals marked as an estimate', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock], context: taxed });
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '4' } });
    expect(totals()).toEqual(['50.00', '4.13', '54.13']);
    expect(screen.getByText('Tax (8.25%)')).toBeInTheDocument();
  });

  it('a header change (not tax liable) also switches to live totals', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock], context: taxed });
    fireEvent.click(screen.getByRole('switch', { name: 'Tax liable' }));
    expect(totals()).toEqual(['25.00', '0.00', '25.00']);
  });

  it('changing a synced line’s quantity drops BC’s price so the estimate takes over', () => {
    const synced = { ...lineRow, bc_unit_price: 11.25 } as SalesOrderLineRow;
    renderForm({ order: order(), lines: [synced], shipTos: [dock] });
    expect(priceInputs()).toEqual(['11.25']);
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '3' } });
    expect(priceInputs()).toEqual(['12.50']);
  });

  it('picking a customer loads that customer’s price lines and prices new lines from them', async () => {
    orderActions.getSalesOrderPriceLines.mockResolvedValueOnce([priceLine({ source_type: 'Customer', source_no: 'C2', unit_price: 7 })]);
    renderForm();
    pickCustomer('C2 – Beta Bakery');
    expect(orderActions.getSalesOrderPriceLines).toHaveBeenCalledWith('C2');
    addItem('P100 – Pesto sauce');
    await waitFor(() => expect(priceInputs()).toEqual(['7.00']));
  });

  it('switching customer drops BC’s price for the estimate; switching back restores it', () => {
    const ctx = { ...context, priceListLines: [priceLine({ unit_price: 4.5 })] };
    const synced = { ...lineRow, bc_unit_price: 2.73 } as SalesOrderLineRow;
    renderForm({ order: order(), lines: [synced], shipTos: [dock], context: ctx });
    expect(priceInputs()).toEqual(['2.73']);
    pickCustomer('C2 – Beta Bakery');
    expect(priceInputs()).toEqual(['12.50']);
    pickCustomer('C1 – Acme Foods');
    expect(priceInputs()).toEqual(['2.73']);
  });

  it('a pending order shows live totals', () => {
    renderForm({ order: order({ sync_state: 'pending' }), lines: [lineRow], shipTos: [dock], context: taxed });
    expect(totals()).toEqual(['25.00', '2.06', '27.06']);
    expect(screen.getByText('Tax (8.25%)')).toBeInTheDocument();
    expect(screen.getByText('Sending to BC…')).toBeInTheDocument();
  });

  it('adding an item updates Subtotal, Tax and Total right away', () => {
    renderForm({ context: taxed });
    pickCustomer('C1 – Acme Foods');
    expect(totals()).toEqual(['0.00', '0.00', '0.00']);
    expect(screen.getByText('Tax')).toBeInTheDocument();
    addItem('P100 – Pesto sauce');
    expect(totals()).toEqual(['12.50', '1.03', '13.53']);
    expect(screen.getByText('12.50', { selector: 'td div' })).toBeInTheDocument();
  });

  it('changing customer (a new estimate) updates the amounts', () => {
    renderForm({ context: { ...taxed, priceListLines: [priceLine({ unit_price: 20 })] } });
    pickCustomer('C1 – Acme Foods');
    addItem('P100 – Pesto sauce');
    expect(totals()).toEqual(['20.00', '1.65', '21.65']);
    pickCustomer('C2 – Beta Bakery');
    expect(totals()).toEqual(['12.50', '0.00', '12.50']);
  });

  it('a new order shows no sync badge and no Delete', () => {
    renderForm();
    expect(screen.queryByText('In BC')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete order' })).toBeNull();
  });
});

describe('SalesOrderForm — status and locking', () => {
  it('a Final order disables every field except Status', () => {
    renderForm({ order: order({ status: 'final' }), lines: [lineRow], shipTos: [dock] });
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Customer' })).toBeDisabled();
    expect(screen.getByLabelText('Invoice # (Ext. Doc No.)')).toBeDisabled();
    expect(screen.getByLabelText('Customer PO')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Edit billing address' })).toBeNull();
    expect(screen.getByLabelText('Order date')).toBeDisabled();
    expect(screen.getByLabelText('Requested delivery date')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Edit ship-to' })).toBeNull();
    expect(screen.getByLabelText('Payment terms')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Tax liable' })).toBeDisabled();
    expect(screen.getByLabelText('Qty')).toBeDisabled();
    expect(screen.queryByPlaceholderText('Add item…')).toBeNull();
  });

  it('picking a status on a locked order saves it at once with setSalesOrderStatus (no Save click, no BC sync)', async () => {
    orderActions.setSalesOrderStatus.mockResolvedValue({ ok: true });
    renderForm({ order: order({ status: 'final' }), lines: [lineRow], shipTos: [dock] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'pulled' } });
    await waitFor(() => expect(orderActions.setSalesOrderStatus).toHaveBeenCalledWith('so-1', 'pulled'));
    expect(orderActions.saveSalesOrder).not.toHaveBeenCalled();
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('picking a status on an unchanged draft saves only the status', async () => {
    orderActions.setSalesOrderStatus.mockResolvedValue({ ok: true });
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'final' } });
    await waitFor(() => expect(orderActions.setSalesOrderStatus).toHaveBeenCalledWith('so-1', 'final'));
    expect(orderActions.saveSalesOrder).not.toHaveBeenCalled();
  });

  it('picking a status on a draft with other unsaved edits saves everything with the new status', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'so-1' });
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.change(screen.getByLabelText('Customer PO'), { target: { value: 'PO-NEW' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'final' } });
    await waitFor(() =>
      expect(orderActions.saveSalesOrder).toHaveBeenCalledWith(expect.objectContaining({ status: 'final', customer_po: 'PO-NEW' })),
    );
    expect(orderActions.setSalesOrderStatus).not.toHaveBeenCalled();
  });

  it('a new order keeps the picked status without saving', () => {
    renderForm({ order: null, lines: [] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'final' } });
    expect(orderActions.saveSalesOrder).not.toHaveBeenCalled();
    expect(orderActions.setSalesOrderStatus).not.toHaveBeenCalled();
  });

  it('a failed status change shows the error and puts the status back', async () => {
    orderActions.setSalesOrderStatus.mockResolvedValue({ ok: false, error: 'Status refused' });
    renderForm({ order: order({ status: 'final' }), lines: [lineRow], shipTos: [dock] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'draft' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Status refused');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('final');
  });

  it('a failed save shows the error in the alert banner', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: false, error: 'This order was changed by someone else. Reload and try again.' });
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This order was changed by someone else. Reload and try again.');
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('Delete shows for Draft and Final only', () => {
    renderForm({ order: order({ status: 'pulled' }), lines: [lineRow], shipTos: [dock] });
    expect(screen.queryByRole('button', { name: 'Delete order' })).toBeNull();
    cleanup();
    renderForm({ order: order({ status: 'final' }), lines: [lineRow], shipTos: [dock] });
    expect(screen.getByRole('button', { name: 'Delete order' })).toBeInTheDocument();
  });

  it('Delete asks for confirmation, then deletes and goes back to the list', async () => {
    orderActions.deleteSalesOrder.mockResolvedValue({ ok: true });
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete order' }));
    expect(orderActions.deleteSalesOrder).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete order' }));
    await waitFor(() => expect(orderActions.deleteSalesOrder).toHaveBeenCalledWith('so-1'));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/sales-orders'));
  });

  it('read-only without edit permission', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock], canEdit: false });
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete order' })).toBeNull();
  });

  it('shows a blocked/missing customer by its stored number and name', () => {
    renderForm({ order: order({ customer_number: 'C9', customer_id: 'cust-9', bill_name: 'Gone Co' }), lines: [], shipTos: [] });
    expect(screen.getByRole('combobox', { name: 'Customer' })).toHaveValue('C9 – Gone Co');
  });

  it('Try again on a failed order calls the retry action', async () => {
    orderActions.retrySalesOrderSync.mockResolvedValue({ ok: true, state: 'synced' });
    renderForm({ order: order({ sync_state: 'failed', sync_error: 'Boom' }), lines: [lineRow], shipTos: [dock] });
    expect(screen.getByText('Failed: Boom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(orderActions.retrySalesOrderSync).toHaveBeenCalledWith('so-1'));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('offers Try again on a pending order nobody is syncing that was last updated long ago', async () => {
    orderActions.retrySalesOrderSync.mockResolvedValue({ ok: true, state: 'synced' });
    renderForm({
      order: order({ sync_state: 'pending', claimed_until: null, updated_at: '2026-01-01T00:00:00.000Z' }),
      lines: [lineRow],
      shipTos: [dock],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(orderActions.retrySalesOrderSync).toHaveBeenCalledWith('so-1'));
  });
});

describe('SalesOrderForm — invoice #', () => {
  const invoice = () => screen.getByLabelText(/Invoice #/) as HTMLInputElement;

  it('shows order # / customer PO while auto, following the PO', () => {
    renderForm({ order: order(), lines: [lineRow] });
    expect(invoice().value).toBe('SO-10234 / PO-1');
    fireEvent.change(screen.getByLabelText('Customer PO'), { target: { value: 'PO-2' } });
    expect(invoice().value).toBe('SO-10234 / PO-2');
  });

  it('confirms a manual change on blur, and Undo restores the auto value', async () => {
    renderForm({ order: order(), lines: [lineRow] });
    fireEvent.focus(invoice());
    fireEvent.change(invoice(), { target: { value: 'INV-7' } });
    fireEvent.blur(invoice());
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('You changed the invoice number from SO-10234 / PO-1 to INV-7. Keep it?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invoice().value).toBe('SO-10234 / PO-1');
  });

  it('uses "set" wording when there was no previous invoice number', async () => {
    renderForm({ order: order({ bc_order_number: null, customer_po: '' }), lines: [lineRow] });
    fireEvent.focus(invoice());
    fireEvent.change(invoice(), { target: { value: 'INV-7' } });
    fireEvent.blur(invoice());
    expect(await screen.findByRole('dialog')).toHaveTextContent('You set the invoice number to INV-7. Keep it?');
  });

  it('does not open the dialog when the value is unchanged', () => {
    renderForm({ order: order(), lines: [lineRow] });
    fireEvent.focus(invoice());
    fireEvent.change(invoice(), { target: { value: 'X' } });
    fireEvent.change(invoice(), { target: { value: 'SO-10234 / PO-1' } });
    fireEvent.blur(invoice());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Keep leaves the manual value', async () => {
    renderForm({ order: order(), lines: [lineRow] });
    fireEvent.focus(invoice());
    fireEvent.change(invoice(), { target: { value: 'INV-7' } });
    fireEvent.blur(invoice());
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invoice().value).toBe('INV-7');
  });

  it('Enter after a manual change asks first; Keep then saves with the new number', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'so-1' });
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.focus(invoice());
    fireEvent.change(invoice(), { target: { value: 'INV-7' } });
    fireEvent.keyDown(invoice(), { key: 'Enter' });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('to INV-7. Keep it?');
    expect(orderActions.saveSalesOrder).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(orderActions.saveSalesOrder).toHaveBeenCalledTimes(1));
    expect(orderActions.saveSalesOrder.mock.calls[0][0].invoice_number).toBe('INV-7');
  });

  it('Enter then Undo restores the number and does not save', async () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    fireEvent.focus(invoice());
    fireEvent.change(invoice(), { target: { value: 'INV-7' } });
    fireEvent.keyDown(invoice(), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invoice().value).toBe('SO-10234 / PO-1');
    expect(orderActions.saveSalesOrder).not.toHaveBeenCalled();
  });

  it('clearing the field shows the auto value again', () => {
    renderForm({ order: order({ invoice_number: 'INV-1' }), lines: [lineRow] });
    expect(invoice().value).toBe('INV-1');
    fireEvent.change(invoice(), { target: { value: '' } });
    expect(invoice().value).toBe('SO-10234 / PO-1');
  });
});

describe('SalesOrderForm — layout', () => {
  it('the title reads Order W-100531', () => {
    renderForm({ order: order({ bc_order_number: 'W-100531' }), lines: [lineRow], shipTos: [dock] });
    expect(screen.getByRole('heading', { name: 'Order W-100531' })).toBeInTheDocument();
  });

  it('the title is just Order before BC assigns a number', () => {
    renderForm();
    expect(screen.getByRole('heading', { name: 'Order' })).toBeInTheDocument();
  });

  it('the Save button sits in the header, submits the form and saves', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'new-1' });
    renderForm();
    pickCustomer('C1 – Acme Foods');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.closest('header')).not.toBeNull();
    expect(save).toHaveAttribute('form');
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
    fireEvent.click(save);
    await waitFor(() => expect(orderActions.saveSalesOrder).toHaveBeenCalledTimes(1));
  });

  it('Delete sits in the header', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    expect(screen.getByRole('button', { name: 'Delete order' }).closest('header')).not.toBeNull();
  });

  it('header order: sync state above Status, Save, then the Delete icon', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    const header = screen.getByRole('banner');
    const status = within(header).getByRole('status');
    const buttons = within(header).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(buttons.slice(-2)).toEqual(['Save', 'Delete order']);
    expect(within(header).getByRole('button', { name: 'Delete order' })).toHaveTextContent('');
    expect(status.compareDocumentPosition(within(header).getByRole('button', { name: 'Save' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the posting groups and the removed dates', () => {
    renderForm({ order: order(), lines: [lineRow], shipTos: [dock] });
    for (const t of ['Due date', 'Posting date', 'Gen. bus. posting group', 'Customer posting group']) {
      expect(screen.queryByText(t)).toBeNull();
    }
  });

  it('still saves the hidden posting groups', async () => {
    orderActions.saveSalesOrder.mockResolvedValue({ ok: true, id: 'o1' });
    renderForm();
    pickCustomer('C1 – Acme Foods');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(orderActions.saveSalesOrder).toHaveBeenCalled());
    expect(orderActions.saveSalesOrder.mock.calls[0][0]).toMatchObject({ gen_bus_posting_group: 'DOM', customer_posting_group: 'DOMESTIC' });
  });

  it('has Delivery method, Order Items and Invoicing', () => {
    renderForm();
    expect(screen.getByLabelText('Delivery method')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Order Items' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invoicing' })).toBeInTheDocument();
    expect(screen.getByLabelText('Payment terms')).toBeInTheDocument();
    expect(screen.getByLabelText('Tax area')).toBeInTheDocument();
  });

  it('orders the Order block fields: Customer PO, Invoice #, Delivery method, Requested delivery date', () => {
    renderForm();
    const els = ['Customer PO', 'Invoice # (Ext. Doc No.)', 'Delivery method', 'Requested delivery date'].map((l) => screen.getByLabelText(l));
    for (let i = 0; i < els.length - 1; i++) {
      expect(els[i].compareDocumentPosition(els[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('stacks the Order block fields in a single column', () => {
    renderForm();
    const box = screen.getByTestId('order-fields');
    expect(box.className).not.toMatch(/grid-cols/);
  });

  it('form inputs use the field colour in dark mode too', () => {
    renderForm();
    for (const l of ['Customer PO', 'Invoice # (Ext. Doc No.)', 'Order date', 'Requested delivery date']) {
      expect(screen.getByLabelText(l).className).toContain('dark:bg-field');
    }
  });
});

describe('invoicing in the header', () => {
  const final = (over: Partial<SalesOrderRow> = {}) => order({ status: 'final', ...over });
  const withLine = (over: Partial<Props> = {}) => renderForm({ order: final(), lines: [lineRow], ...over });

  it('shows Create invoice for a synced final order, disabled with unsaved edits', () => {
    withLine();
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Customer PO'), { target: { value: 'PO-2' } });
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeDisabled();
    expect(screen.getByText('Save your changes before invoicing.')).toBeInTheDocument();
  });
  it('blocked: disables the button and shows the reason', () => {
    withLine({ invoiceBlockedReason: 'Bill.com is turned off. Turn it on in Settings before invoicing.' });
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeDisabled();
    expect(screen.getByText('Bill.com is turned off. Turn it on in Settings before invoicing.')).toBeInTheDocument();
  });
  it('hides Create invoice for a draft order', () => {
    renderForm({ order: order(), lines: [lineRow] });
    expect(screen.queryByRole('button', { name: 'Create invoice' })).toBeNull();
  });
  it('past posting hides Save and Delete and shows the status instead of the BC sync state', () => {
    renderForm({ order: final({ status: 'invoiced', invoice_state: 'done', bc_posted_invoice_number: 'SI-1', bc_posted_invoice_id: 'inv-guid' }), lines: [lineRow] });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete order' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Invoiced · In Bill.com');
    expect(screen.queryByText('In BC')).toBeNull();
    expect(screen.getByRole('link', { name: 'View invoice' })).toHaveAttribute('href', '/receivables/invoices/inv-guid');
    expect(screen.getByText('Invoice SI-1 ·')).toBeInTheDocument();
    expect(screen.queryByText('Appears in Receivables after the next Receivables sync.')).toBeNull();
  });
  it('the Status dropdown shows Invoiced for an invoiced order, and a fresh key picks up the new status', () => {
    const props: Omit<Props, 'order'> = { lines: [lineRow], context, shipTos: [], canEdit: true, canSaveShipTo: true };
    const { rerender } = render(<SalesOrderForm key="so-1:3:posting" order={final({ invoice_state: 'posting' })} {...props} />);
    expect(screen.getByLabelText('Status')).toHaveTextContent('Final');
    rerender(<SalesOrderForm key="so-1:3:done" order={final({ status: 'invoiced', invoice_state: 'done' })} {...props} />);
    expect(screen.getByLabelText('Status')).toHaveTextContent('Invoiced');
  });
  describe('polling', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it('refreshes every 3 s while running, caps at 40, and stops on unmount', () => {
      renderForm({ order: final({ status: 'final', invoice_state: 'posting' }), lines: [lineRow] });
      vi.advanceTimersByTime(9000);
      expect(nav.refresh).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(3000 * 60);
      expect(nav.refresh).toHaveBeenCalledTimes(40);
      cleanup();
      nav.refresh.mockClear();
      const second = renderForm({ order: final({ invoice_state: 'billcom_sending' }), lines: [lineRow] });
      second.unmount();
      vi.advanceTimersByTime(10000);
      expect(nav.refresh).not.toHaveBeenCalled();
    });
    it('does not poll once the state is settled', () => {
      renderForm({ order: final({ invoice_state: 'done' }), lines: [lineRow] });
      vi.advanceTimersByTime(10000);
      expect(nav.refresh).not.toHaveBeenCalled();
    });
    it('stops when the state leaves the running set', () => {
      const props: Omit<Props, 'order'> = { lines: [lineRow], context, shipTos: [], canEdit: true, canSaveShipTo: true };
      const { rerender } = render(<SalesOrderForm order={final({ invoice_state: 'posting' })} {...props} />);
      vi.advanceTimersByTime(3000);
      expect(nav.refresh).toHaveBeenCalledTimes(1);
      rerender(<SalesOrderForm order={final({ invoice_state: 'done' })} {...props} />);
      vi.advanceTimersByTime(10000);
      expect(nav.refresh).toHaveBeenCalledTimes(1);
    });
  });
  it('post_failed hides Delete (BC may hold the posted invoice) but keeps Save', () => {
    withLine({ order: final({ invoice_state: 'post_failed', invoice_error: 'x' }) });
    expect(screen.queryByRole('button', { name: 'Delete order' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
  it('post_failed and In BC: shows only the invoice status in the status line', () => {
    withLine({ order: final({ invoice_state: 'post_failed', invoice_error: 'x' }) });
    expect(screen.getByText("Couldn't post")).toBeInTheDocument();
    expect(screen.queryByText('In BC')).toBeNull();
  });
  it('post_failed and not In BC: shows the sync state with Try again beside the invoice status', async () => {
    orderActions.retrySalesOrderSync.mockResolvedValue({ ok: true, state: 'synced' });
    withLine({ order: final({ invoice_state: 'post_failed', invoice_error: 'x', sync_state: 'failed', sync_error: 'Boom' }) });
    expect(screen.getByText("Couldn't post")).toBeInTheDocument();
    expect(screen.getByText('Failed: Boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(orderActions.retrySalesOrderSync).toHaveBeenCalledWith('so-1'));
  });
  it('post_failed and Changed in BC: offers Overwrite', () => {
    withLine({ order: final({ invoice_state: 'post_failed', invoice_error: 'x', sync_state: 'conflict', sync_error: 'Changed in BC' }) });
    expect(screen.getByText('Changed in BC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Overwrite/ })).toBeInTheDocument();
  });
  it('shows BC\'s message in the notice bar when posting failed, and Retry', () => {
    withLine({ order: final({ invoice_state: 'post_failed', invoice_error: 'Posting date not allowed' }) });
    expect(screen.getByText('Posting date not allowed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('changing an invoice', () => {
  const invoiced = (over: Partial<SalesOrderRow> = {}) =>
    order({ status: 'invoiced', invoice_state: 'done', bc_posted_invoice_number: 'INV-100411', bc_posted_invoice_id: 'inv-guid', invoice_number: 'W-100528', ...over });
  const priced = { ...lineRow, unit_price: 12.5 } as SalesOrderLineRow;

  it('Change invoice unlocks only the lines, with the bar and Cancel changes', () => {
    renderForm({ order: invoiced(), lines: [priced] });
    expect(screen.getByLabelText('Qty')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Change invoice' }));
    expect(screen.getByText('Changing invoice W-100528 — edit lines, then Save changes to invoice.')).toBeInTheDocument();
    expect(screen.getByLabelText('Qty')).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Customer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes to invoice' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '3' } });
    expect(screen.getByRole('button', { name: 'Save changes to invoice' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel changes' }));
    expect(screen.getByLabelText('Qty')).toBeDisabled();
    expect(screen.getByLabelText('Qty')).toHaveValue(2);
  });

  it('Save changes to invoice asks for a reason, then starts the change with the edited lines', async () => {
    changeActions.startChangeInvoice.mockResolvedValue({ ok: true });
    renderForm({ order: invoiced(), lines: [priced] });
    fireEvent.click(screen.getByRole('button', { name: 'Change invoice' }));
    fireEvent.change(screen.getByLabelText('Qty'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes to invoice' }));
    expect(screen.getByText("BC will cancel INV-100411 and post a corrected invoice. This can't be undone.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Customer got 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(changeActions.startChangeInvoice).toHaveBeenCalled());
    const [id, drafts, reason] = changeActions.startChangeInvoice.mock.calls[0];
    expect(id).toBe('so-1');
    expect(reason).toBe('Customer got 3');
    expect(drafts).toEqual([expect.objectContaining({ id: 'l1', item_number: 'P100', quantity: 3 })]);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('a line added during the change carries the price-list estimate the table shows, not the item base price', async () => {
    changeActions.startChangeInvoice.mockResolvedValue({ ok: true });
    const ctx = { ...context, priceListLines: [priceLine({ unit_price: 10 })] };
    renderForm({ order: invoiced(), lines: [priced], context: ctx });
    fireEvent.click(screen.getByRole('button', { name: 'Change invoice' }));
    addItem('P100 – Pesto sauce');
    expect(priceInputs()[1]).toBe('10.00');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes to invoice' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'More' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(changeActions.startChangeInvoice).toHaveBeenCalled());
    const [, drafts] = changeActions.startChangeInvoice.mock.calls[0];
    expect(drafts[1]).toEqual(expect.objectContaining({ item_number: 'P100', estimate_price: 10 }));
  });

  it('Change invoice is disabled with the Bill.com reason', () => {
    renderForm({ order: invoiced(), lines: [priced], changeBlockedReason: "Paid or partly paid in Bill.com — can't change" });
    expect(screen.getByRole('button', { name: 'Change invoice' })).toBeDisabled();
  });

  it('an open change shows its lines locked, the status and no Change invoice button', () => {
    const change = {
      id: 'ch1', state: 'post_failed', error: 'Posting Date is not within your range.', old_bc_invoice_number: 'INV-100411',
      lines_after: [{ item_number: 'P100', description: 'Pesto sauce', unit_of_measure_code: 'CASE', quantity: 5, unit_price: 12.5, discount_percent: 0 }],
    } as unknown as InvoiceChangeRow;
    renderForm({ order: invoiced({ invoice_state: 'changing' }), lines: [priced], invoiceChange: change });
    expect(screen.getByLabelText('Qty')).toHaveValue(5);
    expect(screen.getByLabelText('Qty')).toBeDisabled();
    expect(screen.getByText('Changing invoice…')).toBeInTheDocument();
    expect(screen.getByText('Posting Date is not within your range.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change invoice' })).toBeNull();
  });
});

describe('Update Customer (delivery method)', () => {
  const pick = (code: string) => fireEvent.change(screen.getByLabelText('Delivery method'), { target: { value: code } });
  const button = () => screen.queryByRole('button', { name: 'Update Customer' });

  it("shows Update Customer when the order's method differs and saves it", async () => {
    customerActions.setCustomerDeliveryMethod.mockResolvedValue({ ok: true });
    renderForm({ order: order({ shipment_method_code: 'UPS' }) });
    expect(button()).toBeNull();
    pick('GROUND');
    fireEvent.click(button()!);
    await waitFor(() => expect(customerActions.setCustomerDeliveryMethod).toHaveBeenCalledWith('cust-1', 'GROUND'));
    expect(await screen.findByText("Saved as C1's default delivery method.")).toBeInTheDocument();
    expect(button()).toBeNull();
  });

  it('hidden when the method matches the customer', () => {
    renderForm({ order: order({ shipment_method_code: 'UPS' }) });
    expect(button()).toBeNull();
  });

  it('hidden without canSaveShipTo', () => {
    renderForm({ order: order({ shipment_method_code: 'UPS' }), canSaveShipTo: false });
    pick('GROUND');
    expect(button()).toBeNull();
  });

  it('no customer, no button', () => {
    renderForm();
    pick('GROUND');
    expect(button()).toBeNull();
  });

  it('saves a blank method', async () => {
    customerActions.setCustomerDeliveryMethod.mockResolvedValue({ ok: true });
    renderForm({ order: order({ shipment_method_code: 'UPS' }) });
    pick('');
    fireEvent.click(button()!);
    await waitFor(() => expect(customerActions.setCustomerDeliveryMethod).toHaveBeenCalledWith('cust-1', ''));
  });

  it('shows the error from the save in place', async () => {
    customerActions.setCustomerDeliveryMethod.mockResolvedValue({ ok: false, error: "You don't have permission to change customers" });
    renderForm({ order: order({ shipment_method_code: 'UPS' }) });
    pick('GROUND');
    fireEvent.click(button()!);
    expect(await screen.findByText("You don't have permission to change customers")).toBeInTheDocument();
    expect(button()).not.toBeNull();
  });
});
