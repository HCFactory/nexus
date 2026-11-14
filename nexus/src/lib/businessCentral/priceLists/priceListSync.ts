import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReferenceSource, ReferenceTransport } from '../customerReferences/transport';

/** BC's SourceType captions, stored verbatim (measured on TEST; only the group caption occurs there). */
export const SOURCE_ALL_CUSTOMERS = 'All Customers';
export const SOURCE_CUSTOMER = 'Customer';
export const SOURCE_PRICE_GROUP = 'Customer Price Group';

export interface PriceListSyncDeps {
  supabase: SupabaseClient;
  transport: ReferenceTransport;
  orgId: string;
  connectionId: string;
  now: () => string;
}

// Page numbers are only used in error messages.
const HEADER_SOURCE: ReferenceSource = { kind: 'odata', service: 'Sales_Price_List_Excel', pageNumber: 7015, keyFields: ['Code'] };
const LINE_SOURCE: ReferenceSource = {
  kind: 'odata',
  service: 'Sales_Price_List_ExcelLines',
  pageNumber: 7018,
  keyFields: ['Price_List_Code', 'Line_No'],
  integerKeyFields: ['Line_No'],
};

const TABLE = 'business_central_sales_price_list_lines';
const CHUNK = 500;
const NO_DATE = '0001-01-01';

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const date = (v: unknown): string | null => {
  const s = str(v);
  return s === '' || s.startsWith(NO_DATE) ? null : s;
};

export async function pullSalesPriceLists(deps: PriceListSyncDeps): Promise<{ lines: number }> {
  const [headerRecords, lineRecords] = await Promise.all([
    deps.transport.list(HEADER_SOURCE),
    deps.transport.list(LINE_SOURCE),
  ]);
  const headers = new Map(headerRecords.map((r) => [str(r.fields.Code), r.fields]));
  const syncedAt = deps.now();

  const rows: Record<string, unknown>[] = [];
  for (const { fields: l } of lineRecords) {
    const item = str(l.Asset_No) || str(l.Product_No);
    if (!item) continue;
    const code = str(l.Price_List_Code);
    const h = headers.get(code);
    if (!h) continue;
    rows.push({
      organization_id: deps.orgId,
      bc_connection_id: deps.connectionId,
      price_list_code: code,
      line_no: num(l.Line_No),
      list_status: str(h.Status),
      // Line SourceType is always '0' in BC's feed, so the header's caption is used.
      source_type: str(h.SourceType),
      source_no: str(l.AssignToNo) || str(h.AssignToNo) || str(h.SourceNo),
      item_number: item,
      unit_of_measure_code: str(l.Unit_of_Measure_Code),
      minimum_quantity: num(l.Minimum_Quantity),
      starting_date: date(l.StartingDate),
      ending_date: date(l.EndingDate),
      unit_price: num(l.Unit_Price),
      line_discount_percent: num(l.Line_Discount_Percent),
      amount_type: str(l.Amount_Type),
      last_synced_at: syncedAt,
    });
  }

  const del = await deps.supabase.from(TABLE).delete().eq('organization_id', deps.orgId).eq('bc_connection_id', deps.connectionId);
  if (del.error) throw new Error(del.error.message);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const ins = await deps.supabase.from(TABLE).insert(rows.slice(i, i + CHUNK));
    if (ins.error) throw new Error(ins.error.message);
  }
  return { lines: rows.length };
}
