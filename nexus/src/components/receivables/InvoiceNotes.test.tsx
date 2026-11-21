import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  addSalesInvoiceNote: vi.fn(),
  updateSalesInvoiceNote: vi.fn(),
  deleteSalesInvoiceNote: vi.fn(),
}));
vi.mock('@/app/actions/salesInvoiceNotes', () => actions);
vi.mock('@/app/actions/salesOrderNotes', () => ({ addSalesOrderNote: vi.fn(), updateSalesOrderNote: vi.fn(), deleteSalesOrderNote: vi.fn() }));

import { InvoiceNotes } from './InvoiceNotes';

const note = (id: string, body: string) => ({
  id, organization_id: 'o', bc_connection_id: 'c', bc_invoice_id: 'inv-1', body, created_by: 'u1',
  created_at: '2026-11-01T10:00:00.000Z', updated_by: null, updated_at: '2026-11-01T10:00:00.000Z', author_name: 'Frank',
});

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('InvoiceNotes', () => {
  it('shows existing notes with their author', () => {
    render(<InvoiceNotes bcInvoiceId="inv-1" canEdit initialNotes={[note('n1', 'Customer will pay Friday')]} />);
    expect(screen.getByText('Customer will pay Friday')).toBeInTheDocument();
    expect(screen.getByText(/Frank/)).toBeInTheDocument();
  });

  it('adds, edits and deletes through the invoice note actions', async () => {
    actions.addSalesInvoiceNote.mockResolvedValue({ ok: true, note: note('n2', 'Left a voicemail') });
    actions.updateSalesInvoiceNote.mockResolvedValue({ ok: true, note: note('n2', 'Left two voicemails') });
    actions.deleteSalesInvoiceNote.mockResolvedValue({ ok: true });
    render(<InvoiceNotes bcInvoiceId="inv-1" canEdit initialNotes={[]} />);

    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'Left a voicemail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await waitFor(() => expect(actions.addSalesInvoiceNote).toHaveBeenCalledWith('inv-1', 'Left a voicemail'), { timeout: 5000 });
    expect(await screen.findByText('Left a voicemail', undefined, { timeout: 5000 })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByLabelText('New note')).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    fireEvent.change(screen.getByLabelText('Edit note text'), { target: { value: 'Left two voicemails' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(actions.updateSalesInvoiceNote).toHaveBeenCalledWith('n2', 'Left two voicemails'), { timeout: 5000 });
    expect(await screen.findByText('Left two voicemails', undefined, { timeout: 5000 })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByLabelText('New note')).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(actions.deleteSalesInvoiceNote).toHaveBeenCalledWith('n2'), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByText('Left two voicemails')).toBeNull(), { timeout: 5000 });
  });

  it('read-only: no add box and no edit or delete buttons', () => {
    render(<InvoiceNotes bcInvoiceId="inv-1" canEdit={false} initialNotes={[note('n1', 'Read me')]} />);
    expect(screen.queryByLabelText('New note')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
  });
});
