'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  chargeInvoiceCard,
  checkCardPaymentStatus,
  markCardPaymentNotCharged,
  markCardPaymentRecordedManually,
  retryCardPaymentBillcom,
} from '@/app/actions/cardPayments';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatMoney } from '@/lib/format';
import type { CardLabel, CardPaymentRow, ChargeEligibility } from '@/types/stripe';

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

const brandName = (brand: string | null) =>
  brand ? BRANDS[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card';
const cardText = (brand: string | null, last4: string | null) => `${brandName(brand)} •••• ${last4 ?? '????'}`;
const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: 'Pacific/Honolulu', month: 'short', day: 'numeric', year: 'numeric' });

interface Props {
  bcInvoiceId: string;
  /** Shown in the confirm dialog, e.g. "1043 / PO-77". */
  invoiceNumber: string;
  eligibility: ChargeEligibility;
  card: CardLabel | null;
  payments: CardPaymentRow[];
  /** The user holds "Charge saved cards": without it there are no action buttons. */
  canCharge: boolean;
}

type Confirm = { kind: 'charge' } | { kind: 'manual' | 'notCharged'; id: string };

function stripeText(p: CardPaymentRow): string {
  if (p.status === 'succeeded') return 'Charged';
  if (p.status === 'failed') return p.failureMessage ? `Failed — ${p.failureMessage}` : 'Failed';
  return 'Checking with Stripe…';
}

function billcomText(p: CardPaymentRow): string {
  if (p.status !== 'succeeded') return '—';
  switch (p.billcomState) {
    case 'recorded':
      return 'Recorded in Bill.com';
    case 'recorded_manually':
      return 'Marked paid in Bill.com (manually)';
    case 'failed':
      return 'Charged in Stripe — Bill.com not updated';
    default:
      return 'Not recorded yet';
  }
}

export function CardChargePanel({ bcInvoiceId, invoiceNumber, eligibility, card, payments, canCharge }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notFound, setNotFound] = useState<Set<string>>(new Set());

  const run = (work: () => Promise<void>) => {
    setError(null);
    startTransition(async () => {
      try {
        await work();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
      }
    });
  };

  const closeThen = (work: () => Promise<void>) => {
    setConfirm(null);
    run(work);
  };

  const check = (id: string) =>
    run(async () => {
      const row = await checkCardPaymentStatus(id);
      setNotFound((prev) => {
        const next = new Set(prev);
        if (row.stripeLookup === 'not_found' && row.status === 'processing') next.add(id);
        else next.delete(id);
        return next;
      });
    });

  const amountText = eligibility.ok ? formatMoney(eligibility.amount, 'USD') : '';

  // Sends what the dialog showed: the server refuses if the amount or card has changed since.
  const charge = async () => {
    if (!eligibility.ok || !card) return;
    try {
      await chargeInvoiceCard(bcInvoiceId, { expectedAmountCents: Math.round(eligibility.amount * 100), cardId: card.id });
    } catch (e) {
      router.refresh(); // show the current amount and card next to the error
      throw e;
    }
  };
  const chargeQuestion = `Charge ${cardText(card?.brand ?? null, card?.last4 ?? null)} ${amountText} for Invoice ${invoiceNumber}?`;

  const rows = payments.map((p) => (notFound.has(p.id) && p.status === 'processing' ? { ...p, stripeLookup: 'not_found' as const } : p));

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Card payment</h3>

      {eligibility.ok ? (
        canCharge && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" disabled={pending} onClick={() => setConfirm({ kind: 'charge' })}>
              Charge card
            </Button>
            <span className="text-sm text-foreground-muted">
              {cardText(card?.brand ?? null, card?.last4 ?? null)} · {amountText} due {dateText(eligibility.dueDate)}
            </span>
          </div>
        )
      ) : (
        <p className="text-sm text-foreground-muted">{eligibility.reason}</p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((p) => (
            <li key={p.id} className="space-y-2 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-foreground-muted">{dateText(p.chargedAt)}</span>
                <span className="font-medium text-foreground">{formatMoney(p.amount, p.currency.toUpperCase())}</span>
                <span className="text-foreground">{cardText(p.cardBrand, p.cardLast4)}</span>
                <span className="text-foreground-muted">{p.chargedBy ? `By ${p.chargedByName ?? 'staff'}` : 'By the system'}</span>
              </div>
              <div className="grid gap-1 sm:grid-cols-2">
                <div>
                  <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Stripe </span>
                  <span className="text-foreground">{stripeText(p)}</span>
                </div>
                <div>
                  <span className="text-[11px] uppercase tracking-wide text-foreground-muted">Bill.com </span>
                  <span className="text-foreground">{billcomText(p)}</span>
                  {p.billcomState === 'recorded_manually' && p.recordedManuallyBy && (
                    <div className="text-foreground-muted">Marked paid in Bill.com by {p.recordedManuallyByName ?? 'staff'}</div>
                  )}
                </div>
              </div>
              {p.status === 'failed' && p.notChargedAt && (
                <p className="text-foreground-muted">
                  Marked as not charged by {p.notChargedByName ?? 'staff'} on {dateText(p.notChargedAt)}
                </p>
              )}

              {p.status === 'processing' && canCharge && (
                <div className="space-y-2">
                  {p.stripeLookup === 'not_found' && <p className="text-foreground">No charge found in Stripe yet.</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => check(p.id)}>
                      Check status
                    </Button>
                    {p.stripeLookup === 'not_found' && (
                      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirm({ kind: 'notCharged', id: p.id })}>
                        Mark as not charged
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {p.status === 'succeeded' && p.billcomState === 'not_started' && p.billcomStuck && canCharge && (
                <div className="space-y-2">
                  <p className="text-foreground-muted">
                    Recording in Bill.com started over 10 minutes ago and has not finished. The payment may already be recorded in
                    Bill.com — use Check status, then check Bill.com before pressing Retry.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => check(p.id)}>
                      Check status
                    </Button>
                  </div>
                </div>
              )}

              {p.status === 'succeeded' && p.billcomState === 'failed' && (
                <div className="space-y-2">
                  {p.billcomError && <p className="text-foreground-muted">{p.billcomError}</p>}
                  {canCharge && (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(async () => void (await retryCardPaymentBillcom(p.id)))}>
                          Retry Bill.com
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setConfirm({ kind: 'manual', id: p.id })}>
                          I marked it paid in Bill.com
                        </Button>
                      </div>
                      <p className="text-foreground-muted">
                        If the payment already shows in Bill.com, use &quot;I marked it paid in Bill.com&quot; instead of Retry.
                      </p>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <Dialog open onOpenChange={(o) => { if (!o && !pending) setConfirm(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirm.kind === 'charge' ? 'Charge card' : confirm.kind === 'manual' ? 'Mark as paid in Bill.com' : 'Mark as not charged'}
              </DialogTitle>
              <DialogDescription>
                {confirm.kind === 'charge'
                  ? chargeQuestion
                  : confirm.kind === 'manual'
                    ? 'Only do this after you have recorded the payment in Bill.com yourself. Mark it as paid in Bill.com?'
                    : 'Only do this after checking the Stripe dashboard. Mark this charge as not charged?'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => {
                  const c = confirm;
                  closeThen(async () => {
                    if (c.kind === 'charge') await charge();
                    else if (c.kind === 'manual') await markCardPaymentRecordedManually(c.id);
                    else await markCardPaymentNotCharged(c.id);
                  });
                }}
              >
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
