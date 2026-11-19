'use server';

import { revalidatePath } from 'next/cache';

import { requireOrganizationContext, requirePermission } from '@/lib/auth/currentUserAccess';
import { ResolvedUserAccess } from '@/lib/auth/permissions';
import { createBcClientForOrg, DEFAULT_BC_API_BASE_URL } from '@/lib/businessCentral/client';
import { createServiceClient } from '@/lib/supabase/server';
import { BusinessCentralConnection } from '@/types/database';

export interface BcCredentialsData {
  tenantId: string;
  clientId: string;
  defaultApiBaseUrl: string | null;
  /**
   * The BC company is shared across an org's environments — one app
   * registration, one company. It lives on the credentials row.
   */
  companyId: string | null;
  companyName: string | null;
  hasSecret: boolean;
}

export interface UpsertBcCredentialsInput {
  tenantId: string;
  clientId: string;
  /** Shared BC company GUID; required for every environment to connect. */
  companyId: string;
  /**
   * Blank/empty keeps the existing Vault secret untouched; a non-blank value
   * stores or rotates the secret. The secret is never returned to the browser.
   */
  clientSecret?: string | null;
  defaultApiBaseUrl?: string | null;
}

export interface CreateBcConnectionInput {
  displayName: string;
  environment: string;
  apiBaseUrl?: string | null;
  timeZone?: string | null;
}

export interface UpdateBcConnectionInput {
  displayName?: string;
  environment?: string;
  apiBaseUrl?: string | null;
  timeZone?: string | null;
  billcomViaConnector?: boolean;
  /** Sync this environment on the schedule (Supabase pg_cron). */
  autoSync?: boolean;
  /** The Bill.com connection this environment uses; null = none (Bill.com off here). */
  billcomConnectionId?: string | null;
  /** The Stripe connection this environment uses; null = none (Stripe off here). */
  stripeConnectionId?: string | null;
}

function canManageBusinessCentralConnection(access: ResolvedUserAccess): boolean {
  return access.isAdmin;
}

async function requireBcConnectionManage() {
  return requirePermission(
    canManageBusinessCentralConnection,
    'You do not have permission to manage Business Central connections'
  );
}

/**
 * Validates and normalises an IANA time zone input.
 * Returns the trimmed zone string, or null when the value is blank/null.
 * Throws when the value is non-empty but not a valid IANA zone name.
 */
function validateTimeZone(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: trimmed });
  } catch {
    throw new Error(`Invalid time zone: '${trimmed}'. Use an IANA time zone name, e.g. 'Pacific/Honolulu'.`);
  }
  return trimmed;
}

/**
 * Returns the org's shared BC credential identifiers plus a `hasSecret` flag.
 * The client secret itself is never read or returned here.
 */
export async function getBcCredentials(): Promise<BcCredentialsData | null> {
  const { orgId } = await requireOrganizationContext();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('business_central_credentials')
    .select('tenant_id, client_id, default_api_base_url, company_id, company_name, client_secret_id')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  return {
    tenantId: data.tenant_id,
    clientId: data.client_id,
    defaultApiBaseUrl: data.default_api_base_url,
    companyId: data.company_id,
    companyName: data.company_name,
    hasSecret: data.client_secret_id !== null,
  };
}

/**
 * Upserts the org's shared BC credentials. The client secret is handled
 * separately via Supabase Vault: a blank/empty input leaves the existing
 * secret untouched, a non-blank input stores or rotates it.
 */
export async function upsertBcCredentials(input: UpsertBcCredentialsInput): Promise<void> {
  const { orgId } = await requireBcConnectionManage();
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const tenantId = input.tenantId.trim();
  const clientId = input.clientId.trim();
  const companyId = input.companyId.trim();
  if (!tenantId || !clientId) {
    throw new Error('Tenant ID and Client ID are required');
  }
  if (!companyId) {
    throw new Error('Company ID is required');
  }
  const defaultApiBaseUrl = input.defaultApiBaseUrl?.trim() || null;

  // The credentials row must exist before set_bc_client_secret runs, because
  // the RPC writes the Vault pointer back onto this row.
  const { error } = await supabase
    .from('business_central_credentials')
    .upsert(
      {
        organization_id: orgId,
        tenant_id: tenantId,
        client_id: clientId,
        company_id: companyId,
        default_api_base_url: defaultApiBaseUrl,
        updated_at: now,
      },
      { onConflict: 'organization_id' }
    );
  if (error) throw error;

  // Keep the denormalized mirror in sync: every environment connection for
  // this org carries the shared company_id so the existing sync code path
  // (businessCentralItems.ts / client.ts) needs no changes.
  const { error: mirrorError } = await supabase
    .from('business_central_connections')
    .update({ company_id: companyId, updated_at: now })
    .eq('organization_id', orgId);
  if (mirrorError) throw mirrorError;

  // Blank secret = keep the existing Vault entry; never call the RPC with a
  // falsy value (that would be treated as a rotation to an empty secret).
  const secret = input.clientSecret;
  if (secret != null && secret.trim() !== '') {
    const { error: secretError } = await supabase.rpc('set_bc_client_secret', {
      p_org_id: orgId,
      p_secret: secret,
    });
    if (secretError) throw secretError;
  }

  revalidatePath('/settings');
}

