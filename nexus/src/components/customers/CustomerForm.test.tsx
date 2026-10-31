import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOMER_FIELDS } from '@/lib/businessCentral/customers/customerFields';
import { CustomerForm } from './CustomerForm';

const actions = vi.hoisted(() => ({ createCustomerAction: vi.fn(), updateCustomerAction: vi.fn() }));
vi.mock('@/app/actions/customerEditing', () => actions);

const templates = [
  { code: 'RETAIL', label: 'RETAIL — Retail', values: { payment_terms_code: 'N30', tax_area_code: 'CA' } },
  { code: 'WHOLE', label: 'WHOLE', values: { payment_terms_code: 'N60', tax_area_code: 'NY' } },
];
const selectOptions = {
  paymentTerms: [{ code: 'N30', label: 'N30' }, { code: 'N60', label: 'N60' }, { code: 'COD', label: 'COD' }],
  taxAreas: [{ code: 'CA', label: 'CA' }, { code: 'NY', label: 'NY' }],
};

const select = (label: RegExp) => screen.getByLabelText(label) as HTMLSelectElement;

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('create mode', () => {
  it('pre-fills payment terms and tax area from the chosen template, editable', async () => {
    const onDone = vi.fn();
    actions.createCustomerAction.mockResolvedValue({ ok: true, id: 'n1', number: 'C1', warning: 'w' });
    render(<CustomerForm customer={null} templates={templates} selectOptions={selectOptions} onDone={onDone} onCancel={vi.fn()} />);

    fireEvent.change(select(/customer template/i), { target: { value: 'RETAIL' } });
    expect(select(/payment terms/i).value).toBe('N30');
    expect(select(/tax area/i).value).toBe('CA');
    fireEvent.change(select(/payment terms/i), { target: { value: 'COD' } });
    expect(select(/payment terms/i).value).toBe('COD');

    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'ZZNEXUS A' } });
    fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: 'a@b.c' } });
    fireEvent.change(screen.getByLabelText(/^phone/i), { target: { value: '555' } });
    fireEvent.click(screen.getByRole('button', { name: /create customer/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ id: 'n1', warning: 'w' }));
    const input = actions.createCustomerAction.mock.calls[0][0];
    expect(input.templateCode).toBe('RETAIL');
    expect(input.values).toMatchObject({ display_name: 'ZZNEXUS A', email: 'a@b.c', phone_number: '555', payment_terms_code: 'COD', tax_area_code: 'CA' });
    expect(input.values).not.toHaveProperty('customer_posting_group');
  });

  it('hides template-only fields, Blocked and Credit limit', () => {
    render(<CustomerForm customer={null} templates={templates} selectOptions={selectOptions} onDone={vi.fn()} onCancel={vi.fn()} />);
    for (const label of [/customer posting group/i, /gen\. business/i, /customer price group/i, /tax liable/i, /application method/i, /^location/i, /^blocked/i, /credit limit/i]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(screen.getByLabelText(/invoice email cc/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/postal code/i)).toBeInTheDocument();
  });

  it('requires a template', () => {
    render(<CustomerForm customer={null} templates={templates} selectOptions={selectOptions} onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /create customer/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/choose a customer template/i);
    expect(actions.createCustomerAction).not.toHaveBeenCalled();
  });
});

describe('edit mode', () => {
  const values = { display_name: 'Acme', email: 'a@b.c', phone_number: '1', payment_terms_code: 'OLD', tax_area_code: 'CA', city: 'LA' };

  it('shows every customer field and keeps a current value missing from the options', () => {
    render(<CustomerForm customer={{ id: 'c1', values }} templates={templates} selectOptions={selectOptions} onDone={vi.fn()} onCancel={vi.fn()} />);
    for (const f of CUSTOMER_FIELDS) expect(screen.getByLabelText(new RegExp(`^${f.label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}( \\*)?$`, 'i'))).toBeInTheDocument();
    expect(screen.queryByLabelText(/customer template/i)).toBeNull();
    expect(select(/payment terms/i).value).toBe('OLD');
    expect(Array.from(select(/payment terms/i).options).map((o) => o.textContent)).toContain('OLD');
  });

  it('sends original and edited values to the update action', async () => {
    const onDone = vi.fn();
    actions.updateCustomerAction.mockResolvedValue({ ok: true });
    render(<CustomerForm customer={{ id: 'c1', values }} templates={templates} selectOptions={selectOptions} onDone={onDone} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^city/i), { target: { value: 'SF' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ id: 'c1' }));
    const input = actions.updateCustomerAction.mock.calls[0][0];
    expect(input.id).toBe('c1');
    expect(input.original).toBe(values);
    expect(input.edited.city).toBe('SF');
  });

  it('shows the server error', async () => {
    actions.updateCustomerAction.mockResolvedValue({ ok: false, error: 'BC said no' });
    render(<CustomerForm customer={{ id: 'c1', values }} templates={templates} selectOptions={selectOptions} onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^city/i), { target: { value: 'SF' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('BC said no');
  });
});
