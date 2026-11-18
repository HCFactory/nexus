import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

export interface StripeScope {
  supabase: SupabaseClient;
  orgId: string;
  connectionId: string;
  stripe: Stripe;
}

/**
 * The Stripe connection picked for this BC environment (Admin → Business
 * Central Environments → Edit), with whether it is enabled and live. Nothing
 * picked is null: Stripe is off for that environment.
 */
export async function resolveStripeConnection(
  supabase: SupabaseClient,
  orgId: string,
  bcConnectionId: string,
): Promise<{ id: string; enabled: boolean; livemode: boolean } | null> {
  const { data: env, error: envError } = await supabase
    .from('business_central_connections')
    .select('stripe_connection_id')
    .eq('id', bcConnectionId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (envError) throw new Error(`Could not read the BC environment: ${envError.message}`);
  const picked = (env as { stripe_connection_id: string | null } | null)?.stripe_connection_id ?? null;
  if (!picked) return null;
  const { data, error } = await supabase
    .from('stripe_connections')
    .select('id, is_enabled, livemode')
    .eq('id', picked)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the Stripe connection: ${error.message}`);
  const row = data as { id: string; is_enabled: boolean; livemode: boolean | null } | null;
  return row ? { id: row.id, enabled: row.is_enabled, livemode: Boolean(row.livemode) } : null;
}

/** A Stripe client for a key an admin just typed (to check it before it is stored). */
export function createStripeForKey(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

/** Builds a Stripe client from the Vault-stored key. Throws if disabled or key missing. */
export async function createStripeForConnection(
  supabase: SupabaseClient,
  orgId: string,
  connectionId: string,
): Promise<Stripe> {
  const { data, error } = await supabase
    .from('stripe_connections')
    .select('id, is_enabled')
    .eq('id', connectionId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the Stripe connection: ${error.message}`);
  if (!data) {
    // Same message for "missing" and "another org's" so ids cannot be probed.
    throw new Error(`Stripe connection ${connectionId} was not found.`);
  }
  // Check the toggle before touching Vault.
  if (!(data as { is_enabled: boolean }).is_enabled) {
    throw new Error(`Stripe connection ${connectionId} is disabled.`);
  }

  const { data: secretKey, error: keyError } = await supabase.rpc('get_stripe_secret_key', {
    p_connection_id: connectionId,
  });
  if (keyError) throw new Error(`Failed to read the Stripe secret key: ${keyError.message}`);
  if (!secretKey) {
    throw new Error('The Stripe secret key is not set for this connection. Set it in Admin.');
  }

  return new Stripe(secretKey as string);
}

export async function getWebhookSecret(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_stripe_webhook_secret', {
    p_connection_id: connectionId,
  });
  if (error) throw new Error(`Failed to read the Stripe webhook secret: ${error.message}`);
  return (data as string | null) ?? null;
}
