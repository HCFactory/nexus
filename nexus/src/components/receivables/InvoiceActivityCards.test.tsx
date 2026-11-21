import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ActivityEvent, InvoicePaymentRow } from '@/lib/receivables/invoiceActivity';
import { InvoiceActivityCard } from './InvoiceActivityCard';
import { InvoicePaymentsCard } from './InvoicePaymentsCard';

afterEach(cleanup);

const payments: InvoicePaymentRow[] = [
  { key: 'rp-card', date: '2026-11-19', label: 'Card (Nexus) · Visa •••• 4242', amount: 200, status: 'paid', statusLabel: 'Paid', href: '/receivables/payments/rp-card', chargedBy: 'Fahim' },
  { key: 'rp-1', date: '2026-11-10', label: 'Check #10482', amount: 100, status: 'cancelled', statusLabel: 'Cancelled', href: '/receivables/payments/rp-1' },
  { key: 'cp-2', date: '2026-11-20', label: 'Card (Nexus) · Visa •••• 4242', amount: 50, status: 'failed', statusLabel: 'Failed: Card declined', href: null },
];

describe('InvoicePaymentsCard', () => {
  it('lists each payment; a Bill.com payment opens its details page', () => {
    render(<InvoicePaymentsCard payments={payments} />);
    expect(screen.getByRole('heading', { name: 'Payments' })).toBeInTheDocument();
    const check = screen.getByRole('link', { name: /Check #10482/ });
    expect(check).toHaveAttribute('href', '/receivables/payments/rp-1');
    expect(check).toHaveTextContent('$100.00');
    expect(screen.getByRole('link', { name: /Card \(Nexus\)/ })).toHaveAttribute('href', '/receivables/payments/rp-card');
  });

  it('cancelled payments are struck through; a failed charge has no link', () => {
    render(<InvoicePaymentsCard payments={payments} />);
    expect(screen.getByRole('link', { name: /Check #10482/ }).querySelector('.line-through')).not.toBeNull();
    const failed = screen.getByText('Failed: Card declined').closest('li')!;
    expect(within(failed).queryByRole('link')).toBeNull();
  });

  it('no payments yet', () => {
    render(<InvoicePaymentsCard payments={[]} />);
    expect(screen.getByText('No payments yet.')).toBeInTheDocument();
  });
});

const events: ActivityEvent[] = Array.from({ length: 10 }, (_, i) => ({
  at: `2026-11-${String(20 - i).padStart(2, '0')}T20:00:00Z`, kind: 'note' as const, title: `Note added by Lani ${i}`, detail: `body ${i}`,
}));

describe('InvoiceActivityCard', () => {
  it('shows the newest entries with their date, title and detail; links open what they refer to', () => {
    render(<InvoiceActivityCard activity={[{ at: '2026-11-12', kind: 'payment', title: 'Payment received · Check #10482 · $100.00', href: '/receivables/payments/rp-1' }, ...events.slice(0, 1)]} />);
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Payment received · Check #10482 · $100.00' })).toHaveAttribute('href', '/receivables/payments/rp-1');
    expect(screen.getByText('Nov 12, 2026')).toBeInTheDocument();
    expect(screen.getByText('body 0')).toBeInTheDocument();
  });

  it('long histories show 8 at first, then Show all', () => {
    render(<InvoiceActivityCard activity={events} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 10' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  it('nothing yet', () => {
    render(<InvoiceActivityCard activity={[]} />);
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});
