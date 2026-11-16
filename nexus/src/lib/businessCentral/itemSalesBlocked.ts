// BC's "Sales Blocked" item flag isn't in the items API (only "blocked" is),
// so it is read from the Item Card's OData page and copied onto Nexus's items.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReferenceSource, ReferenceTransport } from './customerReferences/transport';

/** Item Card (page 30) as published for Excel; has No and Sales_Blocked. */
export const ITEM_CARD_SOURCE: ReferenceSource = { kind: 'odata', service: 'Item_Card_Excel', pageNumber: 30, keyFields: ['No'] };

const TABLE = 'business_central_items';
const CHUNK = 200;

export interface SalesBlockedDeps {
  supabase: SupabaseClient;
  transport: ReferenceTransport;
  orgId: string;
  connectionId: string;
}

/**
 * Sets `sales_blocked` on every Nexus item of the connection to BC's value.
 * Reads the whole flag list each time (a few hundred rows), so a flag changed
 * in BC is picked up even when the item's API timestamp didn't move.
 * Returns how many items changed.
 */
export async function refreshItemSalesBlocked(deps: SalesBlockedDeps): Promise<number> {
  const records = await deps.transport.list(ITEM_CARD_SOURCE, { select: ['No', 'Sales_Blocked'] });
  const blocked = new Set(records.filter((r) => r.fields.Sales_Blocked === true).map((r) => String(r.fields.No)));

  const { data, error } = await deps.supabase
    .from(TABLE)
    .select('id, bc_item_number, sales_blocked')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .not('bc_item_number', 'is', null);
  if (error) throw new Error(`Could not load items: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; bc_item_number: string; sales_blocked: boolean }>;
  const toBlock = rows.filter((r) => !r.sales_blocked && blocked.has(r.bc_item_number)).map((r) => r.id);
  const toUnblock = rows.filter((r) => r.sales_blocked && !blocked.has(r.bc_item_number)).map((r) => r.id);

  for (const [ids, value] of [[toBlock, true], [toUnblock, false]] as const) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error: upErr } = await deps.supabase
        .from(TABLE)
        .update({ sales_blocked: value })
        .eq('organization_id', deps.orgId)
        .eq('bc_connection_id', deps.connectionId)
        .in('id', ids.slice(i, i + CHUNK));
      if (upErr) throw new Error(`Could not save Sales Blocked: ${upErr.message}`);
    }
  }
  return toBlock.length + toUnblock.length;
}
