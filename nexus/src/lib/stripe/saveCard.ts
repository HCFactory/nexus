import 'server-only';

import type Stripe from 'stripe';

import { sendCardSavedNotification } from '@/lib/email';

import type { StripeScope } from './connection';

/**
 * Saving a card. Shared by the Stripe webhook and the card-setup "done" page
 * (the fallback when the webhook is slow), so it must be idempotent.
 *
 * Only brand, last4, expiry and Stripe ids are stored. Card numbers and CVVs
 * never reach Nexus: Stripe Checkout collects them.
 */

const UNIQUE_VIOLATION = '23505';

/** The Stripe customer for this BC customer on this connection, created on first use. */
export async function ensureStripeCustomer(
  scope: StripeScope,
  a: { bcCustomerNumber: string; name: string; email: string | null },
): Promise<string> {
  const existing = await readStripeCustomerId(scope, a.bcCustomerNumber);
  if (existing) return existing;

  const customer = await scope.stripe.customers.create(
    {
      name: a.name,
      ...(a.email ? { email: a.email } : {}),
      metadata: { organization_id: scope.orgId, bc_customer_number: a.bcCustomerNumber },
    },
    // Two tabs opening the link at once get the same Stripe customer.
    { idempotencyKey: `nexus-stripe-customer-${scope.connectionId}-${a.bcCustomerNumber}` },
  );

  const { error } = await scope.supabase.from('stripe_customers').insert({
    organization_id: scope.orgId,
    stripe_connection_id: scope.connectionId,
    bc_customer_number: a.bcCustomerNumber,
    stripe_customer_id: customer.id,
  });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      const winner = await readStripeCustomerId(scope, a.bcCustomerNumber);
      if (winner) return winner;
    }
    throw new Error(`Could not save the Stripe customer: ${error.message}`);
  }
  return customer.id;
}

