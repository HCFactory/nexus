import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { PaymentDetail } from '@/lib/receivables/paymentDetail';
import { PaymentDetailView } from './PaymentDetailView';

afterEach(cleanup);

const detail: PaymentDetail = {
  payment: { billcomPaymentId: 'rp-1', date: '2026-11-12', amount: 150, typeLabel: 'Check #10482', online: false, status: 'Paid', deposit: 'First Hawaiian ••••6789', convenienceFee: 0, unapplied: 0 },
  invoices: [
    { billcomInvoiceId: 'bi-1', amount: 100, number: 'W-1', href: '/receivables/invoices/inv-1' },
    { billcomInvoiceId: 'bi-9', amount: 50, number: null, href: null },
  ],
  customer: { name: 'Food Pantry', number: 'C1' },
  charge: null,
};

describe('PaymentDetailView', () => {
  it('shows how and when it was paid, where it went, and the invoices it paid', () => {
    render(<PaymentDetailView detail={detail} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Check #10482');
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('Nov 12, 2026')).toBeInTheDocument();
    expect(screen.getByText('First Hawaiian ••••6789')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Food Pantry' })).toHaveAttribute('href', '/customers/by-number/C1');
    expect(screen.getByRole('link', { name: 'W-1' })).toHaveAttribute('href', '/receivables/invoices/inv-1');
    expect(screen.getByText('Not in Nexus yet')).toBeInTheDocument();
  });

  it('a card charge made in Nexus shows who charged and the Stripe reference', () => {
    render(<PaymentDetailView detail={{ ...detail, charge: { chargedBy: 'Fahim', card: 'Visa •••• 4242', stripeReference: 'pi_123', billcomState: 'Recorded in Bill.com', chargedAt: '2026-11-12T01:00:00Z' } }} />);
    expect(screen.getByText('Fahim')).toBeInTheDocument();
    expect(screen.getByText('pi_123')).toBeInTheDocument();
    expect(screen.getByText('Recorded in Bill.com')).toBeInTheDocument();
  });
});
