import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesOrderNoteView } from '@/types/salesOrders';
import { NotesPanel } from './NotesPanel';

const actions = vi.hoisted(() => ({
  addSalesOrderNote: vi.fn(),
  updateSalesOrderNote: vi.fn(),
  deleteSalesOrderNote: vi.fn(),
}));
vi.mock('@/app/actions/salesOrderNotes', () => actions);

const note = (id: string, body: string, extra: Partial<SalesOrderNoteView> = {}): SalesOrderNoteView => ({
  id, organization_id: 'org-1', bc_connection_id: 'conn-1', sales_order_id: 'o1', body,
  created_by: 'u1', created_at: '2026-11-01T10:00:00.000Z', updated_by: null, updated_at: '2026-11-01T10:00:00.000Z',
  author_name: 'Frank', ...extra,
});

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('NotesPanel', () => {
  it('shows a hint instead of the add box when the order is not saved', () => {
    render(<NotesPanel orderId={null} canEdit initialNotes={[]} />);
    expect(screen.getByText('Save the order to add notes.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('shows each note with author, time and (edited) only when changed', () => {
    render(
      <NotesPanel
        orderId="o1"
        canEdit
        initialNotes={[note('n1', 'First'), note('n2', 'Second', { updated_at: '2026-11-02T10:00:00.000Z' })]}
      />,
    );
    const when = new Date('2026-11-01T10:00:00.000Z').toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const cards = screen.getAllByRole('listitem');
    expect(within(cards[0]).getByText('First')).toBeInTheDocument();
    expect(within(cards[0]).getByText(new RegExp(`Frank.*${when}`))).toBeInTheDocument();
    expect(within(cards[0]).queryByText('(edited)')).toBeNull();
    expect(within(cards[1]).getByText('(edited)')).toBeInTheDocument();
  });

  it('adding a note puts a new card at the top and clears the box', async () => {
    actions.addSalesOrderNote.mockResolvedValue({ ok: true, note: note('n2', 'Brand new') });
    render(<NotesPanel orderId="o1" canEdit initialNotes={[note('n1', 'Old one')]} />);
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'Brand new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Brand new'));
    expect(actions.addSalesOrderNote).toHaveBeenCalledWith('o1', 'Brand new');
    expect(screen.getByLabelText('New note')).toHaveValue('');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the server error when adding fails', async () => {
    actions.addSalesOrderNote.mockResolvedValue({ ok: false, error: 'Nope' });
    render(<NotesPanel orderId="o1" canEdit initialNotes={[]} />);
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');
  });

  it('editing then saving updates the text', async () => {
    actions.updateSalesOrderNote.mockResolvedValue({
      ok: true,
      note: note('n1', 'Changed', { updated_at: '2026-11-03T10:00:00.000Z' }),
    });
    render(<NotesPanel orderId="o1" canEdit initialNotes={[note('n1', 'Old one')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    fireEvent.change(screen.getByLabelText('Edit note text'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Changed')).toBeInTheDocument());
    expect(actions.updateSalesOrderNote).toHaveBeenCalledWith('n1', 'Changed');
    expect(screen.getByText('(edited)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Edit note text')).toBeNull();
  });

  it('cancel leaves the note unchanged', () => {
    render(<NotesPanel orderId="o1" canEdit initialNotes={[note('n1', 'Old one')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit note' }));
    fireEvent.change(screen.getByLabelText('Edit note text'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Old one')).toBeInTheDocument();
    expect(actions.updateSalesOrderNote).not.toHaveBeenCalled();
  });

  it('delete asks first, then removes the note', async () => {
    actions.deleteSalesOrderNote.mockResolvedValue({ ok: true });
    render(<NotesPanel orderId="o1" canEdit initialNotes={[note('n1', 'Old one')]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }));
    expect(actions.deleteSalesOrderNote).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Old one')).toBeNull());
    expect(actions.deleteSalesOrderNote).toHaveBeenCalledWith('n1');
  });

  it('read-only users see notes without the add box or icons', () => {
    render(<NotesPanel orderId="o1" canEdit={false} initialNotes={[note('n1', 'Old one')]} />);
    expect(screen.getByText('Old one')).toBeInTheDocument();
    expect(screen.queryByLabelText('New note')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete note' })).toBeNull();
  });
});