async function readStripeCustomerId(scope: StripeScope, bcCustomerNumber: string): Promise<string | null> {
  const { data, error } = await scope.supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('stripe_connection_id', scope.connectionId)
    .eq('bc_customer_number', bcCustomerNumber)
    .maybeSingle();
  if (error) throw new Error(`Could not read the Stripe customer: ${error.message}`);
  return (data as { stripe_customer_id: string } | null)?.stripe_customer_id ?? null;
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Records the card saved by a completed setup-mode Checkout Session.
 * Returns null (and writes nothing) for sessions that are not complete setup
 * sessions of this organization.
 *
 * Also returns null, without touching the Stripe default or the link, when
 * this payment method is not the customer's active card afterwards: a late or
 * replayed event for a card that has since been replaced (its row is removed),
 * or a lost race where another tab saved a different card at the same moment.
 * The card that is active in Nexus stays the Stripe default.
 */
export async function saveCardFromCheckoutSession(
  scope: StripeScope,
  checkoutSessionId: string,
): Promise<{ brand: string; last4: string } | null> {
  const { supabase, stripe, orgId, connectionId } = scope;
  const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
    expand: ['setup_intent.payment_method'],
  });

  if (session.mode !== 'setup' || session.status !== 'complete') return null;
  const metadata = session.metadata ?? {};
  if (metadata.organization_id !== orgId) return null;
  const bcCustomerNumber = metadata.bc_customer_number;
  const linkId = metadata.card_setup_link_id;
  if (!bcCustomerNumber || !linkId) return null;

  const setupIntent = session.setup_intent;
  if (!setupIntent || typeof setupIntent === 'string') return null;
  let paymentMethod: Stripe.PaymentMethod | null = null;
  if (typeof setupIntent.payment_method === 'string') {
    paymentMethod = await stripe.paymentMethods.retrieve(setupIntent.payment_method);
  } else {
    paymentMethod = setupIntent.payment_method;
  }
  const card = paymentMethod?.card;
  if (!paymentMethod || !card) return null;
  const customerId = idOf(session.customer as string | { id: string } | null);
  const label = { brand: card.brand, last4: card.last4 };

  const { data: existing, error: existingError } = await supabase
    .from('customer_cards')
    .select('id, removed_at')
    .eq('stripe_connection_id', connectionId)
    .eq('stripe_payment_method_id', paymentMethod.id)
    .maybeSingle();
  if (existingError) throw new Error(`Could not read saved cards: ${existingError.message}`);
  // Replaced since (late or replayed event): never make a retired card the default.
  if ((existing as { removed_at: string | null } | null)?.removed_at) return null;

  if (!existing) {
    // Retire the previous active card first: the one-active-card index
    // would reject the insert otherwise.
    const { data: previous, error: previousError } = await supabase
      .from('customer_cards')
      .select('id, stripe_payment_method_id')
      .eq('stripe_connection_id', connectionId)
      .eq('bc_customer_number', bcCustomerNumber)
      .is('removed_at', null)
      .maybeSingle();
    if (previousError) throw new Error(`Could not read saved cards: ${previousError.message}`);

    const old = previous as { id: string; stripe_payment_method_id: string } | null;
    if (old && old.stripe_payment_method_id !== paymentMethod.id) {
      const { error: removeError } = await supabase
        .from('customer_cards')
        .update({ removed_at: new Date().toISOString() })
        .eq('id', old.id);
      if (removeError) throw new Error(`Could not retire the previous card: ${removeError.message}`);
      try {
        await stripe.paymentMethods.detach(old.stripe_payment_method_id);
      } catch (e) {
        // Already detached (e.g. a concurrent save) is fine; the row is retired either way.
        console.warn(
          `Stripe: could not detach payment method ${old.stripe_payment_method_id}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }

    const { error: insertError } = await supabase.from('customer_cards').insert({
      organization_id: orgId,
      stripe_connection_id: connectionId,
      bc_customer_number: bcCustomerNumber,
      stripe_payment_method_id: paymentMethod.id,
      brand: card.brand,
      last4: card.last4,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
    });
    // A unique violation means a concurrent call (webhook vs done page) saved it.
    if (insertError && insertError.code !== UNIQUE_VIOLATION) {
      throw new Error(`Could not save the card: ${insertError.message}`);
    }
  }

  // Only the card Nexus holds as active may become the Stripe default. A 23505
  // above can come from the one-active index when another tab won the race.
  const { data: active, error: activeError } = await supabase
    .from('customer_cards')
    .select('stripe_payment_method_id')
    .eq('stripe_connection_id', connectionId)
    .eq('bc_customer_number', bcCustomerNumber)
    .is('removed_at', null)
    .maybeSingle();
  if (activeError) throw new Error(`Could not read saved cards: ${activeError.message}`);
  if ((active as { stripe_payment_method_id: string } | null)?.stripe_payment_method_id !== paymentMethod.id) {
    return null;
  }

  // Both steps are idempotent, so a retry after a partial failure finishes the job.
  if (customerId) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethod.id },
    });
  }
  const { data: completed, error: linkError } = await supabase
    .from('card_setup_links')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', linkId)
    .eq('organization_id', orgId)
    .is('completed_at', null)
    .select('id');
  if (linkError) throw new Error(`Could not complete the setup link: ${linkError.message}`);

  // Only the call that completed the link notifies staff, so the webhook and
  // the done page never both send it. Email trouble never fails the save.
  if ((completed ?? []).length > 0) {
    await notifyCardSaved(supabase, orgId, bcCustomerNumber, card);
  }

  return label;
}

async function notifyCardSaved(
  supabase: StripeScope['supabase'],
  orgId: string,
  bcCustomerNumber: string,
  card: { brand: string; last4: string; exp_month: number; exp_year: number },
): Promise<void> {
  try {
    const { data: customer } = await supabase
      .from('business_central_customers')
      .select('display_name')
      .eq('organization_id', orgId)
      .eq('bc_customer_number', bcCustomerNumber)
      .limit(1)
      .maybeSingle();
    await sendCardSavedNotification({
      customerName: (customer as { display_name: string | null } | null)?.display_name || bcCustomerNumber,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      savedAt: new Date(),
    });
  } catch (e) {
    console.error(`Card saved for ${bcCustomerNumber}, but the staff email failed: ${e instanceof Error ? e.message : e}`);
  }
}