/** Lists every BC environment connection for the org, default first. */
export async function listBcConnections(): Promise<BusinessCentralConnection[]> {
  const { orgId } = await requireOrganizationContext();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('business_central_connections')
    .select('*')
    .eq('organization_id', orgId)
    .order('is_default', { ascending: false })
    .order('display_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as BusinessCentralConnection[];
}

/** Creates a new BC environment connection for the org. */
export async function createBcConnection(
  input: CreateBcConnectionInput
): Promise<BusinessCentralConnection> {
  const { orgId } = await requireBcConnectionManage();
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const displayName = input.displayName.trim();
  const environment = input.environment.trim();
  if (!displayName || !environment) {
    throw new Error('Display name and environment are required');
  }
  const timeZone = validateTimeZone(input.timeZone);

  // The BC company is shared per org and lives on the credentials row.
  // Every environment connection mirrors that company_id.
  const { data: credentials, error: credentialsError } = await supabase
    .from('business_central_credentials')
    .select('company_id')
    .eq('organization_id', orgId)
    .maybeSingle();
  if (credentialsError) throw credentialsError;
  const companyId = credentials?.company_id?.trim();
  if (!companyId) {
    throw new Error(
      'Configure Business Central credentials (including Company ID) before adding an environment.'
    );
  }

  // The first connection for an org becomes its default.
  const { count, error: countError } = await supabase
    .from('business_central_connections')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId);
  if (countError) throw countError;
  const isDefault = (count ?? 0) === 0;

  const { data, error } = await supabase
    .from('business_central_connections')
    .insert({
      organization_id: orgId,
      display_name: displayName,
      environment,
      company_id: companyId,
      api_base_url: input.apiBaseUrl?.trim() || DEFAULT_BC_API_BASE_URL,
      time_zone: timeZone,
      is_default: isDefault,
      sync_enabled: false,
      created_at: now,
      updated_at: now,
    })
    .select('*')
    .single();
  if (error) throw error;

  revalidatePath('/settings');
  revalidatePath('/items');
  return data as BusinessCentralConnection;
}

/** The id if it is a connection of this org; null clears the pick. Throws for anything else. */
async function connectionInOrg(
  supabase: ReturnType<typeof createServiceClient>,
  table: 'billcom_connections' | 'stripe_connections',
  id: string | null,
  orgId: string,
  label: string,
): Promise<string | null> {
  if (!id) return null;
  const { data, error } = await supabase.from(table).select('id').eq('id', id).eq('organization_id', orgId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`${label} connection not found`);
  return id;
}

/** Edits an existing BC environment connection. */
export async function updateBcConnection(
  id: string,
  input: UpdateBcConnectionInput
): Promise<BusinessCentralConnection> {
  const { orgId } = await requireBcConnectionManage();
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const updates: Record<string, unknown> = { updated_at: now };
  if (input.displayName !== undefined) {
    const value = input.displayName.trim();
    if (!value) throw new Error('Display name cannot be empty');
    updates.display_name = value;
  }
  if (input.environment !== undefined) {
    const value = input.environment.trim();
    if (!value) throw new Error('Environment cannot be empty');
    updates.environment = value;
  }
  if (input.apiBaseUrl !== undefined) {
    updates.api_base_url = input.apiBaseUrl?.trim() || DEFAULT_BC_API_BASE_URL;
  }
  if (input.timeZone !== undefined) {
    updates.time_zone = validateTimeZone(input.timeZone);
  }
  if (input.autoSync !== undefined) {
    updates.auto_sync = input.autoSync === true;
  }
  if (input.billcomViaConnector !== undefined) {
    updates.billcom_via_connector = input.billcomViaConnector === true;
  }
  if (input.billcomConnectionId !== undefined) {
    updates.billcom_connection_id = await connectionInOrg(supabase, 'billcom_connections', input.billcomConnectionId, orgId, 'Bill.com');
  }
  if (input.stripeConnectionId !== undefined) {
    updates.stripe_connection_id = await connectionInOrg(supabase, 'stripe_connections', input.stripeConnectionId, orgId, 'Stripe');
  }

  const { data, error } = await supabase
    .from('business_central_connections')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('*')
    .single();
  if (error) throw error;

  revalidatePath('/settings');
  revalidatePath('/items');
  return data as BusinessCentralConnection;
}

