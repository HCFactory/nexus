import { createStripeForConnection } from '@/lib/stripe/connection';
import { saveCardFromCheckoutSession } from '@/lib/stripe/saveCard';
import { findSetupLinkByToken } from '@/lib/stripe/setupLinks';
import { createServiceClient } from '@/lib/supabase/server';

import { CardSetupMessage } from '../CardSetupMessage';
import { CardSavedMessage } from './CardSavedMessage';

export const dynamic = 'force-dynamic';

/**
 * Where Stripe Checkout returns the customer. Saves the card here too, in
 * case the webhook has not arrived yet (saving is idempotent).
 */
export default async function CardSetupDonePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ session_id?: string | string[] }>;
}) {
  const { token } = await params;
  const { session_id: rawSessionId } = await searchParams;
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId : null;
  const supabase = createServiceClient();

  const link = await findSetupLinkByToken(supabase, token);
  const ownSession = Boolean(link && sessionId && sessionId === link.stripe_checkout_session_id);
  if (!link || (!ownSession && !link.completed_at)) {
    return <CardSetupMessage>This link is no longer valid — please contact us.</CardSetupMessage>;
  }

  let saved: { brand: string; last4: string } | null = null;
  if (ownSession && sessionId) {
    try {
      const stripe = await createStripeForConnection(supabase, link.organization_id, link.stripe_connection_id);
      saved = await saveCardFromCheckoutSession(
        { supabase, orgId: link.organization_id, connectionId: link.stripe_connection_id, stripe },
        sessionId,
      );
    } catch (e) {
      // The webhook will save it; the customer still sees the generic thanks.
      console.error(`Card setup: could not save card for link ${link.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return <CardSavedMessage last4={saved?.last4 ?? null} />;
}
