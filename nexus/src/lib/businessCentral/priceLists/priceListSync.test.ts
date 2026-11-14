import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { BcRecord, ReferenceSource, ReferenceTransport } from '../customerReferences/transport';
import { pullSalesPriceLists, SOURCE_PRICE_GROUP, SOURCE_CUSTOMER, SOURCE_ALL_CUSTOMERS } from './priceListSync';

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>, log: string[] = []) {
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: [string, unknown][] = [];
    let op: 'delete' | 'insert' = 'delete';
    let payload: Row[] = [];
    const exec = () => {
      if (op === 'insert') {
        tables[table].push(...payload);
        log.push(`insert:${payload.length}`);
      } else {
        tables[table] = tables[table].filter((r) => !filters.every(([k, v]) => r[k] === v));
        log.push(`delete:${filters.map(([k, v]) => `${k}=${v}`).join(',')}`);
      }
      return { data: null, error: null };
    };
    const b = {
      delete: () => { op = 'delete'; return b; },
      insert: (p: Row[]) => { op = 'insert'; payload = p; return b; },
      eq: (k: string, v: unknown) => { filters.push([k, v]); return b; },
      then: (res: (r: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

function fakeTransport(headers: Row[], lines: Row[], fail = false): ReferenceTransport {
  return {
    list: async (source: ReferenceSource) => {
      if (fail) throw new Error('boom');
      if (source.kind !== 'odata') throw new Error('odata expected');
      const rows = source.service === 'Sales_Price_List_Excel' ? headers : lines;
      return rows.map((fields): BcRecord => ({ key: { values: {} }, etag: '', fields }));
    },
  } as unknown as ReferenceTransport;
}

const header = (o: Row = {}): Row => ({
  Code: 'L1', Description: 'd', SourceType: SOURCE_PRICE_GROUP, SourceNo: 'HG', AssignToNo: 'HG',
  Status: 'Active', StartingDate: '0001-01-01', EndingDate: '0001-01-01', ...o,
});
const line = (o: Row = {}): Row => ({
  Price_List_Code: 'L1', Line_No: 10000, SourceType: '0', SourceNo: '', AssignToNo: 'GRP', Asset_No: 'I1', Product_No: 'I1',
  Unit_of_Measure_Code: 'PCS', Minimum_Quantity: 5, Amount_Type: 'Price', Unit_Price: 2.5, Line_Discount_Percent: 0,
  StartingDate: '0001-01-01', EndingDate: '0001-01-01', ...o,
});
const deps = (supabase: SupabaseClient, transport: ReferenceTransport) => ({
  supabase, transport, orgId: 'o1', connectionId: 'c1', now: () => 'NOW',
});

describe('pullSalesPriceLists', () => {
  it('exports the BC source type captions', () => {
    expect([SOURCE_ALL_CUSTOMERS, SOURCE_CUSTOMER, SOURCE_PRICE_GROUP]).toEqual(['All Customers', 'Customer', 'Customer Price Group']);
  });

  it('joins lines to headers, inherits status, takes source type from header and number line-first', async () => {
    const tables: Record<string, Row[]> = {};
    const res = await pullSalesPriceLists(deps(fakeSupabase(tables), fakeTransport(
      [header({ Status: 'Draft' }), header({ Code: 'L2', SourceType: SOURCE_CUSTOMER, SourceNo: 'C9', AssignToNo: '' })],
      [line(), line({ Price_List_Code: 'L2', AssignToNo: '', Line_No: 20000 }), line({ Price_List_Code: 'L3' })],
    )));
    const rows = tables['business_central_sales_price_list_lines'];
    expect(res.lines).toBe(2);
    expect(rows[0]).toMatchObject({
      organization_id: 'o1', bc_connection_id: 'c1', price_list_code: 'L1', line_no: 10000, list_status: 'Draft',
      source_type: SOURCE_PRICE_GROUP, source_no: 'GRP', item_number: 'I1', unit_of_measure_code: 'PCS',
      minimum_quantity: 5, unit_price: 2.5, line_discount_percent: 0, amount_type: 'Price', last_synced_at: 'NOW',
    });
    expect(rows[1]).toMatchObject({ source_type: SOURCE_CUSTOMER, source_no: 'C9', list_status: 'Active' });
  });

  it('falls back to header AssignToNo then SourceNo', async () => {
    const tables: Record<string, Row[]> = {};
    await pullSalesPriceLists(deps(fakeSupabase(tables), fakeTransport(
      [header({ AssignToNo: 'HA', SourceNo: 'HS' }), header({ Code: 'L2', AssignToNo: '', SourceNo: 'HS2' })],
      [line({ AssignToNo: '' }), line({ Price_List_Code: 'L2', AssignToNo: '' })],
    )));
    const rows = tables['business_central_sales_price_list_lines'];
    expect(rows.map((r) => r.source_no)).toEqual(['HA', 'HS2']);
  });

  it('stores 0001-01-01 as null and keeps real dates', async () => {
    const tables: Record<string, Row[]> = {};
    await pullSalesPriceLists(deps(fakeSupabase(tables), fakeTransport(
      [header()], [line({ StartingDate: '2026-01-01' })],
    )));
    expect(tables['business_central_sales_price_list_lines'][0]).toMatchObject({ starting_date: '2026-01-01', ending_date: null });
  });

  it('uses Product_No when Asset_No is empty and skips lines with no item', async () => {
    const tables: Record<string, Row[]> = {};
    const res = await pullSalesPriceLists(deps(fakeSupabase(tables), fakeTransport(
      [header()], [line({ Asset_No: '', Product_No: 'P7' }), line({ Line_No: 2, Asset_No: '', Product_No: '' })],
    )));
    expect(res.lines).toBe(1);
    expect(tables['business_central_sales_price_list_lines'][0].item_number).toBe('P7');
  });

  it('replaces only this org and connection, inserting in chunks of 500', async () => {
    const tables: Record<string, Row[]> = {
      business_central_sales_price_list_lines: [
        { organization_id: 'o1', bc_connection_id: 'c1', price_list_code: 'OLD' },
        { organization_id: 'o2', bc_connection_id: 'c1', price_list_code: 'KEEP' },
      ],
    };
    const log: string[] = [];
    const lines = Array.from({ length: 1001 }, (_, i) => line({ Line_No: i + 1 }));
    await pullSalesPriceLists(deps(fakeSupabase(tables, log), fakeTransport([header()], lines)));
    const rows = tables['business_central_sales_price_list_lines'];
    expect(rows.find((r) => r.price_list_code === 'OLD')).toBeUndefined();
    expect(rows.find((r) => r.price_list_code === 'KEEP')).toBeDefined();
    expect(log).toEqual(['delete:organization_id=o1,bc_connection_id=c1', 'insert:500', 'insert:500', 'insert:1']);
  });

  it('does not delete anything when BC listing fails', async () => {
    const tables: Record<string, Row[]> = { business_central_sales_price_list_lines: [{ organization_id: 'o1', bc_connection_id: 'c1' }] };
    await expect(pullSalesPriceLists(deps(fakeSupabase(tables), fakeTransport([], [], true)))).rejects.toThrow(/boom/);
    expect(tables['business_central_sales_price_list_lines']).toHaveLength(1);
  });
});
