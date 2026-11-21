import type { ReactNode } from 'react';

import type { BillcomInvoiceStatus, BillcomPanel } from '@/lib/billcom/invoiceStatus';
import { businessDate } from '@/lib/stripe/chargeInvoice';
import { formatMoney } from '@/lib/format';

const MESSAGES: Record<Exclude<BillcomPanel['kind'], 'found' | 'error'>, string> = {
  off: 'Bill.com is turned off.',
  not_linked: "This customer isn't linked to Bill.com.",
  not_found: 'Not found in Bill.com.',
  ambiguous: 'Several Bill.com invoices have this number.',
  mismatch: "A Bill.com invoice has this number, but its total or customer doesn't match — check it in Bill.com.",
};

/**
 * What to show for the payment status: Paid (green), Past due (red) when
 * something is still owed after the due date, otherwise Bill.com's own label.
 * `today` is the business date (YYYY-MM-DD, Hawaii).
 */
function paymentStatus(s: BillcomInvoiceStatus, today: string): { label: string; className: string } {
  if (s.status === 'PAID_IN_FULL') return { label: s.statusLabel, className: 'font-medium text-success' };
  const owing = (s.dueAmount ?? 0) > 0;
  const pastDue = s.status !== 'VOID' && owing && !!s.dueDate && s.dueDate.slice(0, 10) < today;
  if (pastDue) return { label: 'Past due', className: 'font-medium text-destructive' };
  return { label: s.statusLabel, className: '' };
}

/** The Bill.com side of an invoice: status and amount due, or why it can't be shown. */
export function BillcomInvoicePanel({ panel, today = businessDate(new Date()) }: { panel: BillcomPanel; today?: string }) {
  let body: ReactNode;
  if (panel.kind === 'found') {
    const s = panel.status;
    const pay = paymentStatus(s, today);
    body = (
      <>
        <span className={pay.className}>{pay.label}</span>
        {` · ${formatMoney(s.dueAmount, null)} due of ${formatMoney(s.totalAmount, null)}`}
      </>
    );
  } else if (panel.kind === 'error') {
    body = `Couldn't reach Bill.com: ${panel.message}`;
  } else {
    body = MESSAGES[panel.kind];
  }
  return (
    <p className={`text-sm ${panel.kind === 'found' ? 'text-foreground' : 'text-foreground-muted'}`}>
      <span className="font-medium">Bill.com: </span>
      <span>{body}</span>
    </p>
  );
}
