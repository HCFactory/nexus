import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusinessCentralConnection } from '@/types/database';
import { BcEnvironmentForm } from './BcEnvironmentForm';

afterEach(cleanup);

const connection = (over: Partial<BusinessCentralConnection> = {}) =>
  ({ id: 'c1', display_name: 'Production', environment: 'Production', api_base_url: '', time_zone: 'Pacific/Honolulu', billcom_via_connector: false, billcom_connection_id: null, stripe_connection_id: null, ...over }) as BusinessCentralConnection;

const SWITCH = "Bill.com invoices come from Bill.com's own BC connector";

describe('BcEnvironmentForm: Bill.com via its BC connector', () => {
  it('shows the saved value and submits a change', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<BcEnvironmentForm connection={connection({ billcom_via_connector: false })} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const box = screen.getByRole('checkbox', { name: SWITCH }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ billcomViaConnector: true })));
  });

  it('starts ticked when the connection has it on', () => {
    render(<BcEnvironmentForm connection={connection({ billcom_via_connector: true })} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByRole('checkbox', { name: SWITCH }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('BcEnvironmentForm: Bill.com and Stripe connection for this environment', () => {
  const billcomOptions = [{ id: 'bill-sandbox', label: 'Sandbox' }, { id: 'bill-prod', label: 'Production' }];
  const stripeOptions = [{ id: 'str-test', label: 'Test mode' }];

  it('shows the saved picks and submits changes; None clears', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <BcEnvironmentForm
        connection={connection({ billcom_connection_id: 'bill-sandbox', stripe_connection_id: null })}
        billcomOptions={billcomOptions}
        stripeOptions={stripeOptions}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const bill = screen.getByLabelText('Bill.com connection') as HTMLSelectElement;
    const stripe = screen.getByLabelText('Stripe connection') as HTMLSelectElement;
    expect(bill.value).toBe('bill-sandbox');
    expect(stripe.value).toBe('');
    expect([...bill.options].map((o) => o.textContent)).toEqual(['None', 'Sandbox', 'Production']);
    fireEvent.change(bill, { target: { value: '' } });
    fireEvent.change(stripe, { target: { value: 'str-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ billcomConnectionId: null, stripeConnectionId: 'str-test' })),
    );
  });
});

describe('BcEnvironmentForm: Sync automatically', () => {
  const AUTO = 'Sync automatically';
  it('is off by default and submits a change', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<BcEnvironmentForm connection={connection({})} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const box = screen.getByRole('checkbox', { name: AUTO }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ autoSync: true })));
  });

  it('starts ticked when the environment has it on', () => {
    render(<BcEnvironmentForm connection={connection({ auto_sync: true } as never)} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect((screen.getByRole('checkbox', { name: AUTO }) as HTMLInputElement).checked).toBe(true);
  });
});
