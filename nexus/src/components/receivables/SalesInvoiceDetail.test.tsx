import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { BusinessCentralSalesInvoice, BusinessCentralSalesInvoiceLine } from '@/types/database';
import { BillcomInvoicePanel } from './BillcomInvoicePanel';
import { SalesInvoiceDetail } from './SalesInvoiceDetail';
import { SalesInvoicesClient } from './SalesInvoicesClient';
import { parseSalesInvoiceListParams, type SalesInvoiceListRow } from '@/lib/receivables/salesInvoiceList';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/receivables/invoices' }));

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

  it('falls back to the BC Invoice No. in the title when there is no Invoice #', () => {
    render(<SalesInvoiceDetail invoice={invoice({ external_document_number: null })} lines={[line()]} salesOrder={null} billcom={null} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Invoice INV-100412');
  });

  it('does not repeat the Invoice # in the info block (it is the page title)', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[line()]} salesOrder={null} billcom={null} />);
    expect(screen.queryByText('Invoice #')).toBeNull();
    for (const label of ['Customer', 'Invoice date', 'Due date', 'BC status', 'Sales order']) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('puts the info, Bill.com and card payment blocks in a left column and Notes to their right', () => {
    render(
      <SalesInvoiceDetail
        invoice={invoice()}
        lines={[]}
        salesOrder={null}
        billcom={<p>Bill.com panel</p>}
        cardCharge={<section>Card panel</section>}
        notes={<p>Notes body</p>}
      />,
    );
    const main = screen.getByTestId('invoice-main');
    const side = screen.getByTestId('invoice-notes');
    expect(within(main).getByText('Customer')).toBeInTheDocument();
    expect(within(main).getByText('Bill.com panel')).toBeInTheDocument();
    expect(within(main).getByText('Card panel')).toBeInTheDocument();
    expect(within(side).getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
    expect(within(side).getByText('Notes body')).toBeInTheDocument();
    expect(main.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The lines table stays full width below the columns.
    expect(main.parentElement?.contains(screen.getByText('No lines'))).toBe(false);
  });

  it('scrolls inside its own area when the invoice is taller than the screen', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[line()]} salesOrder={null} billcom={null} />);
    const area = screen.getByTestId('invoice-scroll');
    expect(area).toHaveClass('overflow-y-auto');
    expect(area.className).toMatch(/h-\[calc\(100vh-3\.5rem\)\]/);
    expect(area).toContainElement(screen.getByRole('heading', { level: 1 }));
    expect(area).toContainElement(screen.getByText('Total'));
  });

  it('without a notes block the left column simply fills the row', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[]} salesOrder={null} billcom={null} />);
    expect(screen.queryByTestId('invoice-notes')).toBeNull();
    expect(screen.getByTestId('invoice-main')).toBeInTheDocument();
  });

  it('on a phone each line is a stacked row: description, item, qty × price and amount (the table is for wider screens)', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[line()]} salesOrder={null} billcom={null} />);
    const phone = screen.getByTestId('invoice-lines-phone');
    expect(phone).toHaveClass('sm:hidden');
    const item = within(phone).getByRole('listitem');
    expect(item).toHaveTextContent('Bursts - Da Pouch');
    expect(item).toHaveTextContent('P-1001');
    expect(item).toHaveTextContent('10 × $4.50');
    expect(item).toHaveTextContent('$45.00');
    expect(screen.getByRole('table')).toHaveClass('hidden', 'sm:table');
  });

  it('the customer opens their profile directly (invoice page and list)', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[]} salesOrder={null} billcom={null} />);
    expect(screen.getByRole('link', { name: 'Food Pantry' })).toHaveAttribute('href', '/customers/by-number/C1');
    cleanup();
    render(<SalesInvoicesClient invoices={[invoice()] as unknown as SalesInvoiceListRow[]} total={1} params={parseSalesInvoiceListParams({})} />);
    expect(screen.getByRole('link', { name: 'Food Pantry' })).toHaveAttribute('href', '/customers/by-number/C1');
  });

  it('shows No lines when there are none', () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[]} salesOrder={null} billcom={null} />);
    expect(screen.getByText('No lines')).toBeInTheDocument();
  });

  it("says the lines couldn't be loaded instead of No lines when BC failed", () => {
    render(<SalesInvoiceDetail invoice={invoice()} lines={[]} linesError salesOrder={null} billcom={null} />);
    expect(screen.getByText("Couldn't load lines from Business Central.")).toBeInTheDocument();
    expect(screen.queryByText('No lines')).toBeNull();
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
    expect(screen.getByText('Bill.com:').parentElement).toHaveTextContent('Bill.com: Open · $45.23 due of $45.23');
  });

  it.each([
    [{ kind: 'off' } as const, 'Bill.com is turned off.'],
    [{ kind: 'not_linked' } as const, "This customer isn't linked to Bill.com."],
    [{ kind: 'not_found' } as const, 'Not found in Bill.com.'],
    [{ kind: 'ambiguous' } as const, 'Several Bill.com invoices have this number.'],
    [{ kind: 'error', message: 'down' } as const, "Couldn't reach Bill.com: down"],
  ])('%o shows its message', (panel, text) => {
    render(<BillcomInvoicePanel panel={panel} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe('SalesInvoicesClient numbering', () => {
  const invoices = [invoice(), invoice({ id: 'row-2', bc_invoice_id: 'inv-2', bc_invoice_number: 'INV-77', external_document_number: null })] as unknown as SalesInvoiceListRow[];
  const list = () => render(<SalesInvoicesClient invoices={invoices} total={2} params={parseSalesInvoiceListParams({})} />);

  it('lists Invoice # then BC Invoice No., each row opening the invoice page', () => {
    list();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 2)).toEqual(['Invoice #', 'BC Invoice No.']);
    const first = screen.getByRole('row', { name: /INV-100412/ });
    expect(within(first).getByRole('link', { name: 'W-100532' })).toHaveAttribute('href', '/receivables/invoices/inv-guid');
    expect(within(first).getByRole('link', { name: 'INV-100412' })).toHaveAttribute('href', '/receivables/invoices/inv-guid');
  });

  it('a blank Invoice # shows — and the row still opens by its BC Invoice No.', () => {
    list();
    const row = screen.getByRole('row', { name: /INV-77/ });
    expect(row).toHaveTextContent('—');
    expect(within(row).getByRole('link', { name: 'INV-77' })).toHaveAttribute('href', '/receivables/invoices/inv-2');
  });
});

describe('SalesInvoiceDetail — replaced', () => {
  it('a cancelled invoice links to the one that replaced it', () => {
    render(
      <SalesInvoiceDetail invoice={invoice({ status: 'Canceled' })} lines={[line()]} salesOrder={null} billcom={null}
        replacedBy={{ id: 'new-guid', number: 'INV-100415' }} />,
    );
    expect(screen.getByText(/Cancelled — replaced by/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'INV-100415' })).toHaveAttribute('href', '/receivables/invoices/new-guid');
  });
});
