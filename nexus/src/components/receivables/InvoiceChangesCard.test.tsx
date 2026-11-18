import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { InvoiceChangeRow } from '@/types/invoiceChanges';
import { InvoiceChangesCard } from './InvoiceChangesCard';

afterEach(cleanup);

const OLD = '143fbb46-e8e0-f111-84e4-7ced8d88ddac';
const NEW = '7aa0c3d1-0000-4000-8000-000000000415';
const line = { item_number: '20000', description: 'Candy', unit_of_measure_code: 'BOX', quantity: 1, unit_price: 24.5, discount_percent: 0 };
const change = (over: Partial<InvoiceChangeRow> = {}) =>
  ({
    id: 'ch1', state: 'done', error: null, reason: 'Customer got 2 boxes', changed_by_name: 'Pat Lee',
    created_at: '2026-11-17T10:05:00.000Z', old_bc_invoice_id: OLD, old_bc_invoice_number: 'INV-100411', old_total: 24.62,
    new_bc_invoice_id: NEW, new_bc_invoice_number: 'INV-100415', new_total: 30.1,
    lines_before: [line], lines_after: [{ ...line, quantity: 2 }],
    ...over,
  }) as InvoiceChangeRow;

describe('InvoiceChangesCard', () => {
  it('renders nothing without changes', () => {
    const { container } = render(<InvoiceChangesCard changes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows who, why, totals and BC numbers with links', () => {
    render(<InvoiceChangesCard changes={[change()]} />);
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeInTheDocument();
    expect(screen.getByText('Customer got 2 boxes')).toBeInTheDocument();
    expect(screen.getByText(/Pat Lee/)).toBeInTheDocument();
    expect(screen.getByText('$24.62 → $30.10')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'INV-100411' })).toHaveAttribute('href', `/receivables/invoices/${OLD}`);
    expect(screen.getByRole('link', { name: 'INV-100415' })).toHaveAttribute('href', `/receivables/invoices/${NEW}`);
  });

  it('Show lines toggles a before/after table', () => {
    render(<InvoiceChangesCard changes={[change()]} />);
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show lines' }));
    const rows = screen.getAllByRole('row');
    expect(rows.some((r) => /Before/.test(r.textContent ?? '') && /20000/.test(r.textContent ?? ''))).toBe(true);
    expect(rows.some((r) => /After/.test(r.textContent ?? '') && /2/.test(r.textContent ?? ''))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Hide lines' }));
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('an open or failed change shows its state; a discarded one says Discarded', () => {
    render(<InvoiceChangesCard changes={[change({ id: 'a', state: 'post_failed', new_total: null, new_bc_invoice_number: null, new_bc_invoice_id: null }), change({ id: 'b', state: 'discarded' })]} />);
    expect(screen.getByText("Couldn't post the corrected invoice")).toBeInTheDocument();
    expect(screen.getByText('Discarded')).toBeInTheDocument();
  });
});
