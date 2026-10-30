import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FriendsFamilyWorkspace } from '@/types/database';
import { FriendsFamilyOrderForm } from './FriendsFamilyOrderForm';
import { FriendsFamilyOrdersClient } from './FriendsFamilyOrdersClient';

const actions = vi.hoisted(() => ({
  createFriendsFamilyOrder: vi.fn(),
  createFriendsFamilyProduct: vi.fn(),
  deleteFriendsFamilyOrder: vi.fn(),
  getFriendsFamilyWorkspace: vi.fn(),
  updateFriendsFamilyOrder: vi.fn(),
  updateFriendsFamilyOrderStatus: vi.fn(),
  updateFriendsFamilyProduct: vi.fn(),
}));

vi.mock('@/app/actions/friendsFamilyOrders', () => actions);

const workspace: FriendsFamilyWorkspace = {
  products: [
    {
      id: 'product-1',
      organization_id: 'org-1',
      name: 'Family Pack',
      category: 'Bundles',
      unit_price: 12.5,
      color_key: 'blue',
      active: true,
      created_by: 'user-1',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    },
  ],
  orders: [
    {
      id: 'order-1',
      organization_id: 'org-1',
      order_number: 'FF-000001',
      order_sequence: 1,
      ordered_by: 'Alex Employee',
      customer_name: 'Jamie Friend',
      phone: '555-0100',
      email: 'jamie@example.com',
      fulfillment_status: 'new',
      payment_status: 'unpaid',
      notes: 'Front desk pickup',
      total_amount: 25,
      created_by: 'user-1',
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      items: [
        {
          id: 'line-1',
          order_id: 'order-1',
          product_id: 'product-1',
          product_name: 'Family Pack',
          category_name: 'Bundles',
          quantity: 2,
          unit_price: 12.5,
          subtotal: 25,
          sort_order: 0,
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    },
  ],
};

beforeEach(() => {
  actions.getFriendsFamilyWorkspace.mockResolvedValue(workspace);
  actions.createFriendsFamilyOrder.mockResolvedValue({ id: 'order-2', orderNumber: 'FF-000002' });
  actions.updateFriendsFamilyOrderStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FriendsFamilyOrdersClient', () => {
  it('renders invoice-style order blocks with line items and workflow statuses', () => {
    render(<FriendsFamilyOrdersClient initialWorkspace={workspace} isAdmin />);

    expect(screen.getByText('FF-000001')).toBeInTheDocument();
    expect(screen.getByText('Jamie Friend')).toBeInTheDocument();
    expect(screen.getByText('Front desk pickup')).toBeInTheDocument();
    expect(screen.getAllByText('$25.00').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Fulfillment status for FF-000001')).toHaveValue('new');
    expect(screen.getByLabelText('Payment status for FF-000001')).toHaveValue('unpaid');
    expect(screen.getAllByRole('option', { name: 'Packed' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('option', { name: 'Cash Paid' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Delete FF-000001' })).toBeInTheDocument();
  });

  it('filters orders by search, fulfillment status, and payment status', () => {
    render(<FriendsFamilyOrdersClient initialWorkspace={workspace} isAdmin={false} />);

    fireEvent.change(screen.getByLabelText('Search orders'), { target: { value: 'not found' } });
    expect(screen.getByText('No orders match the current search and filters.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search orders'), { target: { value: 'Jamie' } });
    expect(screen.getByText('FF-000001')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter by order status'), { target: { value: 'packed' } });
    expect(screen.getByText('No orders match the current search and filters.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter by order status'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Filter by payment status'), { target: { value: 'cash_paid' } });
    expect(screen.getByText('No orders match the current search and filters.')).toBeInTheDocument();
  });

  it('calculates line subtotal and submits the manually entered employee name', async () => {
    render(<FriendsFamilyOrdersClient initialWorkspace={workspace} isAdmin={false} />);

    fireEvent.click(screen.getByRole('button', { name: /new order/i }));
    expect(screen.getByLabelText('Quantity')).toHaveDisplayValue('');
    fireEvent.change(screen.getByLabelText('Ordered by'), { target: { value: 'Morgan Employee' } });
    fireEvent.change(screen.getByLabelText('Customer Name'), { target: { value: 'Taylor Family' } });
    fireEvent.click(screen.getByLabelText('Product'));
    fireEvent.click(screen.getByRole('option', { name: 'Family Pack - Bundles' }));
    expect(screen.getByLabelText('Product')).toHaveStyle({ backgroundColor: '#dbeafe' });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '3' } });

    expect(screen.getAllByText('$37.50').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /submit order/i }));

    await waitFor(() => expect(actions.createFriendsFamilyOrder).toHaveBeenCalledWith(expect.objectContaining({
      ordered_by: 'Morgan Employee',
      customer_name: 'Taylor Family',
      items: [{ product_id: 'product-1', quantity: 3 }],
    })));
  });

  it('offers preset colors in product management without a freeform color picker', () => {
    render(<FriendsFamilyOrdersClient initialWorkspace={workspace} isAdmin />);

    fireEvent.click(screen.getByRole('button', { name: /manage products/i }));
    expect(screen.getByLabelText('New product color')).toHaveValue('slate');
    expect(screen.getByLabelText('Color for Family Pack')).toHaveValue('blue');
    expect(screen.queryByDisplayValue(/^#/)).not.toBeInTheDocument();
  });

  it('edits header details and line items from the order card', async () => {
    actions.updateFriendsFamilyOrder.mockResolvedValue(undefined);
    render(<FriendsFamilyOrdersClient initialWorkspace={workspace} isAdmin />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit FF-000001' }));
    fireEvent.change(screen.getByLabelText('Ordered by'), { target: { value: 'Updated Employee' } });
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(actions.updateFriendsFamilyOrder).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({
        ordered_by: 'Updated Employee',
        items: [{ product_id: 'product-1', quantity: 4 }],
      })
    ));
  });

  it('locks a standalone form after submit and supports edit and new-order reset', async () => {
    render(<FriendsFamilyOrderForm products={workspace.products} standalone />);

    fireEvent.change(screen.getByLabelText('Ordered by'), { target: { value: 'Alex Employee' } });
    fireEvent.change(screen.getByLabelText('Customer Name'), { target: { value: 'New Customer' } });
    fireEvent.click(screen.getByLabelText('Product'));
    fireEvent.click(screen.getByRole('option', { name: 'Family Pack - Bundles' }));
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /submit order/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Submitted' })).toBeInTheDocument());
    expect(screen.getByText('FF-000002')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download image/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Customer Name')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Customer Name')).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submitted' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'New Order' }));
    expect(screen.getByLabelText('Ordered by')).toHaveValue('');
    expect(screen.getByRole('button', { name: /submit order/i })).toBeInTheDocument();
  });
});
