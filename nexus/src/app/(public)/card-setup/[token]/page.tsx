import { redirect } from 'next/navigation';

import { createStripeForConnection } from '@/lib/stripe/connection';
import { findUsableSetupLink, startSetupCheckout } from '@/lib/stripe/setupLinks';
import { createServiceClient } from '@/lib/supabase/server';

import { CardSetupMessage } from './CardSetupMessage';

export const dynamic = 'force-dynamic';

/**
 * Public card-setup link (no sign-in). Each visit creates a fresh setup-mode
 * Checkout Session and redirects to Stripe, which collects the card.
 */
export default async function CardSetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = createServiceClient();

  const link = await findUsableSetupLink(supabase, token);
  if (!link) return <CardSetupMessage>This link is no longer valid — please contact us.</CardSetupMessage>;

  let checkoutUrl: string;
  try {
    const stripe = await createStripeForConnection(supabase, link.organization_id, link.stripe_connection_id);
    checkoutUrl = await startSetupCheckout(
      { supabase, orgId: link.organization_id, connectionId: link.stripe_connection_id, stripe },
      link,
      token,
    );
  } catch (e) {
    console.error(`Card setup: could not start Checkout for link ${link.id}: ${e instanceof Error ? e.message : e}`);
    return <CardSetupMessage>Card setup is unavailable right now — please contact us.</CardSetupMessage>;
  }

  // Outside the try: redirect() works by throwing.
  redirect(checkoutUrl);
}
