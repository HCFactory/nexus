export type BillcomEnvironment = 'sandbox' | 'production';

export interface BillcomConnection {
  id: string;
  organization_id: string;
  display_name: string;
  environment: BillcomEnvironment;
  api_base_url: string;
  username: string;
  billcom_organization_id: string;
  dev_key_secret_id: string | null;
  password_secret_id: string | null;
  is_enabled: boolean;
  is_default: boolean;
  session_id: string | null;
  session_last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the admin form submits. Secrets are write-only and optional on edit. */
export interface BillcomConnectionInput {
  id?: string;
  displayName: string;
  environment: BillcomEnvironment;
  apiBaseUrl: string;
  username: string;
  billcomOrganizationId: string;
  devKey?: string;
  password?: string;
  isDefault: boolean;
}

/**
 * Safe projection returned to the client: no Vault pointers, no session id.
 *
 * Lives here rather than in the 'use server' actions module. A 'use server'
 * module may only export async functions — Turbopack's dev transform sweeps
 * even `export type` into the server-actions manifest and fails the dev build,
 * while tsc/build/test all still pass. See commit 93094f8.
 */
export interface BillcomConnectionSummary {
  id: string;
  displayName: string;
  environment: BillcomEnvironment;
  apiBaseUrl: string;
  username: string;
  billcomOrganizationId: string;
  isEnabled: boolean;
  isDefault: boolean;
  hasCredentials: boolean;
}

export interface BillcomTestResult {
  ok: boolean;
  message: string;
}
