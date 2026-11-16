import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BusinessCentralSalesInvoice, BusinessCentralSalesInvoiceLine } from '@/types/database';
import { BillcomInvoicePanel } from './BillcomInvoicePanel';
import { SalesInvoiceDetail } from './SalesInvoiceDetail';
import { SalesInvoicesClient } from './SalesInvoicesClient';

afterEach(cleanup);

const invoice = (over: Partial<BusinessCentralSalesInvoice> = {}) =>
  ({
    id: 'row-1',
    bc_invoice_id: 'inv-guid',
    bc_invoice_number: 'INV-100412',
    external_document_number: 'W-100532',
    customer_number: 'C1',
    customer_name: 'Food Pantry',
    invoice_date: '2026-11-15',
    posting_date: '2026-11-15',
    due_date: '2026-12-15',
    status: 'Open',
    currency_code: null,
    total_amount_excluding_tax: 45,
    total_tax_amount: 0.23,
    total_amount_including_tax: 45.23,
    ...over,
  }) as BusinessCentralSalesInvoice;

const line = (over: Partial<BusinessCentralSalesInvoiceLine> = {}) =>
  ({
    id: 'l1',
    line_object_number: 'P-1001',
    description: 'Bursts - Da Pouch',
    quantity: 10,
    unit_price: 4.5,
    discount_percent: 0,
    amount_excluding_tax: 45,
    ...over,
  }) as BusinessCentralSalesInvoiceLine;

describe('SalesInvoiceDetail', () => {
  it('shows Invoice #, BC Invoice No., lines and totals', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[line()]} salesOrder={null} billcom={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Invoice W-100532');
    expect(screen.getByText('INV-100412')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /P-1001/ });
    expect(row).toHaveTextContent('Bursts - Da Pouch');
    expect(row).toHaveTextContent('10');
    expect(row).toHaveTextContent('4.50');
    expect(row).toHaveTextContent('45.00');
    expect(screen.getByText('Subtotal').parentElement).toHaveTextContent('45.00');
    expect(screen.getByText('Tax').parentElement).toHaveTextContent('0.23');
    expect(screen.getByText('Total').parentElement).toHaveTextContent('45.23');
  });

  it('falls back to the BC Invoice No. in the title and shows — for a blank Invoice #', () => {
    render(<SalesInvoiceDetail invoice={invoice({ external_document_number: null })} lines={[line()]} salesOrder={null} billcom={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Invoice INV-100412');
    expect(screen.getByText('Invoice #').parentElement).toHaveTextContent('—');
  });

  it('shows No lines when there are none', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[]} salesOrder={null} billcom={null} />);
    expect(screen.getByText('No lines')).toBeInTheDocument();
  });

  it('links the sales order', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[]} salesOrder={{ id: 'so-1', bcOrderNumber: 'W-100532' }} billcom={null} />);
    expect(screen.getByRole('link', { name: /W-100532/ })).toHaveAttribute('href', '/sales-orders/so-1');
  });
});

describe('BillcomInvoicePanel', () => {
  const status = { id: '00eX', invoiceNumber: 'W-100532', status: 'OPEN', statusLabel: 'Open', totalAmount: 45.23, dueAmount: 45.23, dueDate: null };

  it('shows status and amount due', () => {
    render(<BillcomInvoicePanel panel={{ kind: 'found', status }} />);
    expect(screen.getByText(/Open · \$45\.23 due of \$45\.23/)).toBeInTheDocument();
  });

  it.each([
    [{ kind: 'off' } as const, 'Bill.com is turned off.'],
    [{ kind: 'not_linked' } as const, "This customer isn't linked to Bill.com."],
    [{ kind: 'not_found' } as const, 'Not found in Bill.com.'],
    [{ kind: 'error', message: 'down' } as const, "Couldn't reach Bill.com: down"],
  ])('%o shows its message', (panel, text) => {
    render(<BillcomInvoicePanel panel={panel} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('SalesInvoicesClient numbering', () => {
  const invoices = [invoice(), invoice({ id: 'row-2', bc_invoice_id: 'inv-2', bc_invoice_number: 'INV-77', external_document_number: null })];

  it('lists Invoice # then BC Invoice No., each row opening the invoice page', () => {
    render(<SalesInvoicesClient invoices={invoices} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 2)).toEqual(['Invoice #', 'BC Invoice No.']);
    const first = screen.getByRole('row', { name: /INV-100412/ });
    expect(within(first).getByRole('link', { name: 'W-100532' })).toHaveAttribute('href', '/receivables/invoices/inv-guid');
    expect(within(first).getByRole('link', { name: 'INV-100412' })).toHaveAttribute('href', '/receivables/invoices/inv-guid');
  });

  it('a blank Invoice # shows — and the row is still found by its BC Invoice No.', () => {
    render(<SalesInvoicesClient invoices={invoices} />);
    fireEvent.change(screen.getByPlaceholderText(/Search by invoice number/), { target: { value: 'INV-77' } });
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('—');
    expect(within(rows[0]).getByRole('link', { name: 'INV-77' })).toHaveAttribute('href', '/receivables/invoices/inv-2');
  });
});
