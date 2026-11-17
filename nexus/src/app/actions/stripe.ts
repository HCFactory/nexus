'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/app/actions/users';
import { resolveUserAccess } from '@/lib/auth/permissions';
import { createStripeForConnection } from '@/lib/stripe/connection';
import { createServiceClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  StripeConnection,
  StripeConnectionInput,
  StripeConnectionSummary,
  StripeTestResult,
} from '@/types/stripe';

// NOTE: no interface or `export type` declarations in this file. A 'use server'
// module may only export async functions; types live in @/types/stripe.

/** Everything here configures a financial integration — admin only. */
async function requireAdmin(): Promise<{ orgId: string }> {
  const user = await getCurrentUser();
  const access = resolveUserAccess(user);

  if (!user || !access.isAdmin) {
    throw new Error('You do not have permission to manage Stripe connections');
  }
  if (!user.organization_id) {
    throw new Error('Your user account is not assigned to an organization');
  }
  return { orgId: user.organization_id };
}

/** Fail closed on a connection id outside the caller's org (see billcom.ts). */
async function requireOwnedConnection(
  supabase: SupabaseClient,
  orgId: string,
  connectionId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('stripe_connections')
    .select('id')
    .eq('id', connectionId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`Stripe connection ${connectionId} was not found.`);
  }
}

export async function listStripeConnections(): Promise<StripeConnectionSummary[]> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('stripe_connections')
    .select(
      'id, display_name, is_enabled, is_default, livemode, stripe_account_id, secret_key_secret_id, webhook_secret_secret_id',
    )
    .eq('organization_id', orgId)
    .order('display_name', { ascending: true });
  if (error) throw error;

  // Vault pointers are reduced to booleans; they never leave the server.
  return ((data ?? []) as StripeConnection[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    isEnabled: row.is_enabled,
    isDefault: row.is_default,
    livemode: row.livemode,
    stripeAccountId: row.stripe_account_id,
    hasCredentials: Boolean(row.secret_key_secret_id),
    hasWebhookSecret: Boolean(row.webhook_secret_secret_id),
  }));
}

export async function saveStripeConnection(input: StripeConnectionInput): Promise<string> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  // Validate untrusted input before any write. Never echo the value back.
  const secretKey = input.secretKey?.trim() || undefined;
  const webhookSecret = input.webhookSecret?.trim() || undefined;
  if (secretKey && !/^sk_(test|live)_/.test(secretKey)) {
    throw new Error('The secret key must start with sk_test_ or sk_live_.');
  }
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) {
    throw new Error('The webhook signing secret must start with whsec_.');
  }
  const displayName = input.displayName.trim();
  if (!displayName) throw new Error('Display name is required.');

  if (input.id) {
    await requireOwnedConnection(supabase, orgId, input.id);
  }

  const row = {
    organization_id: orgId,
    display_name: displayName,
    updated_at: new Date().toISOString(),
  };

  let connectionId = input.id;
  if (connectionId) {
    const { error } = await supabase
      .from('stripe_connections')
      .update(row)
      .eq('id', connectionId)
      .eq('organization_id', orgId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from('stripe_connections')
      .insert({ ...row, is_default: false })
      .select('id')
      .single();
    if (error) throw error;
    connectionId = (data as { id: string }).id;
  }

  // Secrets are write-only: blank leaves the stored value alone.
  if (secretKey) {
    const { error } = await supabase.rpc('set_stripe_secret_key', {
      p_connection_id: connectionId,
      p_secret: secretKey,
    });
    if (error) throw error;
  }
  if (webhookSecret) {
    const { error } = await supabase.rpc('set_stripe_webhook_secret', {
      p_connection_id: connectionId,
      p_secret: webhookSecret,
    });
    if (error) throw error;
  }

  if (input.isDefault) {
    // One default per org (partial unique index): clear the others, then set this.
    const { error: clearError } = await supabase
      .from('stripe_connections')
      .update({ is_default: false })
      .eq('organization_id', orgId)
      .neq('id', connectionId);
    if (clearError) throw clearError;
    const { error: setError } = await supabase
      .from('stripe_connections')
      .update({ is_default: true })
      .eq('id', connectionId)
      .eq('organization_id', orgId);
    if (setError) throw setError;
  } else if (input.id) {
    const { error } = await supabase
      .from('stripe_connections')
      .update({ is_default: false })
      .eq('id', connectionId)
      .eq('organization_id', orgId);
    if (error) throw error;
  }

  revalidatePath('/admin');
  return connectionId;
}

export async function setStripeConnectionEnabled(
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();
  await requireOwnedConnection(supabase, orgId, connectionId);

  const { error } = await supabase
    .from('stripe_connections')
    .update({ is_enabled: enabled, updated_at: new Date().toISOString() })
    .eq('id', connectionId)
    .eq('organization_id', orgId);
  if (error) throw error;

  revalidatePath('/admin');
}

export async function deleteStripeConnection(connectionId: string): Promise<void> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();
  await requireOwnedConnection(supabase, orgId, connectionId);

  // Vault entries first, while the pointers are still readable.
  const { error: vaultError } = await supabase.rpc('delete_stripe_secrets', {
    p_connection_id: connectionId,
  });
  if (vaultError) throw vaultError;

  const { error } = await supabase
    .from('stripe_connections')
    .delete()
    .eq('id', connectionId)
    .eq('organization_id', orgId);
  if (error) throw error;

  revalidatePath('/admin');
}

export async function testStripeConnection(connectionId: string): Promise<StripeTestResult> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();
  await requireOwnedConnection(supabase, orgId, connectionId);

  try {
    const stripe = await createStripeForConnection(supabase, orgId, connectionId);
    // Account objects carry no livemode flag in this SDK version, but the
    // balance does, and it reflects the mode of the key being used.
    const account = await stripe.accounts.retrieve(null);
    const balance = await stripe.balance.retrieve();

    const { error } = await supabase
      .from('stripe_connections')
      .update({
        livemode: balance.livemode,
        stripe_account_id: account.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', connectionId)
      .eq('organization_id', orgId);
    if (error) throw error;

    revalidatePath('/admin');
    const livemode = balance.livemode;
    return {
      ok: true,
      message: `Connected to Stripe account ${account.id} (${livemode ? 'live' : 'test'} mode).`,
      livemode,
      stripeAccountId: account.id,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error contacting Stripe.',
    };
  }
}
