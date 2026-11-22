import Link from 'next/link';

import { formatMoney } from '@/lib/format';
import type { InvoicePaymentRow } from '@/lib/receivables/invoiceActivity';
import { CARD } from './SalesInvoiceDetail';

const day = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';

const STATUS_CLASS: Record<InvoicePaymentRow['status'], string> = {
  paid: 'text-success',
  cancelled: 'text-foreground-muted',
  processing: 'text-foreground-muted',
  failed: 'text-destructive',
};

function Row({ p }: { p: InvoicePaymentRow }) {
  const struck = p.status === 'cancelled' ? 'line-through' : '';
  return (
    <span className="flex items-center gap-3 px-2 py-2 text-sm">
      <span className="w-24 shrink-0 text-foreground-muted">{day(p.date)}</span>
      <span className={`min-w-0 flex-1 truncate text-foreground ${struck}`}>
        {p.label}
        {p.chargedBy ? <span className="text-foreground-muted"> · by {p.chargedBy}</span> : null}
      </span>
      <span className={`shrink-0 text-right text-foreground ${struck}`}>{formatMoney(p.amount, null)}</span>
      <span className={`w-40 shrink-0 truncate text-right text-xs ${STATUS_CLASS[p.status]}`}>{p.statusLabel}</span>
    </span>
  );
}

/** The payments that paid this invoice; Bill.com payments open their details page. */
export function InvoicePaymentsCard({ payments }: { payments: InvoicePaymentRow[] }) {
  return (
    <section className={CARD}>
      <h2 className="mb-2 text-sm font-semibold text-foreground">Payments</h2>
      {payments.length === 0 ? (
        <p className="text-sm text-foreground-muted">No payments yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {payments.map((p, i) => (
            <li key={`${p.key}-${i}`}>
              {p.href ? (
                <Link href={p.href} className="block rounded-md transition-colors hover:bg-surface">
                  <Row p={p} />
                </Link>
              ) : (
                <Row p={p} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
