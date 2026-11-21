import type { ReactNode } from 'react';
import Link from 'next/link';

import { customerByNumberHref } from '@/lib/customers/customerProfilePath';
import { formatMoney } from '@/lib/format';
import type { PaymentDetail } from '@/lib/receivables/paymentDetail';
import { CARD } from './SalesInvoiceDetail';

const LABEL = 'text-[11px] uppercase tracking-wide text-black dark:text-white';
const day = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="mt-0.5 text-sm text-foreground">{children}</div>
    </div>
  );
}

/** A Bill.com payment: how and when it was paid, where it went, what it paid. */
export function PaymentDetailView({ detail }: { detail: PaymentDetail }) {
  const { payment: p, invoices, customer, charge } = detail;
  return (
    <div className="h-[calc(100vh-3.5rem)] overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-5">
        <div>
          <Link href="/receivables/invoices" className="text-sm text-primary hover:underline">← Invoices</Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Payment · {p.typeLabel}</h1>
        </div>

        <section className={`${CARD} grid grid-cols-2 gap-4 sm:grid-cols-3`}>
          <Field label="Amount">{formatMoney(p.amount, null)}</Field>
          <Field label="Date">{day(p.date)}</Field>
          <Field label="Status">{p.status}</Field>
          <Field label="How it was paid">{p.typeLabel}{p.online ? ' · paid online' : ''}</Field>
          <Field label="Deposited to">{p.deposit ?? '—'}</Field>
          <Field label="Customer">
            {customer?.number ? (
              <Link href={customerByNumberHref(customer.number)} className="text-primary hover:underline">
                {customer.name ?? customer.number}
              </Link>
            ) : (
              customer?.name ?? '—'
            )}
          </Field>
          {p.convenienceFee ? <Field label="Convenience fee">{formatMoney(p.convenienceFee, null)}</Field> : null}
          {p.unapplied ? <Field label="Not applied to an invoice">{formatMoney(p.unapplied, null)}</Field> : null}
        </section>

        {charge && (
          <section className={`${CARD} grid grid-cols-2 gap-4 sm:grid-cols-3`}>
            <h2 className="col-span-full text-sm font-semibold text-foreground">Card charge made in Nexus</h2>
            <Field label="Charged by">{charge.chargedBy ?? '—'}</Field>
            <Field label="Card">{charge.card}</Field>
            <Field label="Bill.com">{charge.billcomState}</Field>
            <Field label="Stripe reference"><span className="font-mono text-xs">{charge.stripeReference ?? '—'}</span></Field>
          </section>
        )}

        <section className={CARD}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Invoices paid</h2>
          {invoices.length === 0 ? (
            <p className="text-sm text-foreground-muted">Not applied to any invoice.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {invoices.map((i) => (
                <li key={i.billcomInvoiceId} className="flex items-center justify-between gap-3 py-2">
                  {i.href ? (
                    <Link href={i.href} className="font-medium text-primary hover:underline">{i.number ?? 'Invoice'}</Link>
                  ) : (
                    <span className="text-foreground-muted">Not in Nexus yet</span>
                  )}
                  <span className="text-foreground">{formatMoney(i.amount, null)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
