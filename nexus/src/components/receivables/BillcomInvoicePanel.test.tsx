import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { BillcomInvoiceStatus } from '@/lib/billcom/invoiceStatus';
import { BillcomInvoicePanel } from './BillcomInvoicePanel';

afterEach(cleanup);

const status = (over: Partial<BillcomInvoiceStatus> = {}): BillcomInvoiceStatus => ({
  id: '00e1', invoiceNumber: 'W-1', status: 'OPEN', statusLabel: 'Open', totalAmount: 100, dueAmount: 100, dueDate: '2026-12-15', ...over,
});
const show = (s: BillcomInvoiceStatus, today = '2026-11-20') =>
  render(<BillcomInvoicePanel panel={{ kind: 'found', status: s }} today={today} />);

describe('BillcomInvoicePanel payment status', () => {
  it('Paid is green', () => {
    show(status({ status: 'PAID_IN_FULL', statusLabel: 'Paid', dueAmount: 0 }));
    expect(screen.getByText('Paid')).toHaveClass('text-success');
  });

  it('an open invoice past its due date reads "Past due" in red', () => {
    show(status({ dueDate: '2026-11-01' }));
    expect(screen.getByText('Past due')).toHaveClass('text-destructive');
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('a partly paid invoice past its due date is also "Past due"', () => {
    show(status({ status: 'PARTIALLY_PAID', statusLabel: 'Partially paid', dueAmount: 40, dueDate: '2026-11-01' }));
    expect(screen.getByText('Past due')).toHaveClass('text-destructive');
  });

  it('due today or later is not past due: the status stays plain', () => {
    show(status({ dueDate: '2026-11-20' }));
    const open = screen.getByText('Open');
    expect(open).not.toHaveClass('text-destructive');
    expect(open).not.toHaveClass('text-success');
  });

  it('paid wins even when the due date has passed; void and unknown dates stay plain', () => {
    show(status({ status: 'PAID_IN_FULL', statusLabel: 'Paid', dueAmount: 0, dueDate: '2026-11-01' }));
    expect(screen.getByText('Paid')).toHaveClass('text-success');
    cleanup();
    show(status({ status: 'VOID', statusLabel: 'Void', dueDate: '2026-11-01' }));
    expect(screen.getByText('Void')).not.toHaveClass('text-destructive');
    cleanup();
    show(status({ dueDate: null }));
    expect(screen.getByText('Open')).not.toHaveClass('text-destructive');
  });

  it('still shows the amount due and total next to the status', () => {
    show(status({ dueDate: '2026-11-01', dueAmount: 45.23, totalAmount: 45.23 }));
    expect(screen.getByText(/\$45\.23 due of \$45\.23/)).toBeInTheDocument();
  });

  it('other states keep their messages', () => {
    render(<BillcomInvoicePanel panel={{ kind: 'not_found' }} today="2026-11-20" />);
    expect(screen.getByText('Not found in Bill.com.')).toBeInTheDocument();
  });
});
