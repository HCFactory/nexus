import { billcomStatusLabel } from './invoiceStatus';

export interface PaymentDisplay {
  key: 'paid' | 'pastdue' | 'open' | 'void';
  label: string;
  /** success = green, destructive = red, plain = default text. */
  tone: 'success' | 'destructive' | 'plain';
}

/** YYYY-MM-DD in Hawaii (the business date). */
export function hawaiiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Honolulu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * How a Bill.com payment status reads in Nexus: Paid (green); Past due (red)
 * when money is still owed after the due date; otherwise Bill.com's own label.
 * Shared by the invoice page and the invoices list.
 */
export function billcomPaymentDisplay(
  s: { status: string | null; dueAmount: number | null; dueDate: string | null },
  today: string,
): PaymentDisplay {
  const status = s.status ?? '';
  if (status === 'PAID_IN_FULL') return { key: 'paid', label: 'Paid', tone: 'success' };
  if (status === 'VOID') return { key: 'void', label: billcomStatusLabel(status), tone: 'plain' };
  if ((s.dueAmount ?? 0) > 0 && s.dueDate && s.dueDate.slice(0, 10) < today) return { key: 'pastdue', label: 'Past due', tone: 'destructive' };
  return { key: 'open', label: status ? billcomStatusLabel(status) : 'Unknown', tone: 'plain' };
}