/**
 * Deletes a BC environment connection. Blocked when it is the org's only
 * environment. Items referencing it are orphaned (FK `ON DELETE SET NULL`).
 */
export async function deleteBcConnection(id: string): Promise<void> {
  const { orgId } = await requireBcConnectionManage();
  const supabase = createServiceClient();

  const { data: connections, error: listError } = await supabase
    .from('business_central_connections')
    .select('id, is_default')
    .eq('organization_id', orgId);
  if (listError) throw listError;

  if ((connections ?? []).length <= 1) {
    throw new Error('Cannot delete the only Business Central environment');
  }
  const target = (connections ?? []).find((row) => row.id === id);
  if (!target) {
    throw new Error('Business Central environment not found');
  }

  const { error } = await supabase
    .from('business_central_connections')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId);
  if (error) throw error;

  // Promote another connection to default if the deleted one was the default.
  if (target.is_default) {
    const next = (connections ?? []).find((row) => row.id !== id);
    if (next) {
      const { error: promoteError } = await supabase
        .from('business_central_connections')
        .update({ is_default: true, updated_at: new Date().toISOString() })
        .eq('id', next.id)
        .eq('organization_id', orgId);
      if (promoteError) throw promoteError;
    }
  }

  revalidatePath('/settings');
  revalidatePath('/items');
}

/** Marks a connection as the org's default environment. */
export async function setDefaultBcConnection(id: string): Promise<void> {
  const { orgId } = await requireBcConnectionManage();
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { data: target, error: targetError } = await supabase
    .from('business_central_connections')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) throw new Error('Business Central environment not found');

  // Clear the current default first to respect the one-default-per-org
  // partial unique index (idx_bc_connections_one_default_per_org).
  const { error: clearError } = await supabase
    .from('business_central_connections')
    .update({ is_default: false, updated_at: now })
    .eq('organization_id', orgId)
    .eq('is_default', true);
  if (clearError) throw clearError;

  const { error } = await supabase
    .from('business_central_connections')
    .update({ is_default: true, updated_at: now })
    .eq('id', id)
    .eq('organization_id', orgId);
  if (error) throw error;

  revalidatePath('/settings');
  revalidatePath('/items');
}

/**
 * Switches the acting user's active BC environment. Any authenticated user may
 * switch their own environment — this is NOT admin-gated. Mirrors
 * `switchOrganization()`: validates the target belongs to the user's current
 * org, writes the per-user pointer, and revalidates the affected paths.
 */
export async function switchBcEnvironment(connectionId: string): Promise<void> {
  const { user, orgId } = await requireOrganizationContext();
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { data: connection, error: connectionError } = await supabase
    .from('business_central_connections')
    .select('id')
    .eq('id', connectionId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection) {
    throw new Error('Business Central environment not found for this organization');
  }

  const { error } = await supabase
    .from('users')
    .update({ active_bc_connection_id: connectionId, updated_at: now })
    .eq('id', user.id);
  if (error) throw new Error('Failed to switch Business Central environment');

  revalidatePath('/items');
  revalidatePath('/', 'layout');
}

/**
 * Verifies a single BC environment connection by hitting the BC API, then
 * records the outcome on that connection's row only.
 */
export async function verifyBcConnection(id: string): Promise<BusinessCentralConnection> {
  const { orgId } = await requireBcConnectionManage();
  const supabase = createServiceClient();
  const now = new Date().toISOString();

  const { data: connection, error: connectionError } = await supabase
    .from('business_central_connections')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection) throw new Error('Business Central environment not found');

  try {
    const client = await createBcClientForOrg(orgId, id);
    const company = await client.getCompany();
    const { data: updated, error: updateError } = await supabase
      .from('business_central_connections')
      .update({
        company_name: company.displayName || company.name,
        sync_enabled: true,
        last_verified_at: now,
        last_error: null,
        updated_at: now,
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .single();
    if (updateError) throw updateError;

    revalidatePath('/settings');
    revalidatePath('/items');
    return updated as BusinessCentralConnection;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Business Central connection verification failed';
    await supabase
      .from('business_central_connections')
      .update({ sync_enabled: false, last_error: message, updated_at: now })
      .eq('id', id)
      .eq('organization_id', orgId);
    revalidatePath('/settings');
    throw error;
  }
}
