import type { BillcomPanel } from '@/lib/billcom/invoiceStatus';
import { formatMoney } from '@/lib/format';

const MESSAGES: Record<Exclude<BillcomPanel['kind'], 'found' | 'error'>, string> = {
  off: 'Bill.com is turned off.',
  not_linked: "This customer isn't linked to Bill.com.",
  not_found: 'Not found in Bill.com.',
  ambiguous: 'Several Bill.com invoices have this number.',
};

/** The Bill.com side of an invoice: status and amount due, or why it can't be shown. */
export function BillcomInvoicePanel({ panel }: { panel: BillcomPanel }) {
  let body: string;
  if (panel.kind === 'found') {
    const s = panel.status;
    body = `${s.statusLabel} · ${formatMoney(s.dueAmount, null)} due of ${formatMoney(s.totalAmount, null)}`;
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
