import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSalesInvoiceListParams, type SalesInvoiceListRow } from '@/lib/receivables/salesInvoiceList';
import { SalesInvoicesClient, type StoredBillcomStatus } from './SalesInvoicesClient';

const nav = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => '/receivables/invoices' }));

beforeEach(() => nav.replace.mockReset());
afterEach(() => { cleanup(); vi.useRealTimers(); });

const invoice = (id: string, number: string) =>
  ({ id: `row-${id}`, bc_invoice_id: id, bc_invoice_number: `INV-${id}`, external_document_number: number, customer_name: 'Zaha Mart', posting_date: '2026-11-15', due_date: '2026-11-20', status: 'Open', currency_code: null, total_amount_including_tax: 10 }) as SalesInvoiceListRow;
const invoices = [invoice('a', 'W-1'), invoice('b', 'W-2'), invoice('c', 'W-3'), invoice('d', 'W-4')];
const status: Record<string, StoredBillcomStatus> = {
  a: { match: 'found', status: 'PAID_IN_FULL', dueAmount: 0, dueDate: '2026-11-01' },
  b: { match: 'found', status: 'OPEN', dueAmount: 10, dueDate: '2026-11-01' },
  c: { match: 'mismatch', status: null, dueAmount: null, dueDate: null },
};
const base = parseSalesInvoiceListParams({});
const row = (number: string) => screen.getByRole('row', { name: new RegExp(number) });
const show = (over: Partial<Parameters<typeof SalesInvoicesClient>[0]> = {}) =>
  render(<SalesInvoicesClient invoices={invoices} total={4} params={base} billcomStatus={status} today="2026-11-20" {...over} />);

describe('SalesInvoicesClient Bill.com column', () => {
  it('shows each invoice’s stored Bill.com status: Paid green, Past due red, doesn’t match, or — when unknown', () => {
    show();
    expect(screen.getByRole('columnheader', { name: 'Bill.com' })).toBeInTheDocument();
    expect(within(row('W-1')).getByText('Paid')).toHaveClass('text-success');
    expect(within(row('W-2')).getByText('Past due')).toHaveClass('text-destructive');
    expect(within(row('W-3')).getByText("Doesn't match")).toBeInTheDocument();
    expect(within(row('W-4')).getAllByRole('cell').at(-1)).toHaveTextContent('—');
  });

  it('the Bill.com filter asks the server for that status, from page 1', () => {
    show({ params: { ...base, page: 3 } });
    fireEvent.change(screen.getByLabelText('Bill.com status'), { target: { value: 'pastdue' } });
    expect(nav.replace).toHaveBeenCalledWith('/receivables/invoices?billcom=pastdue', { scroll: false });
  });

  it('no Bill.com for this environment: no column and no filter', () => {
    show({ billcomStatus: null });
    expect(screen.queryByRole('columnheader', { name: 'Bill.com' })).toBeNull();
    expect(screen.queryByLabelText('Bill.com status')).toBeNull();
  });
});

describe('SalesInvoicesClient search, filters and pages', () => {
  it('search runs on the server once typing pauses', () => {
    vi.useFakeTimers();
    show();
    fireEvent.change(screen.getByPlaceholderText(/Search by invoice number/), { target: { value: 'W-9' } });
    expect(nav.replace).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(400); });
    expect(nav.replace).toHaveBeenCalledWith('/receivables/invoices?q=W-9', { scroll: false });
  });

  it('status and dates filter on the server', () => {
    show();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Paid' } });
    expect(nav.replace).toHaveBeenLastCalledWith('/receivables/invoices?status=Paid', { scroll: false });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    expect(nav.replace).toHaveBeenLastCalledWith('/receivables/invoices?status=Paid&from=2026-01-01', { scroll: false });
  });

  it('shows which invoices of the total are on screen, with Next / Previous', () => {
    show({ total: 250, params: { ...base, search: 'zaha', page: 2 } });
    expect(screen.getByText('Showing 101–104 of 250 invoices')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/receivables/invoices?q=zaha&page=3', { scroll: false });
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(nav.replace).toHaveBeenLastCalledWith('/receivables/invoices?q=zaha&page=2', { scroll: false });
  });

  it('typing then quickly picking a filter keeps both', () => {
    vi.useFakeTimers();
    show();
    fireEvent.change(screen.getByPlaceholderText(/Search by invoice number/), { target: { value: 'zaha' } });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Paid' } });
    act(() => { vi.advanceTimersByTime(400); });
    expect(nav.replace).toHaveBeenLastCalledWith('/receivables/invoices?q=zaha&status=Paid', { scroll: false });
  });

  it('a filter picked while the last change is still loading builds on it', () => {
    show();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Paid' } });
    fireEvent.change(screen.getByLabelText('Bill.com status'), { target: { value: 'pastdue' } });
    expect(nav.replace).toHaveBeenLastCalledWith('/receivables/invoices?status=Paid&billcom=pastdue', { scroll: false });
    expect(screen.getByLabelText('Filter by status')).toHaveValue('Paid');
  });

  it('typing a date by keyboard waits for a real year', () => {
    show();
    const from = screen.getByLabelText('From');
    fireEvent.change(from, { target: { value: '0002-01-01' } });
    expect(nav.replace).not.toHaveBeenCalled();
    fireEvent.change(from, { target: { value: '2026-01-01' } });
    expect(nav.replace).toHaveBeenLastCalledWith('/receivables/invoices?from=2026-01-01', { scroll: false });
  });

  it('a trailing space does not search again or leave the page', () => {
    vi.useFakeTimers();
    show({ params: { ...base, search: 'zaha', page: 4 } });
    fireEvent.change(screen.getByPlaceholderText(/Search by invoice number/), { target: { value: 'zaha ' } });
    act(() => { vi.advanceTimersByTime(400); });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('when the address changes from elsewhere (e.g. the sidebar link), the boxes follow it', () => {
    const { rerender } = show({ params: { ...base, search: 'acme', status: 'Paid' } });
    rerender(<SalesInvoicesClient invoices={invoices} total={4} params={base} billcomStatus={status} today="2026-11-20" />);
    expect(screen.getByPlaceholderText(/Search by invoice number/)).toHaveValue('');
    expect(screen.getByLabelText('Filter by status')).toHaveValue('all');
  });

  it('no Previous on page 1 and no Next on the last page', () => {
    show({ total: 4 });
    expect(screen.getByText('Showing 1–4 of 4 invoices')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('no matches: says so and keeps the filters on screen', () => {
    show({ invoices: [], total: 0, params: { ...base, search: 'nothing' } });
    expect(screen.getByText('No invoices match the current filters.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search by invoice number/)).toHaveValue('nothing');
  });

  it('nothing synced yet (no filters, no invoices): the empty state', () => {
    show({ invoices: [], total: 0 });
    expect(screen.getByRole('heading', { name: 'No posted sales invoices synced yet' })).toBeInTheDocument();
  });

  it('shows a read error', () => {
    show({ invoices: [], total: 0, error: 'Could not load invoices: boom', params: { ...base, search: 'x' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load invoices: boom');
    expect(screen.queryByText('No invoices match the current filters.')).toBeNull();
  });
});
