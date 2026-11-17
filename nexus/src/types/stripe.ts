/**
 * Types for Stripe saved cards. They live here rather than in a 'use server'
 * actions module: such a module may only export async functions, and
 * Turbopack's dev transform fails on `export type` there while tsc/build/test
 * still pass. See commit 93094f8.
 *
 * No type here holds a card number or CVV: only brand, last4, expiry and
 * Stripe ids.
 */

import type { BillcomInvoiceStatus } from '@/lib/billcom/invoiceStatus';

export type CardPaymentStatus = 'processing' | 'succeeded' | 'failed';
export type CardPaymentBillcomState =
  | 'not_started'
  | 'recorded'
  | 'recorded_manually'
  | 'failed';

// Database rows

export interface StripeConnection {
  id: string;
  organization_id: string;
  display_name: string;
  secret_key_secret_id: string | null;
  webhook_secret_secret_id: string | null;
  livemode: boolean | null;
  stripe_account_id: string | null;
  is_enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface StripeCustomer {
  id: string;
  organization_id: string;
  stripe_connection_id: string;
  bc_customer_number: string;
  stripe_customer_id: string;
  created_at: string;
}

export interface CustomerCard {
  id: string;
  organization_id: string;
  stripe_connection_id: string;
  bc_customer_number: string;
  stripe_payment_method_id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  saved_at: string;
  removed_at: string | null;
  removed_by: string | null;
}

export interface CardSetupLink {
  id: string;
  organization_id: string;
  stripe_connection_id: string;
  bc_customer_number: string;
  token_hash: string;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  canceled_at: string | null;
  completed_at: string | null;
  emailed_to: string | null;
  stripe_checkout_session_id: string | null;
}

export interface CardPayment {
  id: string;
  organization_id: string;
  stripe_connection_id: string;
  bc_customer_number: string;
  sales_order_id: string | null;
  bc_invoice_id: string;
  billcom_invoice_id: string;
  billcom_customer_id: string;
  invoice_number: string;
  amount: number;
  currency: string;
  card_id: string;
  stripe_payment_intent_id: string | null;
  status: CardPaymentStatus;
  failure_message: string | null;
  billcom_state: CardPaymentBillcomState;
  billcom_payment_id: string | null;
  billcom_error: string | null;
  charged_by: string | null;
  charged_at: string;
  billcom_recorded_at: string | null;
  recorded_manually_by: string | null;
}

// Client-safe projections

/** Safe projection returned to the client: no Vault pointers. */
export interface StripeConnectionSummary {
  id: string;
  displayName: string;
  isEnabled: boolean;
  isDefault: boolean;
  livemode: boolean | null;
  stripeAccountId: string | null;
  hasCredentials: boolean;
  hasWebhookSecret: boolean;
}

export interface StripeConnectionInput {
  id?: string;
  displayName: string;
  /** Write-only. Blank or undefined on edit leaves the stored key alone. */
  secretKey?: string;
  /** Write-only. Blank or undefined on edit leaves the stored secret alone. */
  webhookSecret?: string;
  isDefault: boolean;
}

export interface StripeTestResult {
  ok: boolean;
  message: string;
  livemode?: boolean;
  stripeAccountId?: string;
}

export interface CardLabel {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  savedAt: string;
  stripePaymentMethodId: string;
  stripeConnectionId: string;
}

/** What the customer page shows: the active card (if any) and setup-link state. */
export interface CustomerCardView {
  /** 'off' = no enabled default Stripe connection. */
  stripe: 'off' | 'ready';
  card: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    savedAt: string;
  } | null;
  /** An unexpired, unused setup link, if one exists. */
  openLink: { createdAt: string; expiresAt: string; emailedTo: string | null } | null;
  canEdit: boolean;
}

/** A card payment as shown in the UI. */
export interface CardPaymentRow {
  id: string;
  bcInvoiceId: string;
  invoiceNumber: string;
  billcomInvoiceId: string;
  amount: number;
  currency: string;
  status: CardPaymentStatus;
  failureMessage: string | null;
  stripePaymentIntentId: string | null;
  billcomState: CardPaymentBillcomState;
  billcomError: string | null;
  billcomRecordedAt: string | null;
  chargedAt: string;
  chargedBy: string | null;
  recordedManuallyBy: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  /** Set by Check status when Stripe has no payment for a `processing` row. */
  stripeLookup?: 'not_found';
}

/**
 * Return type of findBillcomInvoiceForCharge: the live Bill.com invoice, or why
 * there is none. billcomCustomerId is null only when neither the invoice nor a
 * synced customer link names the Bill.com customer (it cannot be charged then).
 */
export type BillcomLookup =
  | { kind: 'found'; status: BillcomInvoiceStatus; billcomCustomerId: string | null }
  | { kind: 'not_linked' | 'not_found' | 'ambiguous' | 'off' };

export type ChargeEligibility =
  | { ok: true; amount: number; dueDate: string }
  | { ok: false; reason: string };
