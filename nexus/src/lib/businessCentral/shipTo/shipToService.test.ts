import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BcConflictError } from '../customerReferences/errors';
import type { BcKey, BcRecord, ReferenceSource } from '../customerReferences/transport';
import { CUSTOMER_CARD_SOURCE } from '../customers/customerCardFill';
import { deleteShipTo, pullShipTos, saveShipTo, setDefaultShipTo, type ShipToDeps } from './shipToService';
import { SHIP_TO_SOURCE } from './shipToSource';
import type { ShipToValues } from '@/types/salesOrders';

type Row = Record<string, unknown>;
type Result = { data: Row[]; error: { message: string } | null };

function fakeSupabase(tables: Record<string, Row[]>): SupabaseClient {
  let nextId = 1;
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: [string, unknown][] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    const exec = (): Result => {
      if (op === 'insert') {
        const row = { id: `gen-${nextId++}`, ...payload };
        tables[table].push(row);
        return { data: [row], error: null };
      }
      const rows = tables[table].filter((r) => filters.every(([k, v]) => r[k] === v));
      if (op === 'update') rows.forEach((r) => Object.assign(r, payload));
      if (op === 'delete') tables[table] = tables[table].filter((r) => !rows.includes(r));
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select: () => b,
      insert: (p: Row) => { op = 'insert'; payload = p; return b; },
      update: (p: Row) => { op = 'update'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (k: string, v: unknown) => { filters.push([k, v]); return b; },
      maybeSingle: async () => { const r = exec(); return { data: r.data[0] ?? null, error: r.error }; },
      single: async () => { const r = exec(); return { data: r.data[0] ?? null, error: r.data[0] ? null : { message: 'no row' } }; },
      then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

const idOf = (k: BcKey) => ('values' in k ? `${k.values.Customer_No ?? k.values.No}|${k.values.Code ?? ''}` : k.bcId);

function fakeTransport(store: Map<string, BcRecord>) {
  let n = 1;
  return {
    list: vi.fn<(s: ReferenceSource, o?: { filter?: string }) => Promise<BcRecord[]>>(async () => [...store.values()]),
    get: vi.fn(async (_s: ReferenceSource, key: BcKey) => store.get(idOf(key))!),
    create: vi.fn(async (_s: ReferenceSource, fields: Record<string, unknown>) => {
      const key = { values: { Customer_No: String(fields.Customer_No), Code: String(fields.Code) } };
      const rec = { key, etag: `W/"c${n++}"`, fields: { ...fields } };
      store.set(idOf(key), rec);
      return rec;
    }),
    patch: vi.fn(async (_s: ReferenceSource, key: BcKey, etag: string, fields: Record<string, unknown>) => {
      const r = store.get(idOf(key))!;
      if (r.etag !== etag) throw new BcConflictError();
      const next = { ...r, etag: `W/"p${n++}"`, fields: { ...r.fields, ...fields } };
      store.set(idOf(key), next);
      return next;
    }),
    remove: vi.fn(async (_s: ReferenceSource, key: BcKey, etag: string) => {
      const r = store.get(idOf(key))!;
      if (r.etag !== etag) throw new BcConflictError();
      store.delete(idOf(key));
    }),
  };
}

const VALUES: ShipToValues = {
  code: '', name: 'Kai Holu', address: '165 Kaiholu St', address_2: '', city: 'Kailua', state: 'HI', post_code: '96734',
  country: 'US', contact: 'Sam', phone: '555', email: 'a@b.com', tax_area_code: 'HI', location_code: 'MAIN',
  shipment_method_code: 'UPS', tax_liable: true,
};

let tables: Record<string, Row[]>;
let store: Map<string, BcRecord>;
let transport: ReturnType<typeof fakeTransport>;
let deps: ShipToDeps;

const localRow = (over: Row = {}): Row => ({
  id: 'l1', organization_id: 'org', bc_connection_id: 'conn', customer_number: 'C1', ...VALUES, code: '165KAIHOLU',
  bc_etag: 'W/"old"', ...over,
});
const bcRec = (cust: string, code: string, etag: string, fields: Row = {}): BcRecord => ({
  key: { values: { Customer_No: cust, Code: code } }, etag, fields: { Name: 'N', Address: 'A', Tax_Liable: false, ...fields },
});

beforeEach(() => {
  tables = { customer_ship_to_addresses: [], business_central_customers: [] };
  store = new Map();
  transport = fakeTransport(store);
  deps = { supabase: fakeSupabase(tables), transport, orgId: 'org', connectionId: 'conn', now: () => '2026-11-13T00:00:00Z' };
});

describe('saveShipTo create', () => {
  it('generates the code, creates in BC and stores BC etag', async () => {
    const row = await saveShipTo(deps, { customerNumber: 'C1', values: VALUES });
    expect(transport.create).toHaveBeenCalledWith(SHIP_TO_SOURCE, expect.objectContaining({
      Customer_No: 'C1', Code: '165KAIHOLU', Name: 'Kai Holu', Address: '165 Kaiholu St', County: 'HI', Tax_Liable: true,
    }));
    expect(row.code).toBe('165KAIHOLU');
    expect(tables.customer_ship_to_addresses[0]).toMatchObject({ customer_number: 'C1', bc_etag: 'W/"c1"', organization_id: 'org' });
  });

  it('avoids codes already used locally', async () => {
    tables.customer_ship_to_addresses.push(localRow());
    const row = await saveShipTo(deps, { customerNumber: 'C1', values: VALUES });
    expect(row.code).toBe('165KAIHO-2');
  });

  it('uppercases a typed code', async () => {
    await saveShipTo(deps, { customerNumber: 'C1', code: 'dock', values: VALUES });
    expect(transport.create.mock.calls[0][1]).toMatchObject({ Code: 'DOCK' });
  });

  it('rejects a typed code over 10 characters without calling BC', async () => {
    await expect(saveShipTo(deps, { customerNumber: 'C1', code: 'ABCDEFGHIJK', values: VALUES })).rejects.toThrow(
      'Ship-to code must be 10 characters or fewer.',
    );
    expect(transport.create).not.toHaveBeenCalled();
  });
});

describe('saveShipTo update', () => {
  beforeEach(() => {
    tables.customer_ship_to_addresses.push(localRow({ bc_etag: 'W/"e1"' }));
    store.set('C1|165KAIHOLU', bcRec('C1', '165KAIHOLU', 'W/"e1"', { Name: 'Kai Holu', City: 'Kailua' }));
  });

  it('sends only changed fields with the stored etag', async () => {
    const row = await saveShipTo(deps, { id: 'l1', customerNumber: 'C1', values: { ...VALUES, city: 'Honolulu' } });
    expect(transport.patch).toHaveBeenCalledTimes(1);
    expect(transport.patch).toHaveBeenCalledWith(SHIP_TO_SOURCE, { values: { Customer_No: 'C1', Code: '165KAIHOLU' } }, 'W/"e1"', { City: 'Honolulu' });
    expect(row.bc_etag).toBe('W/"p1"');
    expect(tables.customer_ship_to_addresses[0]).toMatchObject({ city: 'Honolulu', bc_etag: 'W/"p1"' });
  });

  it('on a conflict re-gets the etag and patches again', async () => {
    store.set('C1|165KAIHOLU', { ...store.get('C1|165KAIHOLU')!, etag: 'W/"bc-changed"' });
    const row = await saveShipTo(deps, { id: 'l1', customerNumber: 'C1', values: { ...VALUES, city: 'Honolulu' } });
    expect(transport.patch).toHaveBeenCalledTimes(2);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(row.bc_etag).toBe('W/"p1"');
  });
});

describe('deleteShipTo', () => {
  beforeEach(() => {
    tables.customer_ship_to_addresses.push(localRow({ bc_etag: 'W/"e1"' }));
    store.set('C1|165KAIHOLU', bcRec('C1', '165KAIHOLU', 'W/"e1"'));
  });

  it('removes in BC then locally', async () => {
    await deleteShipTo(deps, 'l1');
    expect(transport.remove).toHaveBeenCalledWith(SHIP_TO_SOURCE, { values: { Customer_No: 'C1', Code: '165KAIHOLU' } }, 'W/"e1"');
    expect(tables.customer_ship_to_addresses).toHaveLength(0);
  });

  it('clears the customer default when it was the default', async () => {
    tables.business_central_customers.push({ id: 'cu1', organization_id: 'org', bc_connection_id: 'conn', bc_customer_number: 'C1', ship_to_code: '165KAIHOLU', bc_card_etag: 'W/"card"' });
    store.set('C1|', { key: { values: { No: 'C1' } }, etag: 'W/"card"', fields: {} });
    await deleteShipTo(deps, 'l1');
    expect(transport.patch).toHaveBeenCalledWith(CUSTOMER_CARD_SOURCE, { values: { No: 'C1' } }, 'W/"card"', { Ship_to_Code: '' });
    expect(tables.business_central_customers[0].ship_to_code).toBe('');
    expect(tables.customer_ship_to_addresses).toHaveLength(0);
  });
});

describe('setDefaultShipTo', () => {
  it('patches the card with the stored etag and updates the customer', async () => {
    tables.business_central_customers.push({ id: 'cu1', organization_id: 'org', bc_connection_id: 'conn', bc_customer_number: 'C1', ship_to_code: '', bc_card_etag: 'W/"card"' });
    store.set('C1|', { key: { values: { No: 'C1' } }, etag: 'W/"card"', fields: {} });
    await setDefaultShipTo(deps, 'C1', 'DOCK');
    expect(transport.patch).toHaveBeenCalledWith(CUSTOMER_CARD_SOURCE, { values: { No: 'C1' } }, 'W/"card"', { Ship_to_Code: 'DOCK' });
    expect(tables.business_central_customers[0]).toMatchObject({ ship_to_code: 'DOCK', bc_card_etag: 'W/"p1"' });
  });
});

describe('pullShipTos', () => {
  beforeEach(() => {
    tables.customer_ship_to_addresses.push(
      localRow({ id: 'same', code: 'SAME', bc_etag: 'W/"s"', name: 'keep' }),
      localRow({ id: 'chg', code: 'CHG', bc_etag: 'W/"old"', name: 'old' }),
      localRow({ id: 'gone', code: 'GONE', bc_etag: 'W/"g"' }),
    );
    store.set('C1|SAME', bcRec('C1', 'SAME', 'W/"s"', { Name: 'bc-name' }));
    store.set('C1|CHG', bcRec('C1', 'CHG', 'W/"new"', { Name: 'new', City: 'X' }));
    store.set('C1|NEW', bcRec('C1', 'NEW', 'W/"n"', { Name: 'fresh' }));
  });

  it('merges one customer and filters the list', async () => {
    const res = await pullShipTos(deps, 'C1');
    expect(transport.list).toHaveBeenCalledWith(SHIP_TO_SOURCE, { filter: "Customer_No eq 'C1'" });
    expect(res).toEqual({ upserted: 2, deleted: 1 });
    const rows = tables.customer_ship_to_addresses;
    expect(rows.find((r) => r.code === 'SAME')!.name).toBe('keep');
    expect(rows.find((r) => r.code === 'CHG')).toMatchObject({ name: 'new', city: 'X', bc_etag: 'W/"new"' });
    expect(rows.find((r) => r.code === 'NEW')).toMatchObject({ name: 'fresh', customer_number: 'C1', bc_etag: 'W/"n"' });
    expect(rows.find((r) => r.code === 'GONE')).toBeUndefined();
  });

  it('with no customer lists everything and merges per customer', async () => {
    store.set('C2|Z', bcRec('C2', 'Z', 'W/"z"'));
    tables.customer_ship_to_addresses.push(localRow({ id: 'c2gone', customer_number: 'C2', code: 'OLD', bc_etag: 'x' }));
    const res = await pullShipTos(deps);
    expect(transport.list).toHaveBeenCalledWith(SHIP_TO_SOURCE, {});
    expect(res).toEqual({ upserted: 3, deleted: 2 });
    expect(tables.customer_ship_to_addresses.map((r) => `${r.customer_number}|${r.code}`).sort()).toEqual(['C1|CHG', 'C1|NEW', 'C1|SAME', 'C2|Z']);
  });
});
