import type { ReactNode } from 'react';
import Link from 'next/link';
import { formatDate, formatMoney } from '@/lib/format';
import type { BusinessCentralSalesInvoice, BusinessCentralSalesInvoiceLine } from '@/types/database';

const LABEL = 'text-[11px] uppercase tracking-wide text-black dark:text-white';
export const CARD = 'glass-card rounded-xl border border-border p-4';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="mt-0.5 text-sm text-foreground">{children}</div>
    </div>
  );
}

const num = (v: number | null) => (v === null ? '—' : String(v));
const money = (v: number | null, currency: string | null) => formatMoney(v, currency);

interface Props {
  invoice: BusinessCentralSalesInvoice;
  lines: BusinessCentralSalesInvoiceLine[];
  /** Lines were missing and BC couldn't be read to fill them. */
  linesError?: boolean;
  salesOrder: { id: string; bcOrderNumber: string | null } | null;
  /** The Bill.com panel (streamed in by the page). */
  billcom: ReactNode;
  /** The card-charge panel (streamed in by the page). */
  cardCharge?: ReactNode;
  /** The notes panel (rendered by the page); shown in its own block to the right. */
  notes?: ReactNode;
  /** The change log card (rendered by the page). */
  changes?: ReactNode;
  /** A finished change cancelled this invoice and posted this one instead. */
  replacedBy?: { id: string; number: string } | null;
}

/** A posted BC invoice as Nexus holds it: header, Bill.com side, lines and totals. */
export function SalesInvoiceDetail({ invoice, lines, linesError = false, salesOrder, billcom, cardCharge = null, notes = null, changes = null, replacedBy = null }: Props) {
  const cur = invoice.currency_code;
  const title = invoice.external_document_number || invoice.bc_invoice_number || '—';
  return (
    // The app shell clips its content, so the page scrolls in its own area (as customer pages do).
    <div data-testid="invoice-scroll" className="h-[calc(100vh-3.5rem)] overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-5">
        <div>
          <Link href="/receivables/invoices" className="text-sm text-primary hover:underline">← Invoices</Link>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Invoice {title}</h1>
            <span className="text-sm text-foreground-muted">
              BC Invoice No. <span className="font-mono">{invoice.bc_invoice_number ?? '—'}</span>
            </span>
          </div>
        </div>

        {replacedBy && (
          <p role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-foreground">
            Cancelled — replaced by{' '}
            <Link href={`/receivables/invoices/${encodeURIComponent(replacedBy.id)}`} className="font-mono text-primary hover:underline">
              {replacedBy.number}
            </Link>
          </p>
        )}

        {/* Info, Bill.com and card payment stack on the left; Notes sit to their right (like a sales order). */}
        <div className={`grid gap-4 ${notes ? 'lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]' : ''}`}>
          <div data-testid="invoice-main" className="space-y-4">
            <section className={`${CARD} grid grid-cols-2 gap-4 sm:grid-cols-3`}>
              <Field label="Customer">
                {invoice.customer_number ? (
                  <Link href={`/customers?search=${encodeURIComponent(invoice.customer_number)}`} className="text-primary hover:underline">
                    {invoice.customer_name ?? invoice.customer_number}
                  </Link>
                ) : (
                  invoice.customer_name ?? '—'
                )}
              </Field>
              <Field label="Invoice date">{formatDate(invoice.invoice_date)}</Field>
              <Field label="Due date">{formatDate(invoice.due_date)}</Field>
              <Field label="BC status">{invoice.status ?? '—'}</Field>
              <Field label="Sales order">
                {salesOrder ? (
                  <Link href={`/sales-orders/${salesOrder.id}`} className="text-primary hover:underline">
                    {salesOrder.bcOrderNumber ?? 'Open order'} →
                  </Link>
                ) : (
                  '—'
                )}
              </Field>
            </section>

            {billcom && <section className={CARD}>{billcom}</section>}

            {/* The card-charge slot draws its own card, so a hidden panel leaves no empty box. */}
            {cardCharge}
          </div>

          {notes && (
            <aside data-testid="invoice-notes" className="self-start">
              <section className={CARD}>
                <h2 className="mb-3 text-sm font-semibold text-foreground">Notes</h2>
                {notes}
              </section>
            </aside>
          )}
        </div>

        {changes}

        <section className={`${CARD} overflow-x-auto`}>
          <table className="min-w-full text-sm">
            <thead className={`text-left ${LABEL}`}>
              <tr>
                <th className="px-2 py-2 font-medium">Item</th>
                <th className="px-2 py-2 font-medium">Description</th>
                <th className="px-2 py-2 text-right font-medium">Qty</th>
                <th className="px-2 py-2 text-right font-medium">Unit price</th>
                <th className="px-2 py-2 text-right font-medium">Disc %</th>
                <th className="px-2 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-foreground-muted">
                    {linesError ? "Couldn't load lines from Business Central." : 'No lines'}
                  </td>
                </tr>
              ) : (
                lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-2 py-2 font-mono text-xs">{l.line_object_number ?? ''}</td>
                    <td className="px-2 py-2">{l.description ?? ''}</td>
                    <td className="px-2 py-2 text-right">{num(l.quantity)}</td>
                    <td className="px-2 py-2 text-right">{money(l.unit_price, cur)}</td>
                    <td className="px-2 py-2 text-right">{l.discount_percent ? l.discount_percent : ''}</td>
                    <td className="px-2 py-2 text-right">{money(l.amount_excluding_tax, cur)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <dl className="ml-auto mt-3 w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between text-foreground-muted"><dt>Subtotal</dt><dd>{money(invoice.total_amount_excluding_tax, cur)}</dd></div>
            <div className="flex justify-between text-foreground-muted"><dt>Tax</dt><dd>{money(invoice.total_tax_amount, cur)}</dd></div>
            <div className="flex justify-between font-semibold text-foreground"><dt>Total</dt><dd>{money(invoice.total_amount_including_tax, cur)}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  );
}
