'use server';

import { revalidatePath } from 'next/cache';
import { requireOrganizationContext } from '@/lib/auth/currentUserAccess';
import { sendCardSetupEmail } from '@/lib/email';
import { createStripeForConnection, resolveDefaultStripeConnection } from '@/lib/stripe/connection';
import { cancelSetupLinks, createSetupLink } from '@/lib/stripe/setupLinks';
import { createServiceClient } from '@/lib/supabase/server';
import type { CustomerCardView } from '@/types/stripe';

// NOTE: only async functions are exported here; types live in @/types/stripe.

const NO_PERMISSION = "You don't have permission to change customers";
const STRIPE_OFF = "Stripe isn't set up — an admin can add it in Admin.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireEditScope(bcCustomerNumber: string) {
  const ctx = await requireOrganizationContext();
  if (!ctx.access.canEditCustomers || !ctx.access.canViewCustomers) throw new Error(NO_PERMISSION);
  if (!bcCustomerNumber) throw new Error('This customer has no Business Central number.');
  const supabase = createServiceClient();
  const connection = await resolveDefaultStripeConnection(supabase, ctx.orgId);
  if (!connection || !connection.enabled) throw new Error(STRIPE_OFF);
  return { supabase, orgId: ctx.orgId, userId: ctx.user.id as string, connectionId: connection.id };
}

export async function getCustomerCardView(bcCustomerNumber: string): Promise<CustomerCardView> {
  const ctx = await requireOrganizationContext();
  if (!ctx.access.canViewCustomers) throw new Error("You don't have permission to view customers");
  const canEdit = ctx.access.canEditCustomers;
  const supabase = createServiceClient();
  const connection = await resolveDefaultStripeConnection(supabase, ctx.orgId);
  if (!connection || !connection.enabled) {
    return { stripe: 'off', card: null, openLink: null, canEdit };
  }

  const scoped = { organization_id: ctx.orgId, stripe_connection_id: connection.id, bc_customer_number: bcCustomerNumber };
  const [cardRes, linkRes] = await Promise.all([
    supabase
      .from('customer_cards')
      .select('brand, last4, exp_month, exp_year, saved_at')
      .match(scoped)
      .is('removed_at', null)
      .maybeSingle(),
    supabase
      .from('card_setup_links')
      .select('created_at, expires_at, emailed_to')
      .match(scoped)
      .is('canceled_at', null)
      .is('completed_at', null)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (cardRes.error) throw new Error(`Could not read the card: ${cardRes.error.message}`);
  if (linkRes.error) throw new Error(`Could not read the setup link: ${linkRes.error.message}`);

  const c = cardRes.data as { brand: string | null; last4: string | null; exp_month: number | null; exp_year: number | null; saved_at: string } | null;
  const l = linkRes.data as { created_at: string; expires_at: string; emailed_to: string | null } | null;
  return {
    stripe: 'ready',
    card: c ? { brand: c.brand, last4: c.last4, expMonth: c.exp_month, expYear: c.exp_year, savedAt: c.saved_at } : null,
    openLink: l ? { createdAt: l.created_at, expiresAt: l.expires_at, emailedTo: l.emailed_to } : null,
    canEdit,
  };
}

export async function createCardSetupLink(
  bcCustomerNumber: string,
  opts: { email: string | null },
): Promise<{ url: string; expiresAt: string }> {
  const email = opts.email?.trim() || null;
  const s = await requireEditScope(bcCustomerNumber);
  if (email && !EMAIL_PATTERN.test(email)) throw new Error('Enter a valid email address.');

  const link = await createSetupLink(s.supabase, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    bcCustomerNumber,
    createdBy: s.userId,
    emailedTo: email,
  });

  if (email) {
    try {
      const [{ data: org }, { data: customer }] = await Promise.all([
        s.supabase.from('organizations').select('name').eq('id', s.orgId).maybeSingle(),
        s.supabase
          .from('business_central_customers')
          .select('display_name')
          .eq('organization_id', s.orgId)
          .eq('bc_customer_number', bcCustomerNumber)
          .limit(1)
          .maybeSingle(),
      ]);
      await sendCardSetupEmail({
        to: email,
        organizationName: (org as { name: string } | null)?.name ?? 'us',
        customerName: (customer as { display_name: string | null } | null)?.display_name || bcCustomerNumber,
        url: link.url,
        expiresAt: link.expiresAt,
      });
    } catch (e) {
      // Never leave a usable link behind that nobody received.
      await cancelSetupLinks(s.supabase, { orgId: s.orgId, connectionId: s.connectionId, bcCustomerNumber });
      throw new Error(`The email could not be sent: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  revalidatePath('/customers');
  return { url: link.url, expiresAt: link.expiresAt };
}

export async function cancelCardSetupLink(bcCustomerNumber: string): Promise<void> {
  const s = await requireEditScope(bcCustomerNumber);
  // Also expire any open Checkout session; without a Stripe client the link is still cancelled.
  const stripe = await createStripeForConnection(s.supabase, s.orgId, s.connectionId).catch((e: unknown) => {
    console.error('[customerCards] could not create the Stripe client to expire the Checkout session:', e);
    return undefined;
  });
  await cancelSetupLinks(s.supabase, { orgId: s.orgId, connectionId: s.connectionId, bcCustomerNumber }, { stripe });
  revalidatePath('/customers');
}

export async function removeCustomerCard(bcCustomerNumber: string): Promise<void> {
  const s = await requireEditScope(bcCustomerNumber);
  const { data, error } = await s.supabase
    .from('customer_cards')
    .select('id, stripe_payment_method_id')
    .match({ organization_id: s.orgId, stripe_connection_id: s.connectionId, bc_customer_number: bcCustomerNumber })
    .is('removed_at', null)
    .maybeSingle();
  if (error) throw new Error(`Could not read the card: ${error.message}`);
  const card = data as { id: string; stripe_payment_method_id: string } | null;
  if (!card) return;

  // Mark removed first so a Stripe hiccup can never leave a chargeable card showing.
  const { error: updError } = await s.supabase
    .from('customer_cards')
    .update({ removed_at: new Date().toISOString(), removed_by: s.userId })
    .eq('id', card.id)
    .is('removed_at', null);
  if (updError) throw new Error(`Could not remove the card: ${updError.message}`);

  const stripe = await createStripeForConnection(s.supabase, s.orgId, s.connectionId);
  try {
    await stripe.paymentMethods.detach(card.stripe_payment_method_id);
  } catch (e) {
    console.error('[customerCards] Stripe detach failed after removing the card:', e);
    throw new Error('The card was removed here, but Stripe could not detach it. Remove it in the Stripe dashboard.');
  }
  revalidatePath('/customers');
}
