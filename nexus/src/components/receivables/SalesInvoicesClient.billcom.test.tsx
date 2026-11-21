import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { BusinessCentralSalesInvoice } from '@/types/database';
import { SalesInvoicesClient, type StoredBillcomStatus } from './SalesInvoicesClient';

afterEach(cleanup);

const invoice = (id: string, number: string) =>
  ({ id: `row-${id}`, bc_invoice_id: id, bc_invoice_number: `INV-${id}`, external_document_number: number, customer_name: 'Zaha Mart', posting_date: '2026-11-15', due_date: '2026-11-20', status: 'Open', currency_code: null, total_amount_including_tax: 10 }) as BusinessCentralSalesInvoice;
const invoices = [invoice('a', 'W-1'), invoice('b', 'W-2'), invoice('c', 'W-3'), invoice('d', 'W-4')];
const status: Record<string, StoredBillcomStatus> = {
  a: { match: 'found', status: 'PAID_IN_FULL', dueAmount: 0, dueDate: '2026-11-01' },
  b: { match: 'found', status: 'OPEN', dueAmount: 10, dueDate: '2026-11-01' },
  c: { match: 'mismatch', status: null, dueAmount: null, dueDate: null },
};
const row = (number: string) => screen.getByRole('row', { name: new RegExp(number) });
const shown = () => screen.getAllByRole('row').length - 1;

describe('SalesInvoicesClient Bill.com column', () => {
  it('shows each invoice’s stored Bill.com status: Paid green, Past due red, doesn’t match, or — when unknown', () => {
    render(<SalesInvoicesClient invoices={invoices} billcomStatus={status} today="2026-11-20" />);
    expect(screen.getByRole('columnheader', { name: 'Bill.com' })).toBeInTheDocument();
    expect(within(row('W-1')).getByText('Paid')).toHaveClass('text-success');
    expect(within(row('W-2')).getByText('Past due')).toHaveClass('text-destructive');
    expect(within(row('W-3')).getByText("Doesn't match")).toBeInTheDocument();
    expect(within(row('W-4')).getAllByRole('cell').at(-1)).toHaveTextContent('—');
  });

  it('filters by Bill.com status', () => {
    render(<SalesInvoicesClient invoices={invoices} billcomStatus={status} today="2026-11-20" />);
    const filter = screen.getByLabelText('Bill.com status');
    fireEvent.change(filter, { target: { value: 'pastdue' } });
    expect(shown()).toBe(1);
    expect(row('W-2')).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: 'paid' } });
    expect(shown()).toBe(1);
    fireEvent.change(filter, { target: { value: 'unmatched' } });
    expect(shown()).toBe(2); // doesn't match + not in Bill.com
    fireEvent.change(filter, { target: { value: 'all' } });
    expect(shown()).toBe(4);
  });

  it('no Bill.com for this environment: no column and no filter', () => {
    render(<SalesInvoicesClient invoices={invoices} />);
    expect(screen.queryByRole('columnheader', { name: 'Bill.com' })).toBeNull();
    expect(screen.queryByLabelText('Bill.com status')).toBeNull();
  });
});
