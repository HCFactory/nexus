'use server';

import { revalidatePath } from 'next/cache';
import { createBcClientForOrg } from '@/lib/businessCentral/client';
import { createReferenceTransport } from '@/lib/businessCentral/customerReferences/transport';
import { CUSTOMER_FIELDS } from '@/lib/businessCentral/customers/customerFields';
import {
  createCustomer,
  deleteCustomer,
  updateCustomer,
  type CustomerServiceDeps,
} from '@/lib/businessCentral/customers/customerService';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { createNoSeriesClient } from '@/lib/businessCentral/noSeriesClient';
import { createBcNoSeriesAssigner } from '@/lib/businessCentral/numberAssigner';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { ListKey } from '@/types/customerReferences';
import { getSelectOptions } from './customerReferenceLists';

type Fail = { ok: false; error: string };
type Row = Record<string, unknown>;
type Option = { code: string; label: string };
type Scope = Awaited<ReturnType<typeof requireActiveBusinessCentralScope>>;

export interface CustomerTemplateOption {
  code: string;
  label: string;
  /** Values the create form pre-fills (editable). */
  values: { payment_terms_code: unknown; tax_area_code: unknown };
}

export interface CustomerEditContext {
  canEdit: boolean;
  templates: CustomerTemplateOption[];
  selectOptions: Record<string, Option[]>;
}

const NO_PERMISSION = "You don't have permission to change customers";

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function revalidateCustomers() {
  // 'layout' also refreshes every /customers/[id] page.
  revalidatePath('/customers', 'layout');
}

async function editScope(): Promise<Scope | null> {
  const scope = await requireActiveBusinessCentralScope();
  return scope.access.canEditCustomers ? scope : null;
}

async function buildDeps(scope: Scope): Promise<CustomerServiceDeps> {
  const bc = await createBcClientForOrg(scope.orgId, scope.bcConnectionId);
  const company = await bc.getCompany(bc.config.companyId);
  const timeZone = (scope.connection as { time_zone?: string | null } | null)?.time_zone;
  return {
    supabase: createServiceClient(),
    transport: createReferenceTransport(bc, company.name),
    assigner: createBcNoSeriesAssigner(createNoSeriesClient(bc, company.name)),
    bc,
    orgId: scope.orgId,
    connectionId: scope.bcConnectionId,
    environment: bc.config.environment,
    companyId: bc.config.companyId,
    now: () => new Date().toISOString(),
    today: timeZone ? new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date()) : undefined,
  };
}

/** Templates and dropdown choices for the customer form; empty when the user cannot edit. */
export async function getCustomerEditContext(): Promise<CustomerEditContext> {
  const empty: CustomerEditContext = { canEdit: false, templates: [], selectOptions: {} };
  let scope: Scope | null;
  try {
    scope = await editScope();
  } catch {
    return empty; // no Business Central environment selected
  }
  if (!scope) return empty;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('business_central_customer_templates')
    .select('code, display_name, payment_terms_code, tax_area_code')
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .order('code', { ascending: true });
  if (error) throw new Error(error.message);

  const templates = ((data ?? []) as Row[]).map((r) => {
    const code = String(r.code);
    return {
      code,
      label: r.display_name ? `${code} — ${String(r.display_name)}` : code,
      values: { payment_terms_code: r.payment_terms_code ?? null, tax_area_code: r.tax_area_code ?? null },
    };
  });

  const sources = [...new Set(CUSTOMER_FIELDS.flatMap((f) => (f.optionsFrom ? [f.optionsFrom] : [])))];
  const lists = await Promise.all(sources.map((s) => getSelectOptions(s as ListKey | 'taxGroups')));
  const selectOptions = Object.fromEntries(sources.map((s, i) => [s, lists[i]]));

  return { canEdit: true, templates, selectOptions };
}

export async function createCustomerAction(input: {
  templateCode: string;
  values: Row;
}): Promise<{ ok: true; id: string; number: string; warning?: string } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const result = await createCustomer(await buildDeps(scope), { templateCode: input.templateCode, values: input.values });
    revalidateCustomers();
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function updateCustomerAction(input: {
  id: string;
  original: Row;
  edited: Row;
}): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    await updateCustomer(await buildDeps(scope), { id: input.id, original: input.original, edited: input.edited });
    revalidateCustomers();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function deleteCustomerAction(id: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    await deleteCustomer(await buildDeps(scope), id);
    revalidateCustomers();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}
