'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { createInvoice, retryInvoice } from '@/app/actions/salesOrderInvoicing';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatMoney } from '@/lib/format';
import { canStartInvoice, isPastPosting } from '@/lib/salesOrders/orderRules';
import type { InvoiceState, SalesOrderRow } from '@/types/salesOrders';
import { GlassButton as Button } from './GlassButton';

/** The one-line invoice status (header status line and list Sync column); null before an invoice starts. */
export function invoiceStatusText(state: InvoiceState): string | null {
  if (state === 'posting' || state === 'posted' || state === 'billcom_sending') return 'Invoicing…';
  if (state === 'post_failed') return "Couldn't post";
  if (state === 'billcom_failed') return 'Invoiced · Not in Bill.com';
  if (state === 'done') return 'Invoiced · In Bill.com';
  return null;
}

/** True while the invoice process is mid-step (the page polls for the result). */
export function isInvoiceRunning(state: InvoiceState): boolean {
  return state === 'posting' || state === 'posted' || state === 'billcom_sending';
}

/** True when the order is locked by the invoice process (posting or past it). */
export function isInvoiceLocked(state: InvoiceState): boolean {
  return state === 'posting' || isPastPosting(state);
}

/** Create invoice shows for Final/Pulled orders for people who can edit, until the invoice is posting or posted. */
export function showsCreateInvoice(order: Pick<SalesOrderRow, 'status' | 'invoice_state'>, canEdit: boolean): boolean {
  return (
    canEdit &&
    (order.status === 'final' || order.status === 'pulled') &&
    !isPastPosting(order.invoice_state) &&
    order.invoice_state !== 'posting'
  );
}

const DOT: Partial<Record<InvoiceState, string>> = {
  posting: 'bg-sky-500', posted: 'bg-sky-500', billcom_sending: 'bg-sky-500',
  post_failed: 'bg-red-500', billcom_failed: 'bg-amber-500', done: 'bg-green-500',
};
const TEXT: Partial<Record<InvoiceState, string>> = {
  posting: 'text-foreground-muted', posted: 'text-foreground-muted', billcom_sending: 'text-foreground-muted',
  post_failed: 'text-destructive', billcom_failed: 'text-warning', done: 'text-foreground',
};

/** The invoice status line, with Retry for a failed step and View invoice once BC has the posted invoice. */
export function InvoiceStatus({
  order,
  canEdit,
  className,
  onError,
}: {
  order: Pick<SalesOrderRow, 'id' | 'invoice_state' | 'invoice_error' | 'bc_posted_invoice_number'>;
  canEdit: boolean;
  className?: string;
  onError?: (message: string | null) => void;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const text = invoiceStatusText(order.invoice_state);
  if (!text) return null;
  const failed = order.invoice_state === 'post_failed' || order.invoice_state === 'billcom_failed';
  const number = order.bc_posted_invoice_number;

  const retry = async () => {
    setRetrying(true);
    onError?.(null);
    try {
      const res = await retryInvoice(order.id);
      if (!res.ok) onError?.(res.error);
      else router.refresh();
    } catch (e) {
      onError?.(e instanceof Error ? e.message : 'Could not retry the invoice.');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? 'text-sm'}`}>
      <span
        className={`inline-flex items-center gap-1.5 ${TEXT[order.invoice_state]}`}
        role="status"
        title={failed ? order.invoice_error ?? undefined : undefined}
      >
        <span aria-hidden className={`size-2 rounded-full ${DOT[order.invoice_state]}`} />
        {text}
      </span>
      {canEdit && failed && (
        <Button type="button" size="sm" variant="outline" disabled={retrying} onClick={retry}>
          Retry
        </Button>
      )}
      {number && (
        <Link
          href={`/receivables/invoices?q=${encodeURIComponent(number)}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          View invoice
        </Link>
      )}
    </div>
  );
}

interface ControlsProps {
  order: SalesOrderRow;
  canEdit: boolean;
  /** The form has edits that aren't saved yet. */
  dirty: boolean;
  blockedReason: string | null | undefined;
  invoiceNumber: string;
  customerLabel: string;
  total: number;
  /** YYYY-MM-DD, the page's today. */
  today: string;
}

const dateLabel = (today: string) =>
  new Date(`${today}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The Create invoice button and its confirm box. Renders nothing when the order can't be invoiced from here. */
export function InvoiceControls({ order, canEdit, dirty, blockedReason, invoiceNumber, customerLabel, total, today }: ControlsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!showsCreateInvoice(order, canEdit)) return null;
  const enabled = canStartInvoice(order) && !dirty && !blockedReason && !busy;
  const title = blockedReason || (dirty ? 'Save your changes before invoicing.' : undefined);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createInvoice(order.id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the invoice.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button type="button" variant="blue-glass" disabled={!enabled} title={title} onClick={() => { setError(null); setOpen(true); }}>
        {busy ? 'Invoicing…' : 'Create invoice'}
      </Button>
      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Create invoice for {order.bc_order_number}?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-1">
                <p>Customer: {customerLabel}</p>
                <p>Total: {formatMoney(total, null)}</p>
                <p>Invoice #: {invoiceNumber}</p>
                <p>Invoice date today ({dateLabel(today)})</p>
                <p className="pt-1 font-medium text-foreground">This posts the order in BC. It can&apos;t be undone.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" size="sm" variant="blue-glass" disabled={busy} onClick={create}>
              {busy ? 'Invoicing…' : 'Create invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
