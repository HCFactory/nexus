import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesOrderListRow } from '@/types/salesOrders';
import { SalesOrdersList } from './SalesOrdersList';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

function row(over: Partial<SalesOrderListRow>): SalesOrderListRow {
  return {
    id: 'o1', status: 'draft', customer_id: 'c1', customer_number: 'C1', customer_name: 'Acme',
    order_date: '2026-11-01', requested_delivery_date: null, invoice_number: null, bc_order_number: null,
    customer_po: 'PO-1', total_incl_tax: null, sync_state: 'synced', sync_error: null, ...over,
  };
}

const orders = [
  row({ id: 'o1', customer_name: 'Acme', bc_order_number: 'SO-100', invoice_number: 'INV-9', total_incl_tax: 1234.5 }),
  row({ id: 'o2', customer_name: 'Bolt', sync_state: 'failed', sync_error: 'Boom', status: 'final' }),
  row({ id: 'o3', customer_name: 'Cora', sync_state: 'conflict' }),
  row({ id: 'o4', customer_name: 'Dyna', sync_state: 'pending' }),
];

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SalesOrdersList', () => {
  it('shows the columns and row values', () => {
    render(<SalesOrdersList orders={orders} canEdit={false} />);
    for (const h of ['Order #', 'Invoice #', 'Customer', 'Customer PO', 'Order date', 'Total', 'Status', 'Sync']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    expect(screen.getByText('SO-100')).toBeInTheDocument();
    expect(screen.getByText('INV-9')).toBeInTheDocument();
    expect(screen.getByText('$1,234.50')).toBeInTheDocument();
    expect(screen.getAllByText('Not yet in BC')).toHaveLength(3);
    expect(screen.getByText('Final')).toBeInTheDocument();
  });

  it('Invoice # falls back to the BC order number (BC uses it as External Document No.)', () => {
    render(<SalesOrdersList orders={[row({ id: 'o9', bc_order_number: 'SO-200', invoice_number: null })]} canEdit={false} />);
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('SO-200');
    expect(cells[1]).toHaveTextContent('SO-200');
  });

  it('Invoice # falls back to order # / customer PO', () => {
    render(<SalesOrdersList orders={[row({ id: 'o9', bc_order_number: 'SO-200', invoice_number: null, customer_po: 'PO-5' })]} canEdit={false} />);
    expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1]).toHaveTextContent('SO-200 / PO-5');
  });

  it('Invoice # shows — when the order is not in BC and has no invoice #', () => {
    render(<SalesOrdersList orders={[row({ id: 'o9' })]} canEdit={false} />);
    expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1]).toHaveTextContent('—');
  });

  it('Needs attention shows only failed and conflict orders', () => {
    render(<SalesOrdersList orders={orders} canEdit={false} />);
    fireEvent.click(screen.getByRole('button', { name: /needs attention/i }));
    expect(screen.queryByText('Acme')).toBeNull();
    expect(screen.queryByText('Dyna')).toBeNull();
    expect(screen.getByText('Bolt')).toBeInTheDocument();
    expect(screen.getByText('Cora')).toBeInTheDocument();
    expect(within(screen.getAllByRole('row')[1]).getByText(/Failed: Boom/)).toBeInTheDocument();
  });

  it('a row click goes to the order', () => {
    render(<SalesOrdersList orders={orders} canEdit={false} />);
    fireEvent.click(screen.getByText('Bolt'));
    expect(nav.push).toHaveBeenCalledWith('/sales-orders/o2');
  });

  it('New sales order shows only with canEdit', () => {
    const { rerender } = render(<SalesOrdersList orders={orders} canEdit={false} />);
    expect(screen.queryByRole('link', { name: /new sales order/i })).toBeNull();
    rerender(<SalesOrdersList orders={orders} canEdit />);
    expect(screen.getByRole('link', { name: /new sales order/i })).toHaveAttribute('href', '/sales-orders/new');
  });
});
