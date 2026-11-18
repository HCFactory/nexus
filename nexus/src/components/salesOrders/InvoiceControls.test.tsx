import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesOrderRow } from '@/types/salesOrders';
import type { InvoiceChangeRow } from '@/types/invoiceChanges';
import { ChangeInvoiceButton, InvoiceChangeStatus, InvoiceControls, InvoiceStatus, invoiceStatusText } from './InvoiceControls';

const actions = vi.hoisted(() => ({ createInvoice: vi.fn(), retryInvoice: vi.fn() }));
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('@/app/actions/salesOrderInvoicing', () => actions);
const changeActions = vi.hoisted(() => ({
  retryChangeInvoice: vi.fn(), discardChangeInvoice: vi.fn(), getExtraInvoiceDrafts: vi.fn(), deleteExtraInvoiceDrafts: vi.fn(),
}));
vi.mock('@/app/actions/salesInvoiceChanges', () => changeActions);
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const order = (over: Partial<SalesOrderRow> = {}) =>
  ({
    id: 'so-1', status: 'final', sync_state: 'synced', invoice_state: 'none', invoice_error: null,
    bc_order_number: 'SO-10234', bc_posted_invoice_number: null, ...over,
  }) as SalesOrderRow;

const controls = (o: SalesOrderRow, over: Partial<React.ComponentProps<typeof InvoiceControls>> = {}) =>
  render(
    <InvoiceControls
      order={o} canEdit dirty={false} blockedReason={null} invoiceNumber="SO-10234 / PO-1"
      customerLabel="Acme Foods" total={108.25} today="2026-11-15" {...over}
    />,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Create invoice button', () => {
  it('shows for final and pulled orders and is enabled', () => {
    controls(order());
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeEnabled();
    cleanup();
    controls(order({ status: 'pulled' }));
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeEnabled();
  });
  it('is hidden for draft, without permission, and once invoicing started', () => {
    controls(order({ status: 'draft' }));
    expect(screen.queryByRole('button', { name: 'Create invoice' })).toBeNull();
    cleanup();
    controls(order(), { canEdit: false });
    expect(screen.queryByRole('button', { name: 'Create invoice' })).toBeNull();
    cleanup();
    controls(order({ invoice_state: 'posting' }));
    expect(screen.queryByRole('button', { name: /invoice/i })).toBeNull();
  });
  it('is disabled with the reason as its title when blocked', () => {
    controls(order(), { blockedReason: "This customer isn't in Bill.com yet. Push it from Customers first." });
    const b = screen.getByRole('button', { name: 'Create invoice' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('title', "This customer isn't in Bill.com yet. Push it from Customers first.");
  });
  it('is disabled with unsaved edits and when the order is not synced', () => {
    controls(order(), { dirty: true });
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeDisabled();
    cleanup();
    controls(order({ sync_state: 'failed' }));
    expect(screen.getByRole('button', { name: 'Create invoice' })).toBeDisabled();
  });
});

describe('confirm box', () => {
  it('shows the details; Cancel calls nothing', () => {
    controls(order());
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }));
    expect(screen.getByText('Create invoice for SO-10234?')).toBeInTheDocument();
    expect(screen.getByText(/Acme Foods/)).toBeInTheDocument();
    expect(screen.getByText(/\$108\.25/)).toBeInTheDocument();
    expect(screen.getByText(/SO-10234 \/ PO-1/)).toBeInTheDocument();
    expect(screen.getByText('Invoice Date: Today (Nov 15)')).toBeInTheDocument();
    expect(screen.getByText("This posts the order in BC. It can't be undone.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(actions.createInvoice).not.toHaveBeenCalled();
  });
  it('Create invoice calls createInvoice and refreshes', async () => {
    actions.createInvoice.mockResolvedValue({ ok: true });
    controls(order());
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }));
    const buttons = screen.getAllByRole('button', { name: 'Create invoice' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(actions.createInvoice).toHaveBeenCalledWith('so-1'));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
  it('shows the error and stays open when it fails', async () => {
    actions.createInvoice.mockResolvedValue({ ok: false, error: 'BC said no' });
    controls(order());
    fireEvent.click(screen.getByRole('button', { name: 'Create invoice' }));
    const buttons = screen.getAllByRole('button', { name: 'Create invoice' });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText('BC said no')).toBeInTheDocument();
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
});

describe('status line', () => {
  const status = (o: Partial<SalesOrderRow>, canEdit = true, onError = vi.fn()) =>
    render(<InvoiceStatus order={order(o)} canEdit={canEdit} onError={onError} />);

  it.each(['posting', 'posted', 'billcom_sending'] as const)('%s shows Invoicing…', (s) => {
    status({ invoice_state: s });
    expect(screen.getByRole('status')).toHaveTextContent('Invoicing…');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
  it('post_failed shows Couldn\'t post, BC\'s message and Retry', async () => {
    actions.retryInvoice.mockResolvedValue({ ok: true });
    status({ invoice_state: 'post_failed', invoice_error: 'Posting date not allowed' });
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't post");
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Posting date not allowed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(actions.retryInvoice).toHaveBeenCalledWith('so-1'));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
  it('billcom_failed shows the copy and Retry; a retry error goes to onError', async () => {
    actions.retryInvoice.mockResolvedValue({ ok: false, error: 'Nope' });
    const onError = vi.fn();
    status({ invoice_state: 'billcom_failed', invoice_error: 'Total off by $0.01' }, true, onError);
    expect(screen.getByRole('status')).toHaveTextContent('Invoiced · Not in Bill.com');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Nope'));
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });
  it('hides Retry without permission', () => {
    status({ invoice_state: 'billcom_failed' }, false);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
  it('done shows Invoiced · In Bill.com and View invoice opens the invoice page', () => {
    status({ invoice_state: 'done', bc_posted_invoice_number: 'SI 1/2', bc_posted_invoice_id: 'inv-guid', billcom_invoice_id: 'bill-1' });
    expect(screen.getByRole('status')).toHaveTextContent('Invoiced · In Bill.com');
    expect(screen.getByRole('link', { name: 'View invoice' })).toHaveAttribute('href', '/receivables/invoices/inv-guid');
    expect(screen.getByText('Invoice SI 1/2 ·')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View invoice' })).not.toHaveAttribute('title');
  });
});

describe('invoiceStatusText', () => {
  it("shows 'Changing invoice…' while a change is open", () => {
    expect(invoiceStatusText('changing')).toBe('Changing invoice…');
  });
  it("an invoice with no Bill.com invoice (Bill.com's connector copies it) is just 'Invoiced'", () => {
    expect(invoiceStatusText('done', null)).toBe('Invoiced');
    expect(invoiceStatusText('done', 'bill-1')).toBe('Invoiced · In Bill.com');
  });
});

describe('Change invoice button', () => {
  const PAID = "Paid or partly paid in Bill.com — can't change";
  it('shows only for a done invoice and an editor', () => {
    const onStart = vi.fn();
    const { rerender } = render(<ChangeInvoiceButton order={order({ invoice_state: 'done' })} canEdit blockedReason={null} onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change invoice' }));
    expect(onStart).toHaveBeenCalled();
    rerender(<ChangeInvoiceButton order={order({ invoice_state: 'billcom_failed' })} canEdit blockedReason={null} onStart={onStart} />);
    expect(screen.queryByRole('button', { name: 'Change invoice' })).toBeNull();
    rerender(<ChangeInvoiceButton order={order({ invoice_state: 'done' })} canEdit={false} blockedReason={null} onStart={onStart} />);
    expect(screen.queryByRole('button', { name: 'Change invoice' })).toBeNull();
  });
  it('is disabled with the reason when Bill.com blocks it', () => {
    render(<ChangeInvoiceButton order={order({ invoice_state: 'done' })} canEdit blockedReason={PAID} onStart={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Change invoice' })).toBeDisabled();
    expect(screen.getByText(PAID)).toBeInTheDocument();
  });
});

describe('Invoice change status', () => {
  const change = (state: InvoiceChangeRow['state'], error: string | null = null) =>
    ({ id: 'ch1', state, error, old_bc_invoice_number: 'INV-100411' }) as InvoiceChangeRow;
  it('a failed cancel shows its error with Retry and Discard change', async () => {
    changeActions.discardChangeInvoice.mockResolvedValue({ ok: true });
    render(<InvoiceChangeStatus orderId="so-1" change={change('cancel_failed', 'The invoice has a payment applied.')} canEdit />);
    expect(screen.getByText('The invoice has a payment applied.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard change' }));
    await waitFor(() => expect(changeActions.discardChangeInvoice).toHaveBeenCalledWith('so-1'));
  });
  it('a failed post offers Retry but not Discard', async () => {
    changeActions.retryChangeInvoice.mockResolvedValue({ ok: true });
    render(<InvoiceChangeStatus orderId="so-1" change={change('post_failed', 'Posting Date is not within your range.')} canEdit />);
    expect(screen.queryByRole('button', { name: 'Discard change' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(changeActions.retryChangeInvoice).toHaveBeenCalledWith('so-1'));
  });
  it('other failures offer no Delete extra drafts', () => {
    render(<InvoiceChangeStatus orderId="so-1" change={change('post_failed', 'Posting Date is not within your range.')} canEdit />);
    expect(screen.queryByRole('button', { name: 'Delete extra drafts' })).toBeNull();
  });
  it('duplicate drafts: the confirm box shows what is kept and deleted; nothing is deleted until confirmed', async () => {
    changeActions.getExtraInvoiceDrafts.mockResolvedValue({
      ok: true,
      keep: { id: 'd1', no: 'S-INV102028', totalExclTax: 58 },
      extra: [{ id: 'd2', no: 'S-INV102029', totalExclTax: 0 }],
    });
    changeActions.deleteExtraInvoiceDrafts.mockResolvedValue({ ok: true });
    const msg = 'BC has more than one draft with Invoice # W-100532 (S-INV102028, S-INV102029). Delete the extra drafts, then Retry.';
    render(<InvoiceChangeStatus orderId="so-1" change={change('post_failed', msg)} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete extra drafts' }));
    expect(await screen.findByText(/Keep S-INV102028/)).toBeInTheDocument();
    expect(screen.getByText(/Delete S-INV102029/)).toBeInTheDocument();
    expect(changeActions.deleteExtraInvoiceDrafts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 draft' }));
    await waitFor(() => expect(changeActions.deleteExtraInvoiceDrafts).toHaveBeenCalledWith('so-1', ['d2']));
  });
  it('duplicate drafts: Cancel deletes nothing', async () => {
    changeActions.getExtraInvoiceDrafts.mockResolvedValue({ ok: true, keep: { id: 'd1', no: 'S-INV1', totalExclTax: 58 }, extra: [{ id: 'd2', no: 'S-INV2', totalExclTax: 0 }] });
    render(<InvoiceChangeStatus orderId="so-1" change={change('post_failed', 'BC has more than one draft with Invoice # X (S-INV1, S-INV2). Delete the extra drafts, then Retry.')} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete extra drafts' }));
    await screen.findByText(/Keep S-INV1/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(changeActions.deleteExtraInvoiceDrafts).not.toHaveBeenCalled();
  });
  it('a running change shows no buttons', () => {
    render(<InvoiceChangeStatus orderId="so-1" change={change('posting')} canEdit />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
