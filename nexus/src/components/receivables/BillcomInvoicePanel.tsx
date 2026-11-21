import type { ReactNode } from 'react';

import type { BillcomPanel } from '@/lib/billcom/invoiceStatus';
import { billcomPaymentDisplay, hawaiiToday } from '@/lib/billcom/paymentDisplay';
import { formatMoney } from '@/lib/format';

const MESSAGES: Record<Exclude<BillcomPanel['kind'], 'found' | 'error'>, string> = {
  off: 'Bill.com is turned off.',
  not_linked: "This customer isn't linked to Bill.com.",
  not_found: 'Not found in Bill.com.',
  ambiguous: 'Several Bill.com invoices have this number.',
  mismatch: "A Bill.com invoice has this number, but its total or customer doesn't match — check it in Bill.com.",
};

const TONE_CLASS = { success: 'font-medium text-success', destructive: 'font-medium text-destructive', plain: '' } as const;

/** The Bill.com side of an invoice: status and amount due, or why it can't be shown. */
export function BillcomInvoicePanel({ panel, today = hawaiiToday() }: { panel: BillcomPanel; today?: string }) {
  let body: ReactNode;
  if (panel.kind === 'found') {
    const s = panel.status;
    const shown = billcomPaymentDisplay(s, today);
    const pay = { label: shown.label, className: TONE_CLASS[shown.tone] };
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
