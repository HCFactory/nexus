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

const UNKNOWN_LIST = 'Unknown list';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Keys arrive from the client, so never trust them to be a real list (e.g. 'toString'). */
const isListKey = (key: unknown): key is ListKey =>
  typeof key === 'string' && Object.hasOwn(LIST_DEFINITIONS, key);

function definitionFor(key: ListKey): ListDefinition {
  if (!isListKey(key)) throw new Error(UNKNOWN_LIST);
  return LIST_DEFINITIONS[key];
}

function revalidateLists() {
  // 'layout' also refreshes every /customer-lists/[list] sub-page.
  revalidatePath('/customer-lists', 'layout');
}

async function buildDeps(scope: { orgId: string; bcConnectionId: string }): Promise<ServiceDeps> {
  const supabase = createServiceClient();
  const bc = await createBcClientForOrg(scope.orgId, scope.bcConnectionId);
  // Same company lookup as createReferenceTransportForOrg, reusing the one client.
  const company = await bc.getCompany(bc.config.companyId);
  const transport = createReferenceTransport(bc, company.name);
  return {
    supabase,
    transport,
    orgId: scope.orgId,
    connectionId: scope.bcConnectionId,
    now: () => new Date().toISOString(),
    // Usage is counted live from BC (customers API and the OData line/detail pages).
    countUsage: createUsageCounter(bc, transport),
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
  const def = definitionFor(key);
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
  // BC carries a renamed payment term, price group or tax area into customer templates.
  if (key === 'taxAreas') return ['taxAreaLines', 'customerTemplates'];
  if (key === 'taxJurisdictions') return ['taxAreaLines', 'taxDetails'];
  if (key === 'paymentTerms' || key === 'customerPriceGroups') return ['customerTemplates'];
  return [];
}

export async function saveReferenceEntry(
  key: ListKey,
  input: { id: string | null; original: Row | null; edited: Row },
): Promise<{ ok: true; entry: ReferenceEntry; warning?: string } | Fail> {
  try {
    if (!isListKey(key)) return { ok: false, error: UNKNOWN_LIST };
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
    const failedTitles: string[] = [];
    for (const follow of followUpLists(key, input)) {
      try {
        await syncList(deps, LIST_DEFINITIONS[follow]);
      } catch (e) {
        // The entry is already saved in BC and Nexus; do not report the save as failed.
        console.error(`[customer-lists] follow-up sync of ${follow} after saving ${key} failed:`, errorMessage(e));
        failedTitles.push(LIST_DEFINITIONS[follow].title);
      }
    }
    const warning =
      failedTitles.length === 0
        ? undefined
        : `Saved, but refreshing ${failedTitles.map((t) => t.toLowerCase()).join(' and ')} from Business Central failed. Press Sync on ${failedTitles.join(' and ')}.`;
    revalidateLists();
    return warning ? { ok: true, entry, warning } : { ok: true, entry };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function deleteReferenceEntry(key: ListKey, id: string): Promise<{ ok: true } | Fail> {
  try {
    if (!isListKey(key)) return { ok: false, error: UNKNOWN_LIST };
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

// Tax area lines have no list page of their own, so a tax areas sync also pulls
// them; otherwise a fresh environment shows every area with no jurisdictions.
function listsToSync(key: ListKey): ListKey[] {
  if (key === 'taxAreas') return ['taxAreas', 'taxAreaLines'];
  // Templates pick their number series from this read-only list.
  if (key === 'customerTemplates') return ['noSeries', 'customerTemplates'];
  return [key];
}

export async function syncReferenceList(
  key: ListKey,
): Promise<{ ok: true; inserted: number; updated: number; deleted: number } | Fail> {
  try {
    if (!isListKey(key)) return { ok: false, error: UNKNOWN_LIST };
    const scope = await requireActiveBusinessCentralScope();
    if (!scope.access.isAdmin) return { ok: false, error: ADMIN_ONLY };

    const deps = await buildDeps(scope);
    const result = { inserted: 0, updated: 0, deleted: 0 };
    for (const list of listsToSync(key)) {
      const r = await syncList(deps, LIST_DEFINITIONS[list]);
      result.inserted += r.inserted;
      result.updated += r.updated;
      result.deleted += r.deleted;
    }
    revalidateLists();
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function getSelectOptions(source: ListKey | 'taxGroups'): Promise<{ code: string; label: string }[]> {
  const isTaxGroups = source === 'taxGroups';
  const def = isTaxGroups ? null : definitionFor(source);
  const scope = await requireActiveBusinessCentralScope();
  const supabase = await createClient();
  const table = def ? def.table : 'business_central_tax_groups';
  const hasDisplayName = !def || def.fields.some((f) => f.name === 'display_name');

  let query = supabase
    .from(table)
    .select(hasDisplayName ? 'code, display_name' : 'code')
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId);
  // business_central_tax_groups has is_active (migration 017); retired groups are not offered.
  if (isTaxGroups) query = query.eq('is_active', true);
  const { data, error } = await query.order('code', { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as Row[]).map((r) => {
    const code = String(r.code);
    const name = r.display_name ? String(r.display_name) : '';
    return { code, label: name ? `${code} — ${name}` : code };
  });
}
