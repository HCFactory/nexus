'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { cancelCardSetupLink, createCardSetupLink, removeCustomerCard } from '@/app/actions/customerCards';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CustomerCardView } from '@/types/stripe';

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: 'Pacific/Honolulu', month: 'short', day: 'numeric' });
const fullDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { timeZone: 'Pacific/Honolulu', month: 'short', day: 'numeric', year: 'numeric' });

function cardLabel(card: NonNullable<CustomerCardView['card']>): string {
  const brand = card.brand ? BRANDS[card.brand] ?? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card';
  const exp =
    card.expMonth && card.expYear
      ? `, exp ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear % 100).padStart(2, '0')}`
      : '';
  return `${brand} •••• ${card.last4 ?? '????'}${exp}`;
}

interface Props {
  customerNumber: string;
  /** Prefills the email dialog. */
  customerEmail: string | null;
  view: CustomerCardView;
}

export function CardOnFileCard({ customerNumber, customerEmail, view }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manual, setManual] = useState<{ url: string; expiresAt: string } | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [email, setEmail] = useState(customerEmail ?? '');

  const run = (work: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setManual(null);
    startTransition(async () => {
      try {
        await work();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.');
      }
    });
  };

  const copy = () =>
    run(async () => {
      const { url, expiresAt } = await createCardSetupLink(customerNumber, { email: null });
      try {
        await navigator.clipboard.writeText(url);
        setNotice(`Copied — expires ${shortDate(expiresAt)}`);
      } catch {
        // The link already exists (and earlier ones are cancelled), so show it for manual copying.
        setManual({ url, expiresAt });
      }
    });

  const sendEmail = () =>
    run(async () => {
      const { expiresAt } = await createCardSetupLink(customerNumber, { email: email.trim() });
      setEmailing(false);
      setNotice(`Link emailed to ${email.trim()} — expires ${shortDate(expiresAt)}`);
    });

  const remove = () => {
    if (!window.confirm('Remove this card? It will no longer be chargeable.')) return;
    run(() => removeCustomerCard(customerNumber));
  };

  const { card, openLink, canEdit } = view;
  const showEmailError = emailing && error;

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4 card-shadow">
      <h3 className="mb-3 text-sm font-semibold text-foreground">Card on file</h3>

      {view.stripe === 'off' ? (
        <p className="text-sm text-foreground-muted">Stripe isn&apos;t set up — an admin can add it in Admin.</p>
      ) : (
        <div className="space-y-3">
          {card ? (
            <p className="text-sm text-foreground">
              {cardLabel(card)} <span className="text-foreground-muted">· saved {fullDate(card.savedAt)}</span>
            </p>
          ) : (
            <p className="text-sm text-foreground-muted">No card on file.</p>
          )}

          {openLink && (
            <p className="text-sm text-foreground-muted">
              Link sent {shortDate(openLink.createdAt)} · expires {shortDate(openLink.expiresAt)}
            </p>
          )}

          {error && !showEmailError && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && <p className="text-sm text-foreground">{notice}</p>}
          {manual && (
            <div className="space-y-1">
              <p className="text-sm text-foreground">
                Couldn&apos;t copy automatically — copy this link (expires {shortDate(manual.expiresAt)}):
              </p>
              <Input
                readOnly
                aria-label="Card setup link"
                value={manual.url}
                onFocus={(e) => e.currentTarget.select()}
                ref={(el) => el?.select()}
              />
            </div>
          )}

          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => setEmailing(true)}>
                {card ? 'Send new link' : 'Email link'}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={pending} onClick={copy}>
                Copy link
              </Button>
              {openLink && (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => cancelCardSetupLink(customerNumber))}>
                  Cancel link
                </Button>
              )}
              {card && (
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={remove}>
                  Remove card
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {emailing && (
        <Dialog open onOpenChange={(o) => { if (!o && !pending) setEmailing(false); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Email a card setup link</DialogTitle>
              <DialogDescription>
                The customer gets a secure link to save a card. It expires in 14 days, and any earlier unused link stops working.
              </DialogDescription>
            </DialogHeader>
            {showEmailError && (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                sendEmail();
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="card-setup-email">Email address</Label>
                <Input id="card-setup-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={() => setEmailing(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={pending || !email.trim()}>
                  {pending ? 'Sending…' : 'Send link'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
