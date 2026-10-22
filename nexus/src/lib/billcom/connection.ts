import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createServiceClient } from '@/lib/supabase/server';
import type { BillcomConnection } from '@/types/billcom';
import { createBillcomClient, type BillcomClient } from './client';
import { BillcomConnectionDisabledError } from './errors';
import { createDbSessionStore } from './sessionStore';

export interface CreateBillcomClientOptions {
  supabase?: SupabaseClient;
  fetchImpl?: typeof fetch;
}

export async function loadBillcomConnection(
  supabase: SupabaseClient,
  connectionId: string,
  organizationId: string,
): Promise<BillcomConnection> {
  const { data, error } = await supabase
    .from('billcom_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load the Bill.com connection: ${error.message}`);
  }
  if (!data) {
    // Same message for "does not exist" and "belongs to another org" — a
    // distinct message would let a caller probe which ids exist elsewhere.
    throw new Error(`Bill.com connection ${connectionId} was not found.`);
  }
  return data as BillcomConnection;
}

export async function createBillcomClientForConnection(
  connectionId: string,
  organizationId: string,
  options: CreateBillcomClientOptions = {},
): Promise<BillcomClient> {
  const supabase = options.supabase ?? createServiceClient();
  const connection = await loadBillcomConnection(supabase, connectionId, organizationId);

  // Check the toggle before decrypting anything — a disabled connection must
  // make no network call and needs no credentials present.
  if (!connection.is_enabled) {
    throw new BillcomConnectionDisabledError(connectionId);
  }

  const { data: devKey, error: devKeyError } = await supabase.rpc('get_billcom_dev_key', {
    p_connection_id: connectionId,
  });
  if (devKeyError) {
    throw new Error(`Failed to read the Bill.com developer key: ${devKeyError.message}`);
  }

  const { data: password, error: passwordError } = await supabase.rpc('get_billcom_password', {
    p_connection_id: connectionId,
  });
  if (passwordError) {
    throw new Error(`Failed to read the Bill.com password: ${passwordError.message}`);
  }

  if (!devKey || !password) {
    throw new Error(
      'Bill.com credentials are not fully configured for this connection. Set the developer key and password in Admin.',
    );
  }

  return createBillcomClient({
    apiBaseUrl: connection.api_base_url,
    devKey: devKey as string,
    username: connection.username,
    password: password as string,
    billcomOrganizationId: connection.billcom_organization_id,
    sessionStore: createDbSessionStore(supabase, connectionId),
    fetchImpl: options.fetchImpl,
  });
}
