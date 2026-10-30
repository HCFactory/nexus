'use server';

import { revalidatePath } from 'next/cache';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import { createBcClientForOrg } from '@/lib/businessCentral/client';
import { LIST_DEFINITIONS } from '@/lib/businessCentral/customerReferences/definitions';
import type { ListDefinition } from '@/lib/businessCentral/customerReferences/listDefinition';
import {
  deleteEntry,
  saveEntry,
  syncList,
  type ServiceDeps,
} from '@/lib/businessCentral/customerReferences/service';
import { createReferenceTransport } from '@/lib/businessCentral/customerReferences/transport';
import { createUsageCounter } from '@/lib/businessCentral/customerReferences/usage';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { ListKey, ListPageData, ReferenceEntry } from '@/types/customerReferences';

type Fail = { ok: false; error: string };
type Row = Record<string, unknown>;

const ADMIN_ONLY = 'Only admins can change customer reference lists';
const READ_ONLY = 'This list is managed in Business Central';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function revalidateLists() {
  // 'layout' also refreshes every /customer-lists/[list] sub-page.
  revalidatePath('/customer-lists', 'layout');
}

async function buildDeps(scope: { orgId: string; bcConnectionId: string }): Promise<ServiceDeps> {
  const supabase = createServiceClient();
  const bc = await createBcClientForOrg(scope.orgId, scope.bcConnectionId);
  // Same company lookup as createReferenceTransportForOrg, reusing the one client.
  const company = await bc.getCompany(bc.config.companyId);
  return {
    supabase,
    transport: createReferenceTransport(bc, company.name),
    orgId: scope.orgId,
    connectionId: scope.bcConnectionId,
    now: () => new Date().toISOString(),
    countUsage: createUsageCounter(bc, supabase, scope.orgId, scope.bcConnectionId),
  };
}

function keepEditable(def: ListDefinition, values: Row | null): Row | null {
  if (values === null) return null;
  const out: Row = {};
  for (const f of def.fields) {
    if (f.editable && f.name in values) out[f.name] = values[f.name];
  }
  return out;
}

export async function getReferenceListPage(
  key: ListKey,
  filter?: { parentCode?: string; jurisdictionCode?: string },
): Promise<ListPageData> {
  const def = LIST_DEFINITIONS[key];
  const scope = await requireActiveBusinessCentralScope();
  const supabase = await createClient();

  let query = supabase
    .from(def.table)
    .select('*')
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId);
  if (filter?.parentCode && def.parent) query = query.eq(def.parent.field, filter.parentCode);
  // jurisdictionCode only applies to taxDetails.
  if (filter?.jurisdictionCode && key === 'taxDetails') {
    query = query.eq('tax_jurisdiction_code', filter.jurisdictionCode);
  }
  for (const f of def.fields.filter((x) => x.isKey)) query = query.order(f.name, { ascending: true });

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const entries: ReferenceEntry[] = ((data ?? []) as Row[]).map((row) => {
    const values: Row = {};
    for (const f of def.fields) values[f.name] = row[f.name] ?? null;
    return {
      id: String(row.id),
      values,
      bcLastModifiedAt: (row.bc_last_modified_at as string | null) ?? null,
      lastSyncedAt: (row.last_synced_at as string | null) ?? null,
    };
  });

  return {
    key,
    title: def.title,
    mode: def.mode,
    fields: def.fields,
    entries,
    canManage: scope.access.isAdmin,
    deleteDisabledReason: def.deleteDisabledReason ?? null,
  };
}

// BC inserts tax detail rows when a jurisdiction/detail is created, and carries a renamed
// tax area or jurisdiction code into its lines and details.
function followUpLists(key: ListKey, input: { id: string | null; original: Row | null; edited: Row }): ListKey[] {
  if (input.id === null) {
    return key === 'taxJurisdictions' || key === 'taxDetails' ? ['taxDetails'] : [];
  }
  const renamed = 'code' in input.edited && input.original !== null && input.edited.code !== input.original.code;
  if (!renamed) return [];
  if (key === 'taxAreas') return ['taxAreaLines'];
  if (key === 'taxJurisdictions') return ['taxAreaLines', 'taxDetails'];
  return [];
}

export async function saveReferenceEntry(
  key: ListKey,
  input: { id: string | null; original: Row | null; edited: Row },
): Promise<{ ok: true; entry: ReferenceEntry; warning?: string } | Fail> {
  try {
    const def = LIST_DEFINITIONS[key];
    const scope = await requireActiveBusinessCentralScope();
    if (!scope.access.isAdmin) return { ok: false, error: ADMIN_ONLY };
    if (def.mode === 'readOnly') return { ok: false, error: READ_ONLY };

    const deps = await buildDeps(scope);
    const entry = await saveEntry(deps, def, {
      id: input.id,
      original: keepEditable(def, input.original),
      edited: keepEditable(def, input.edited) ?? {},
    });

    // BC changes dependent rows on its own; re-pull them so Nexus matches.
    let warning: string | undefined;
    for (const follow of followUpLists(key, input)) {
      try {
        await syncList(deps, LIST_DEFINITIONS[follow]);
      } catch {
        // The entry is already saved in BC and Nexus; do not report the save as failed.
        const title = LIST_DEFINITIONS[follow].title;
        warning = `Saved, but refreshing ${title.toLowerCase()} from Business Central failed. Press Sync on ${title}.`;
      }
    }
    revalidateLists();
    return warning ? { ok: true, entry, warning } : { ok: true, entry };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function deleteReferenceEntry(key: ListKey, id: string): Promise<{ ok: true } | Fail> {
  try {
    const def = LIST_DEFINITIONS[key];
    const scope = await requireActiveBusinessCentralScope();
    if (!scope.access.isAdmin) return { ok: false, error: ADMIN_ONLY };
    if (def.mode === 'readOnly') return { ok: false, error: READ_ONLY };
    if (def.deleteDisabledReason) return { ok: false, error: def.deleteDisabledReason };

    await deleteEntry(await buildDeps(scope), def, id);
    revalidateLists();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function syncReferenceList(
  key: ListKey,
): Promise<{ ok: true; inserted: number; updated: number; deleted: number } | Fail> {
  try {
    const def = LIST_DEFINITIONS[key];
    const scope = await requireActiveBusinessCentralScope();
    if (!scope.access.isAdmin) return { ok: false, error: ADMIN_ONLY };

    const result = await syncList(await buildDeps(scope), def);
    revalidateLists();
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function getSelectOptions(source: ListKey | 'taxGroups'): Promise<{ code: string; label: string }[]> {
  const scope = await requireActiveBusinessCentralScope();
  const supabase = await createClient();
  const table = source === 'taxGroups' ? 'business_central_tax_groups' : LIST_DEFINITIONS[source].table;
  const hasDisplayName = source === 'taxGroups' || LIST_DEFINITIONS[source].fields.some((f) => f.name === 'display_name');

  const { data, error } = await supabase
    .from(table)
    .select(hasDisplayName ? 'code, display_name' : 'code')
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .order('code', { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as Row[]).map((r) => {
    const code = String(r.code);
    const name = r.display_name ? String(r.display_name) : '';
    return { code, label: name ? `${code} — ${name}` : code };
  });
}
