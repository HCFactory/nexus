import type { ListKey } from '@/types/customerReferences';

import { LIST_DEFINITIONS } from './definitions';
import type { ListDefinition } from './listDefinition';
import type { ServiceDeps } from './service';

/** Every Customer list, in the order they depend on each other (templates last). */
export const ALL_LISTS_ORDER: ListKey[] = [
  'paymentTerms',
  'customerPriceGroups',
  'taxAreas',
  'taxAreaLines',
  'taxJurisdictions',
  'taxDetails',
  'locations',
  'customerPostingGroups',
  'generalBusinessPostingGroups',
  'shipmentMethods',
  'noSeries',
  'customerTemplates',
];

export interface ListSyncResult {
  entityType: string;
  recordsSynced: number;
  complete: boolean;
  cursor: null;
  error: string | null;
}

/** Admin → Sync → Customer lists. A failing list is reported; the others still sync. */
export async function syncAllLists(
  deps: ServiceDeps,
  sync: (deps: ServiceDeps, def: ListDefinition) => Promise<{ inserted: number; updated: number; deleted: number }>,
): Promise<ListSyncResult[]> {
  const results: ListSyncResult[] = [];
  for (const key of ALL_LISTS_ORDER) {
    const def = LIST_DEFINITIONS[key];
    try {
      const r = await sync(deps, def);
      results.push({ entityType: def.title, recordsSynced: r.inserted + r.updated, complete: true, cursor: null, error: null });
    } catch (e) {
      results.push({ entityType: def.title, recordsSynced: 0, complete: false, cursor: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
