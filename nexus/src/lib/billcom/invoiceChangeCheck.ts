// Whether an invoice may be changed, from its Bill.com side
// (spec: docs/superpowers/specs/2026-11-17-change-invoice-design.md).
import type { BillcomClient } from './client';
import { readBillcomInvoiceStatus, type BillcomInvoiceStatus } from './invoiceStatus';

export const CHANGE_PAID = "Paid or partly paid in Bill.com — can't change";
export const CHANGE_VOID = 'Void in Bill.com';
export const CHANGE_UNREACHABLE = "Couldn't reach Bill.com — try again";
export const CHANGE_NOT_FOUND = "Not found in Bill.com — can't check payment";

/**
 * Why the invoice can't be changed, or null. Only an OPEN invoice with nothing
 * paid may change; an invoice whose amounts Bill.com didn't return can't be
 * shown to be unpaid, so it is treated as paid.
 */
export function changeBlockedReason(
  found: BillcomInvoiceStatus | 'ambiguous' | null | Error,
  ctx: { billcomOn: boolean; hasBillcomInvoice: boolean },
): string | null {
  if (!ctx.billcomOn) return null;
  if (found instanceof Error) return CHANGE_UNREACHABLE;
  if (found === null || found === 'ambiguous') return ctx.hasBillcomInvoice ? CHANGE_NOT_FOUND : null;
  if (found.status === 'VOID') return CHANGE_VOID;
  const unpaid =
    found.status === 'OPEN' &&
    found.totalAmount !== null &&
    found.dueAmount !== null &&
    Math.round(found.dueAmount * 100) === Math.round(found.totalAmount * 100);
  return unpaid ? null : CHANGE_PAID;
}

/**
 * Reads the order's Bill.com invoice and says why it can't be changed, or
 * null. `client` null = Bill.com is off, unless `unavailable` (turned on but
 * the client couldn't be built: payment can't be checked, so try again).
 * No saved Bill.com invoice = allowed (the change creates or finds it).
 */
export async function readChangeBlock(
  client: BillcomClient | null,
  billcomInvoiceId: string | null,
  opts: { unavailable?: boolean } = {},
): Promise<string | null> {
  if (opts.unavailable) return CHANGE_UNREACHABLE;
  if (!client) return changeBlockedReason(null, { billcomOn: false, hasBillcomInvoice: false });
  if (!billcomInvoiceId) return changeBlockedReason(null, { billcomOn: true, hasBillcomInvoice: false });
  let found: BillcomInvoiceStatus | 'ambiguous' | null | Error;
  try {
    found = await readBillcomInvoiceStatus(client, { billcomInvoiceId, invoiceNumbers: [] });
  } catch (e) {
    found = e instanceof Error ? e : new Error(String(e));
  }
  return changeBlockedReason(found, { billcomOn: true, hasBillcomInvoice: true });
}
