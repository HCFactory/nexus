// Which Bill.com payment records a card charge made in Nexus, so each charge
// shows once. Used by the invoice page and the payment page alike.
import { hawaiiToday } from '@/lib/billcom/paymentDisplay';

export interface ChargeToMatch {
  id: string;
  amount: number | string;
  status: string;
  billcom_state: string;
  billcom_payment_id: string | null;
  charged_at: string;
}

export interface PaymentToMatch {
  billcomPaymentId: string;
  type: string | null;
  status: string | null;
  /** Amount applied to the invoice. */
  amount: number | null;
  date: string | null;
}

const LOOSE_DAYS = 7;
const sameAmount = (a: number | null, b: number | string) => a !== null && Math.abs(a - Number(b)) < 0.005;
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5;

/**
 * Bill.com payment id → the charge it records. Saved ids first; then, for
 * charges without one, a Bill.com card payment of the same amount on the same
 * Hawaii day; then, for charges staff say Bill.com has (recorded by hand), any
 * payment of the same amount within a week after. Cancelled payments and
 * payments already claimed are never matched.
 */
export function matchChargesToPayments<C extends ChargeToMatch>(charges: C[], payments: PaymentToMatch[]): Map<string, C> {
  const merged = new Map<string, C>();
  const open = (p: PaymentToMatch) => !merged.has(p.billcomPaymentId) && p.status !== 'CANCELED';

  for (const c of charges) {
    const hit = c.billcom_payment_id ? payments.find((p) => p.billcomPaymentId === c.billcom_payment_id) : undefined;
    if (hit) merged.set(hit.billcomPaymentId, c);
  }
  const guessable = charges.filter((c) => !c.billcom_payment_id && c.status === 'succeeded');
  for (const c of guessable) {
    const day = hawaiiToday(new Date(c.charged_at));
    const hit = payments.find((p) => open(p) && p.type === 'CREDIT_CARD' && sameAmount(p.amount, c.amount) && p.date === day);
    if (hit) merged.set(hit.billcomPaymentId, c);
  }
  const claimed = new Set(merged.values());
  for (const c of guessable.filter((x) => !claimed.has(x) && (x.billcom_state === 'recorded' || x.billcom_state === 'recorded_manually'))) {
    const day = hawaiiToday(new Date(c.charged_at));
    const hit = payments.find((p) => open(p) && sameAmount(p.amount, c.amount) && p.date !== null && daysBetween(day, p.date) >= 0 && daysBetween(day, p.date) <= LOOSE_DAYS);
    if (hit) merged.set(hit.billcomPaymentId, c);
  }
  return merged;
}
