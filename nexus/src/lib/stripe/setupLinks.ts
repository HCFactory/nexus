import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';

import type { CardSetupLink } from '@/types/stripe';

import type { StripeScope } from './connection';
import { ensureStripeCustomer } from './saveCard';

/**
 * Card setup links: the raw token (32 random bytes, base64url) only ever
 * appears in the URL sent to the customer; the database keeps its SHA-256.
 */

export const SETUP_LINK_DAYS = 14;
export type SetupLinkRow = CardSetupLink;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSetupToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSetupToken(token) };
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/** Where customers open card setup links: CARD_SETUP_BASE_URL (e.g. a payment.<company> address), else the app's address. */
function cardSetupBaseUrl(): string {
  return (process.env.CARD_SETUP_BASE_URL?.trim() || appUrl()).replace(/\/+$/, '');
}

export function setupLinkUrl(token: string): string {
  return `${cardSetupBaseUrl()}/card-setup/${token}`;
}

/** Stripe refuses to expire a session that is already expired or complete: nothing left to do. */
function alreadyClosed(e: unknown): boolean {
  const err = (e ?? {}) as { type?: string; message?: string };
  return err.type === 'StripeInvalidRequestError' && /expired|complete|status/i.test(err.message ?? '');
}

/**
 * Cancels every unused (not completed, not cancelled) link for the customer on this connection.
 * With `stripe` (an explicit staff cancel only), also expires each link's open Checkout
 * session so a customer already on the Stripe page cannot still save a card. A Stripe
 * error never stops the cancel.
 */
export async function cancelSetupLinks(
  supabase: SupabaseClient,
  a: { orgId: string; connectionId: string; bcCustomerNumber: string },
  opts: { stripe?: Stripe } = {},
): Promise<void> {
  if (opts.stripe) {
    const { data, error: readError } = await supabase
      .from('card_setup_links')
      .select('id, stripe_checkout_session_id')
      .eq('organization_id', a.orgId)
      .eq('stripe_connection_id', a.connectionId)
      .eq('bc_customer_number', a.bcCustomerNumber)
      .is('canceled_at', null)
      .is('completed_at', null);
    if (readError) console.error('[setupLinks] could not read setup links to expire their Checkout sessions:', readError.message);
    for (const link of (data ?? []) as { id: string; stripe_checkout_session_id: string | null }[]) {
      if (!link.stripe_checkout_session_id) continue;
      try {
        await opts.stripe.checkout.sessions.expire(link.stripe_checkout_session_id);
      } catch (e) {
        if (!alreadyClosed(e)) {
          console.error(`[setupLinks] could not expire Checkout session ${link.stripe_checkout_session_id} for link ${link.id}:`, e);
        }
      }
    }
  }

  const { error } = await supabase
    .from('card_setup_links')
    .update({ canceled_at: new Date().toISOString() })
    .eq('organization_id', a.orgId)
    .eq('stripe_connection_id', a.connectionId)
    .eq('bc_customer_number', a.bcCustomerNumber)
    .is('canceled_at', null)
    .is('completed_at', null);
  if (error) throw new Error(`Could not cancel earlier setup links: ${error.message}`);
}

/** Creates a new link, cancelling earlier unused ones first. */
export async function createSetupLink(
  supabase: SupabaseClient,
  a: {
    orgId: string;
    connectionId: string;
    bcCustomerNumber: string;
    createdBy: string | null;
    emailedTo: string | null;
  },
): Promise<{ id: string; url: string; expiresAt: string }> {
  await cancelSetupLinks(supabase, a);

  const { token, tokenHash } = newSetupToken();
  const expiresAt = new Date(Date.now() + SETUP_LINK_DAYS * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from('card_setup_links')
    .insert({
      organization_id: a.orgId,
      stripe_connection_id: a.connectionId,
      bc_customer_number: a.bcCustomerNumber,
      token_hash: tokenHash,
      created_by: a.createdBy,
      expires_at: expiresAt,
      emailed_to: a.emailedTo,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Could not create the setup link: ${error?.message ?? 'no row'}`);

  return { id: (data as { id: string }).id, url: setupLinkUrl(token), expiresAt };
}

/** The link for a token in any state, or null if the token is malformed or unknown. */
export async function findSetupLinkByToken(
  supabase: SupabaseClient,
  token: string,
): Promise<SetupLinkRow | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await supabase
    .from('card_setup_links')
    .select('*')
    .eq('token_hash', hashSetupToken(token))
    .maybeSingle();
  if (error) throw new Error(`Could not read the setup link: ${error.message}`);
  return (data as SetupLinkRow | null) ?? null;
}

/** The link if it can still be used: not expired, cancelled or completed. */
export async function findUsableSetupLink(
  supabase: SupabaseClient,
  token: string,
  now: Date = new Date(),
): Promise<SetupLinkRow | null> {
  const link = await findSetupLinkByToken(supabase, token);
  if (!link) return null;
  if (link.canceled_at || link.completed_at) return null;
  if (new Date(link.expires_at).getTime() <= now.getTime()) return null;
  return link;
}

export function consentText(organizationName: string): string {
  return `By saving this card you authorize ${organizationName} to charge it for past-due invoices.`;
}

/**
 * Starts a fresh setup-mode Checkout Session for a usable link and returns
 * the Stripe-hosted URL to redirect the customer to.
 */
export async function startSetupCheckout(
  scope: StripeScope,
  link: SetupLinkRow,
  token: string,
): Promise<string> {
  const { supabase, orgId } = scope;

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();
  if (orgError) throw new Error(`Could not read the organization: ${orgError.message}`);
  const orgName = (org as { name: string } | null)?.name ?? 'us';

  const { data: customer, error: customerError } = await supabase
    .from('business_central_customers')
    .select('display_name, email')
    .eq('organization_id', orgId)
    .eq('bc_customer_number', link.bc_customer_number)
    .limit(1)
    .maybeSingle();
  if (customerError) throw new Error(`Could not read the customer: ${customerError.message}`);
  const c = customer as { display_name: string | null; email: string | null } | null;

  const stripeCustomerId = await ensureStripeCustomer(scope, {
    bcCustomerNumber: link.bc_customer_number,
    name: c?.display_name || link.bc_customer_number,
    email: link.emailed_to || c?.email || null,
  });

  const linkUrl = setupLinkUrl(token);
  const session = await scope.stripe.checkout.sessions.create({
    mode: 'setup',
    customer: stripeCustomerId,
    currency: 'usd',
    allowed_payment_method_types: ['card'],
    success_url: `${linkUrl}/done?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: linkUrl,
    custom_text: { submit: { message: consentText(orgName) } },
    metadata: {
      organization_id: orgId,
      bc_customer_number: link.bc_customer_number,
      card_setup_link_id: link.id,
    },
  });
  if (!session.url) throw new Error('Stripe did not return a Checkout URL.');

  const { error: storeError } = await supabase
    .from('card_setup_links')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', link.id);
  if (storeError) throw new Error(`Could not store the Checkout session: ${storeError.message}`);

  return session.url;
}
