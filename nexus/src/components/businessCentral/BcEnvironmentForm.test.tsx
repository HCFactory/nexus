import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusinessCentralConnection } from '@/types/database';
import { BcEnvironmentForm } from './BcEnvironmentForm';

afterEach(cleanup);

const connection = (over: Partial<BusinessCentralConnection> = {}) =>
  ({ id: 'c1', display_name: 'Production', environment: 'Production', api_base_url: '', time_zone: 'Pacific/Honolulu', billcom_via_connector: false, ...over }) as BusinessCentralConnection;

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
