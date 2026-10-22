'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/app/actions/users';
import { createBillcomClientForConnection } from '@/lib/billcom/connection';
import { resolveUserAccess } from '@/lib/auth/permissions';
import { createServiceClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BillcomConnection,
  BillcomConnectionInput,
  BillcomConnectionSummary,
  BillcomEnvironment,
  BillcomTestResult,
} from '@/types/billcom';

/**
 * Bill.com gateway hosts, keyed by environment.
 *
 * api_base_url — not `environment` — is what every request is actually built
 * against, so an unvalidated value silently defeats the sandbox/production
 * separation AND lets an admin point a connection at a host they control and
 * harvest the Vault-stored credentials via Test connection, since secrets are
 * write-only and never need to be re-entered. Validate server-side: a server
 * action takes untrusted input at runtime whatever its TypeScript signature says.
 */
const BILLCOM_API_BASE_URLS: Record<BillcomEnvironment, string> = {
  sandbox: 'https://gateway.stage.bill.com/connect',
  production: 'https://gateway.prod.bill.com/connect',
};

function requireValidApiBaseUrl(environment: BillcomEnvironment, apiBaseUrl: string): string {
  const expected = BILLCOM_API_BASE_URLS[environment];
  if (!expected) {
    throw new Error(`Unknown Bill.com environment: ${environment}`);
  }
  const normalized = apiBaseUrl.trim().replace(/\/+$/, '');
  if (normalized !== expected) {
    throw new Error(
      `The API base URL for the ${environment} environment must be ${expected}.`,
    );
  }
  return expected;
}

/**
 * Everything here configures a financial integration — admin only.
 *
 * Deliberately does NOT use requireActiveBusinessCentralScope: Bill.com must be
 * configurable whether or not a Business Central environment exists. The two
 * integrations are independent, and coupling them here would make Bill.com
 * setup fail on an org that has not configured BC.
 */
async function requireAdmin(): Promise<{ orgId: string }> {
  const user = await getCurrentUser();
  const access = resolveUserAccess(user);

  if (!user || !access.isAdmin) {
    throw new Error('You do not have permission to manage Bill.com connections');
  }
  if (!user.organization_id) {
    throw new Error('Your user account is not assigned to an organization');
  }

  return { orgId: user.organization_id };
}

// NOTE: no interface or `export type` declarations in this file. A 'use server'
// module may only export async functions. BillcomConnectionSummary and
// BillcomTestResult live in @/types/billcom for that reason — see 93094f8.

/**
 * Fail closed on a connection id that does not belong to the caller's org.
 *
 * The Vault RPCs and the Bill.com client factory are keyed by connection id,
 * and Supabase does not error when an org-scoped update or delete matches zero
 * rows — so without this check a foreign id silently reaches them and operates
 * on another organization's credentials.
 */
async function requireOwnedConnection(
  supabase: SupabaseClient,
  orgId: string,
  connectionId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('billcom_connections')
    .select('id')
    .eq('id', connectionId)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error(`Bill.com connection ${connectionId} was not found.`);
  }
}

export async function listBillcomConnections(): Promise<BillcomConnectionSummary[]> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('billcom_connections')
    .select(
      'id, display_name, environment, api_base_url, username, billcom_organization_id, is_enabled, is_default, dev_key_secret_id, password_secret_id',
    )
    .eq('organization_id', orgId)
    .order('display_name', { ascending: true });
  if (error) throw error;

  return ((data ?? []) as BillcomConnection[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    environment: row.environment,
    apiBaseUrl: row.api_base_url,
    username: row.username,
    billcomOrganizationId: row.billcom_organization_id,
    isEnabled: row.is_enabled,
    isDefault: row.is_default,
    hasCredentials: Boolean(row.dev_key_secret_id && row.password_secret_id),
  }));
}

export async function saveBillcomConnection(input: BillcomConnectionInput): Promise<string> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  if (input.id) {
    await requireOwnedConnection(supabase, orgId, input.id);
  }

  const apiBaseUrl = requireValidApiBaseUrl(input.environment, input.apiBaseUrl);

  const row = {
    organization_id: orgId,
    display_name: input.displayName,
    environment: input.environment,
    api_base_url: apiBaseUrl,
    username: input.username,
    billcom_organization_id: input.billcomOrganizationId,
    is_default: input.isDefault,
    updated_at: new Date().toISOString(),
  };

  // Clear any other default first — the partial unique index allows only one.
  if (input.isDefault) {
    const { error } = await supabase
      .from('billcom_connections')
      .update({ is_default: false })
      .eq('organization_id', orgId)
      .neq('id', input.id ?? '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
  }

  let connectionId = input.id;

  if (connectionId) {
    const { error } = await supabase
      .from('billcom_connections')
      .update(row)
      .eq('id', connectionId)
      .eq('organization_id', orgId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from('billcom_connections')
      .insert(row)
      .select('id')
      .single();
    if (error) throw error;
    connectionId = (data as { id: string }).id;
  }

  // Secrets are write-only: a blank field on edit leaves the stored value alone.
  if (input.devKey) {
    const { error } = await supabase.rpc('set_billcom_dev_key', {
      p_connection_id: connectionId,
      p_secret: input.devKey,
    });
    if (error) throw error;
  }
  if (input.password) {
    const { error } = await supabase.rpc('set_billcom_password', {
      p_connection_id: connectionId,
      p_secret: input.password,
    });
    if (error) throw error;
  }

  revalidatePath('/admin');
  return connectionId;
}

export async function setBillcomConnectionEnabled(
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  await requireOwnedConnection(supabase, orgId, connectionId);

  // Disabling drops the cached session so a re-enable starts clean.
  const payload = enabled
    ? { is_enabled: true, updated_at: new Date().toISOString() }
    : {
        is_enabled: false,
        session_id: null,
        session_last_used_at: null,
        updated_at: new Date().toISOString(),
      };

  const { error } = await supabase
    .from('billcom_connections')
    .update(payload)
    .eq('id', connectionId)
    .eq('organization_id', orgId);
  if (error) throw error;

  revalidatePath('/admin');
}

export async function deleteBillcomConnection(connectionId: string): Promise<void> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  await requireOwnedConnection(supabase, orgId, connectionId);

  // Drop the Vault secrets first, while the pointers on the row are still
  // readable. Deleting the row first would orphan them permanently.
  const { error: secretsError } = await supabase.rpc('delete_billcom_secrets', {
    p_connection_id: connectionId,
  });
  if (secretsError) throw secretsError;

  const { error } = await supabase
    .from('billcom_connections')
    .delete()
    .eq('id', connectionId)
    .eq('organization_id', orgId);
  if (error) throw error;

  revalidatePath('/admin');
}

export async function testBillcomConnection(connectionId: string): Promise<BillcomTestResult> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  await requireOwnedConnection(supabase, orgId, connectionId);

  try {
    const client = await createBillcomClientForConnection(connectionId, orgId);
    await client.login();
    return { ok: true, message: 'Connected to Bill.com and started a session.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error contacting Bill.com.',
    };
  }
}
