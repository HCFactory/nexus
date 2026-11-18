import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeInvoiceDialog } from './ChangeInvoiceDialog';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
afterEach(cleanup);

const renderDialog = (onConfirm = vi.fn<(reason: string) => Promise<string | null>>(async () => null), onClose = vi.fn()) => {
  render(<ChangeInvoiceDialog open oldTotal={24.62} newSubtotal={49} oldBcNumber="INV-100411" onConfirm={onConfirm} onClose={onClose} />);
  return { onConfirm, onClose };
};

describe('ChangeInvoiceDialog', () => {
  it('shows the totals, the tax note and the warning naming the old BC invoice', () => {
    renderDialog();
    expect(screen.getByText(/\$24\.62/)).toBeInTheDocument();
    expect(screen.getByText(/\$49\.00/)).toBeInTheDocument();
    expect(screen.getByText(/BC recalculates tax/)).toBeInTheDocument();
    expect(screen.getByText("BC will cancel INV-100411 and post a corrected invoice. This can't be undone.")).toBeInTheDocument();
  });

  it('Confirm stays disabled with an empty or whitespace reason', () => {
    renderDialog();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Customer got 2' } });
    expect(confirm).toBeEnabled();
  });

  it('limits the reason to 1000 characters with a counter', () => {
    renderDialog();
    expect(screen.getByLabelText('Reason')).toHaveAttribute('maxLength', '1000');
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'abc' } });
    expect(screen.getByText('3 / 1000')).toBeInTheDocument();
  });

  it('confirms with the reason; an error is shown and the dialog stays open', async () => {
    const { onConfirm, onClose } = renderDialog(vi.fn(async () => 'A change is already open for this invoice.'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Customer got 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A change is already open for this invoice.'));
    expect(onConfirm).toHaveBeenCalledWith('Customer got 2');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Back closes', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onClose).toHaveBeenCalled();
  });
});
