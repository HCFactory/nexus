import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { createStripeForConnection, getWebhookSecret } from '@/lib/stripe/connection';
import { saveCardFromCheckoutSession } from '@/lib/stripe/saveCard';
import { createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stripe webhook for one Stripe connection. The connection id in the URL picks
 * the signing secret; the card is saved with that connection's organization.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  if (!UUID.test(connectionId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const supabase = createServiceClient();
  const { data: connection, error } = await supabase
    .from('stripe_connections')
    .select('id, organization_id, is_enabled')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not read the connection' }, { status: 500 });
  if (!connection) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const { organization_id: orgId, is_enabled: enabled } = connection as { organization_id: string; is_enabled: boolean };

  const signature = req.headers.get('stripe-signature');
  const secret = await getWebhookSecret(supabase, connectionId);
  if (!signature || !secret) {
    return NextResponse.json({ error: 'Missing signature or webhook secret' }, { status: 400 });
  }

  // The raw body: signature verification fails on re-serialized JSON.
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(body, signature, secret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // A disabled connection is ignored, not an error: a non-2xx would only make
  // Stripe retry for days. Checked after the signature so it is never revealed
  // to an unsigned caller.
  if (!enabled) {
    console.warn(`Stripe webhook: connection ${connectionId} is disabled; ignored ${event.type} ${event.id}`);
    return NextResponse.json({ received: true, ignored: 'connection disabled' });
  }

  if (event.type === 'checkout.session.completed' && event.data.object.mode === 'setup') {
    try {
      const stripe = await createStripeForConnection(supabase, orgId, connectionId);
      await saveCardFromCheckoutSession({ supabase, orgId, connectionId, stripe }, event.data.object.id);
    } catch (e) {
      // Non-2xx makes Stripe retry later.
      console.error(`Stripe webhook: could not save card for ${event.data.object.id}: ${e instanceof Error ? e.message : e}`);
      return NextResponse.json({ error: 'Could not save the card' }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
