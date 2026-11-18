'use client';

import { useState } from 'react';
import Link from 'next/link';

import { formatMoney } from '@/lib/format';
import type { ChangeLine, ChangeState, InvoiceChangeRow } from '@/types/invoiceChanges';

const LABEL = 'text-[11px] uppercase tracking-wide text-black dark:text-white';

const STATE_TEXT: Partial<Record<ChangeState, string>> = {
  cancel_failed: "Couldn't cancel the old invoice",
  post_failed: "Couldn't post the corrected invoice",
  billcom_failed: "Couldn't update Bill.com",
  discarded: 'Discarded',
};
const stateText = (s: ChangeState) => (s === 'done' ? null : STATE_TEXT[s] ?? 'In progress…');

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const invoiceLink = (id: string | null, number: string | null) =>
  id && number ? (
    <Link href={`/receivables/invoices/${encodeURIComponent(id)}`} className="font-mono text-primary hover:underline">
      {number}
    </Link>
  ) : (
    <span className="font-mono">{number || '—'}</span>
  );

function LinesTable({ before, after }: { before: ChangeLine[]; after: ChangeLine[] }) {
  const rows = [...before.map((l) => ['Before', l] as const), ...after.map((l) => ['After', l] as const)];
  return (
    <table className="mt-2 min-w-full text-sm">
      <thead className={`text-left ${LABEL}`}>
        <tr>
          <th className="px-2 py-1 font-medium" />
          <th className="px-2 py-1 font-medium">Item</th>
          <th className="px-2 py-1 font-medium">Description</th>
          <th className="px-2 py-1 text-right font-medium">Qty</th>
          <th className="px-2 py-1 text-right font-medium">Unit price</th>
          <th className="px-2 py-1 text-right font-medium">Disc %</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map(([side, l], i) => (
          <tr key={i} className={side === 'After' ? 'text-foreground' : 'text-foreground-muted'}>
            <td className="px-2 py-1 text-xs">{side}</td>
            <td className="px-2 py-1 font-mono text-xs">{l.item_number}</td>
            <td className="px-2 py-1">{l.description}</td>
            <td className="px-2 py-1 text-right">{l.quantity}</td>
            <td className="px-2 py-1 text-right">{formatMoney(l.unit_price, null)}</td>
            <td className="px-2 py-1 text-right">{l.discount_percent || ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChangeEntry({ change }: { change: InvoiceChangeRow }) {
  const [open, setOpen] = useState(false);
  const status = stateText(change.state);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="text-foreground-muted">
          {when(change.created_at)}
          {change.changed_by_name ? ` · ${change.changed_by_name}` : ''}
        </span>
        {status && <span className={change.state === 'discarded' ? 'text-foreground-muted' : 'text-warning'}>{status}</span>}
      </div>
      <p className="mt-1 text-sm text-foreground">{change.reason}</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-foreground">
        <span>{`${formatMoney(change.old_total, null)} → ${change.new_total === null ? '—' : formatMoney(change.new_total, null)}`}</span>
        <span>
          {invoiceLink(change.old_bc_invoice_id, change.old_bc_invoice_number)} →{' '}
          {invoiceLink(change.new_bc_invoice_id, change.new_bc_invoice_number)}
        </span>
        <button type="button" className="text-primary hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide lines' : 'Show lines'}
        </button>
      </div>
      {open && <LinesTable before={change.lines_before} after={change.lines_after} />}
    </li>
  );
}

/** The change log of an invoice (all changes of its sales order), newest first. */
export function InvoiceChangesCard({ changes }: { changes: InvoiceChangeRow[] }) {
  if (changes.length === 0) return null;
  return (
    <section className="glass-card rounded-xl border border-border p-4">
      <h2 className="text-sm font-semibold text-foreground">Changes</h2>
      <ul className="divide-y divide-border">
        {changes.map((c) => (
          <ChangeEntry key={c.id} change={c} />
        ))}
      </ul>
    </section>
  );
}
