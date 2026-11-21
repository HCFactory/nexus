'use server';

import { revalidatePath } from 'next/cache';

import { requireOrganizationContext } from '@/lib/auth/currentUserAccess';
import { resolveActiveBcConnection } from '@/lib/businessCentral/activeConnection';
import { createBillcomClientForConnection } from '@/lib/billcom/connection';
import { resolveBillcomConnection } from '@/lib/billcom/customerSyncHooks';
import { sendStaffEmail } from '@/lib/email';
import { notifyBackupCharge } from '@/lib/notifications/backupChargeEmail';
import { findBillcomInvoiceForCharge, getSalesInvoicePage } from '@/lib/receivables/salesInvoicePage';
import {
  chargeInvoice,
  checkChargeStatus,
  invoiceChargeView,
  markNotCharged,
  markRecordedManually,
  retryBillcomRecord,
  invoiceChargeStatus,
  type ChargeDeps,
} from '@/lib/stripe/chargeInvoice';
import { createStripeForConnection, resolveStripeConnection } from '@/lib/stripe/connection';
import { createServiceClient } from '@/lib/supabase/server';
import type { CardLabel, CardPaymentRow, ChargeEligibility } from '@/types/stripe';

// NOTE: only async functions are exported here; types live in @/types/stripe.

const NO_PERMISSION = "You don't have permission to charge cards.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scope(requireCharge: boolean): Promise<{ deps: ChargeDeps; userId: string }> {
  const ctx = await requireOrganizationContext();
  const canCharge = Boolean(ctx.access.canChargeSavedCards);
  if (requireCharge && !canCharge) throw new Error(NO_PERMISSION);
  const supabase = createServiceClient();
  const orgId = ctx.orgId;
  // Stripe and Bill.com are picked per BC environment; no active environment = both off.
  const env = await resolveActiveBcConnection(orgId, ctx.user.id);
  const connection = env ? await resolveStripeConnection(supabase, orgId, env.id) : null;

  const deps: ChargeDeps = {
    supabase,
    orgId,
    canCharge,
    stripeConnectionId: connection?.enabled ? connection.id : null,
    stripeClient: (connectionId) => createStripeForConnection(supabase, orgId, connectionId),
    billcom: async () => {
      const conn = env ? await resolveBillcomConnection(supabase, orgId, env.id) : null;
      if (!conn?.enabled) return null;
      try {
        return await createBillcomClientForConnection(conn.id, orgId, { supabase });
      } catch (e) {
        console.error('[cardPayments] could not create the Bill.com client:', e);
        return null;
      }
    },
    loadInvoice: async (bcInvoiceId) => {
      const page = await getSalesInvoicePage(bcInvoiceId);
      if (!page) return null;
      const inv = page.invoice;
      return {
        bcInvoiceId: inv.bc_invoice_id,
        customerNumber: inv.customer_number,
        // The "Invoice #" staff see in the Nexus page header (BC External Document No.).
        invoiceNumber: inv.external_document_number || inv.bc_invoice_number || inv.bc_invoice_id,
        invoiceNumbers: [inv.external_document_number ?? '', inv.bc_invoice_number ?? ''],
        salesOrderId: page.salesOrder?.id ?? null,
        billcomInvoiceId: page.salesOrder?.billcomInvoiceId ?? null,
        status: invoiceChargeStatus(page),
        bcTotal: inv.total_amount_including_tax ?? null,
        customerName: inv.customer_name ?? null,
      };
    },
    findBillcomInvoice: findBillcomInvoiceForCharge,
    now: () => new Date(),
    notifyCharged: (cardPaymentId) =>
      notifyBackupCharge(
        {
          supabase,
          orgId,
          now: () => new Date(),
          send: sendStaffEmail,
          appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        },
        cardPaymentId,
      ),
  };
  return { deps, userId: ctx.user.id as string };
}

function checkId(id: string) {
  if (!UUID.test(id)) throw new Error('Card payment not found.');
}

function refresh(row: CardPaymentRow) {
  revalidatePath(`/receivables/invoices/${row.bcInvoiceId}`);
  return row;
}

/** Read-only: needs no charge permission (the eligibility says why not). */
export async function getInvoiceChargeView(
  bcInvoiceId: string,
): Promise<{ eligibility: ChargeEligibility; card: CardLabel | null; payments: CardPaymentRow[] }> {
  const { deps } = await scope(false);
  return invoiceChargeView(deps, bcInvoiceId);
}

/** expectedAmountCents and cardId are what staff confirmed; the server refuses if either changed. */
export async function chargeInvoiceCard(
  bcInvoiceId: string,
  confirmed: { expectedAmountCents: number; cardId: string },
): Promise<CardPaymentRow> {
  const { deps, userId } = await scope(true);
  if (!Number.isInteger(confirmed?.expectedAmountCents) || typeof confirmed?.cardId !== 'string') {
    throw new Error('Refresh and review before charging.');
  }
  return refresh(
    await chargeInvoice(deps, { bcInvoiceId, userId, expectedAmountCents: confirmed.expectedAmountCents, cardId: confirmed.cardId }),
  );
}

export async function retryCardPaymentBillcom(cardPaymentId: string): Promise<CardPaymentRow> {
  const { deps } = await scope(true);
  checkId(cardPaymentId);
  return refresh(await retryBillcomRecord(deps, cardPaymentId));
}

export async function markCardPaymentRecordedManually(cardPaymentId: string): Promise<CardPaymentRow> {
  const { deps, userId } = await scope(true);
  checkId(cardPaymentId);
  return refresh(await markRecordedManually(deps, cardPaymentId, userId));
}

export async function checkCardPaymentStatus(cardPaymentId: string): Promise<CardPaymentRow> {
  const { deps } = await scope(true);
  checkId(cardPaymentId);
  return refresh(await checkChargeStatus(deps, cardPaymentId));
}

export async function markCardPaymentNotCharged(cardPaymentId: string): Promise<CardPaymentRow> {
  const { deps, userId } = await scope(true);
  checkId(cardPaymentId);
  return refresh(await markNotCharged(deps, cardPaymentId, userId));
}
