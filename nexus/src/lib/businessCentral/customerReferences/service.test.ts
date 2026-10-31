import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BcClient } from '../client';
import { deleteEntry, saveEntry, syncList, type ServiceDeps } from './service';
import { BcConflictError, BcReferenceError, ReferenceInUseError } from './errors';
import type { ListDefinition } from './listDefinition';
import type { BcKey, BcRecord, ReferenceSource, ReferenceTransport } from './transport';
import { createUsageCounter } from './usage';

type Row = Record<string, unknown>;
type Result = { data: Row[]; error: { message: string } | null };

interface FakeOptions {
  /** Tables with a unique (organization_id, bc_connection_id, code) constraint. */
  uniqueCode?: string[];
  /** Tables whose writes fail, to simulate a Nexus database error. */
  failWrites?: string[];
}

interface Builder extends PromiseLike<Result> {
  select(): Builder;
  insert(p: Row): Builder;
  update(p: Row): Builder;
  delete(): Builder;
  eq(k: string, v: unknown): Builder;
  maybeSingle(): Promise<{ data: Row | null; error: { message: string } | null }>;
  single(): Promise<{ data: Row | null; error: { message: string } | null }>;
}

/** Ops applied to each table, in order, e.g. 'pt:delete'. */
let ops: string[] = [];

function fakeSupabase(tables: Record<string, Row[]>, opts: FakeOptions = {}): SupabaseClient {
  let nextId = 1;
  const from = (table: string): Builder => {
    tables[table] ??= [];
    const filters: [string, unknown][] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row = {};
    const match = () => tables[table].filter((r) => filters.every(([k, v]) => r[k] === v));
    const exec = (): Result => {
      if (op !== 'select') ops.push(`${table}:${op}`);
      if (op !== 'select' && opts.failWrites?.includes(table)) return { data: [], error: { message: 'db exploded: secret detail' } };
      if (op === 'insert') {
        const clash = opts.uniqueCode?.includes(table) && tables[table].some((r) =>
          r.organization_id === payload.organization_id && r.bc_connection_id === payload.bc_connection_id && r.code === payload.code);
        if (clash) return { data: [], error: { message: 'duplicate key value violates unique constraint' } };
        const row = { id: `gen-${nextId++}`, ...payload };
        tables[table].push(row);
        return { data: [row], error: null };
      }
      const rows = match();
      if (op === 'update') rows.forEach((r) => Object.assign(r, payload));
      if (op === 'delete') tables[table] = tables[table].filter((r) => !rows.includes(r));
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const single = async () => {
      const r = exec();
      return { data: r.data[0] ?? null, error: r.error ?? (r.data[0] ? null : { message: 'no row' }) };
    };
    const b: Builder = {
      select: () => b,
      insert: (p) => { op = 'insert'; payload = p; return b; },
      update: (p) => { op = 'update'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (k, v) => { filters.push([k, v]); return b; },
      maybeSingle: async () => { const r = exec(); return { data: r.data[0] ?? null, error: r.error }; },
      single,
      then: (res, rej) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

interface Remote { rec: BcRecord }
function fakeTransport(remote: Map<string, Remote>, keyOf: (fields: Record<string, unknown>) => string) {
  let etagN = 1;
  const ks = (k: BcKey) => ('bcId' in k ? k.bcId : k.values.code);
  const t = {
    list: vi.fn(async (source: ReferenceSource, options?: { filter?: string }) => {
      void source;
      void options;
      return [...remote.values()].map((r) => r.rec);
    }),
    get: vi.fn(async (_s: ReferenceSource, k: BcKey) => remote.get(ks(k))!.rec),
    create: vi.fn(async (_s: ReferenceSource, fields: Record<string, unknown>) => {
      const id = keyOf(fields);
      if (remote.has(id)) throw new BcReferenceError(400, 'The record already exists');
      const rec = { key: { bcId: id }, etag: `e${etagN++}`, fields: { ...fields, lastModifiedDateTime: '2026-01-01T00:00:00Z' } } as BcRecord;
      remote.set(id, { rec });
      return rec;
    }),
    patch: vi.fn(async (_s: ReferenceSource, k: BcKey, etag: string, fields: Record<string, unknown>) => {
      const cur = remote.get(ks(k))!;
      if (cur.rec.etag !== etag) throw new BcConflictError();
      if ('code' in fields && fields.code !== ks(k) && remote.has(String(fields.code))) throw new BcReferenceError(400, 'The record already exists');
      cur.rec = { ...cur.rec, etag: `e${etagN++}`, fields: { ...cur.rec.fields, ...fields } };
      return cur.rec;
    }),
    remove: vi.fn(async (_s: ReferenceSource, k: BcKey, etag: string) => { void etag; remote.delete(ks(k)); }),
  };
  return t as unknown as ReferenceTransport & typeof t;
}

const fields = [
  { name: 'code', bcName: 'code', label: 'Code', type: 'text', isKey: true, required: true, editable: true, maxLength: 10 },
  { name: 'display_name', bcName: 'displayName', label: 'Description', type: 'text', editable: true },
  { name: 'discount_percent', bcName: 'discountPercent', label: 'Discount', type: 'percent', editable: true },
];
const def = { key: 'paymentTerms', title: 'PT', table: 'pt', mode: 'managed', source: { kind: 'api', resource: 'paymentTerms' }, fields, renameField: 'code' } as unknown as ListDefinition;
const odataDef = { ...def, key: 'taxAreas', table: 'areas', source: { kind: 'odata', service: 'TaxArea', pageNumber: 1, keyFields: ['code'] } } as unknown as ListDefinition;

const base = { organization_id: 'org', bc_connection_id: 'conn' };
const bcRec = (code: string, name: string, discount: number, etag: string): BcRecord => ({
  key: { bcId: code }, etag, fields: { code, displayName: name, discountPercent: discount, lastModifiedDateTime: '2026-01-01T00:00:00Z' },
});

let tables: Record<string, Row[]>;
let remote: Map<string, Remote>;
let transport: ReturnType<typeof fakeTransport>;
let countUsage: ReturnType<typeof vi.fn<ServiceDeps['countUsage']>>;
let deps: ServiceDeps;

beforeEach(() => {
  ops = [];
  tables = { pt: [], areas: [], business_central_tax_area_lines: [] };
  remote = new Map();
  transport = fakeTransport(remote, (f) => String(f.code));
  countUsage = vi.fn<ServiceDeps['countUsage']>(async () => null);
  deps = { supabase: fakeSupabase(tables), transport, orgId: 'org', connectionId: 'conn', now: () => 'NOW', countUsage } as ServiceDeps;
});

function seed(code = 'NET30', name = 'Net', discount = 2, etag = 'e0') {
  remote.set(code, { rec: bcRec(code, name, discount, etag) });
  tables.pt.push({ id: 'r1', ...base, bc_id: code, bc_etag: etag, bc_last_modified_at: null, last_synced_at: null, code, display_name: name, discount_percent: discount });
  return { code, display_name: name, discount_percent: discount };
}

describe('saveEntry', () => {
  it('edit sends only changed fields', async () => {
    const original = seed();
    await saveEntry(deps, def, { id: 'r1', original, edited: { ...original, display_name: 'Net 30' } });
    expect(transport.patch).toHaveBeenCalledWith(def.source, { bcId: 'NET30' }, 'e0', { displayName: 'Net 30' });
    expect(tables.pt[0].display_name).toBe('Net 30');
    expect(tables.pt[0].bc_etag).not.toBe('e0');
    expect(tables.pt[0].bc_last_modified_at).toBe('2026-01-01T00:00:00Z');
  });

  it('returns unchanged without calling BC when nothing changed', async () => {
    const original = seed();
    const entry = await saveEntry(deps, def, { id: 'r1', original, edited: { ...original } });
    expect(transport.patch).not.toHaveBeenCalled();
    expect(entry.id).toBe('r1');
  });

  it('412 then success re-reads and re-applies only changed fields', async () => {
    const original = seed();
    remote.get('NET30')!.rec = bcRec('NET30', 'Net', 9, 'e-bc'); // BC changed discount meanwhile
    const entry = await saveEntry(deps, def, { id: 'r1', original, edited: { ...original, display_name: 'Mine' } });
    expect(remote.get('NET30')!.rec.fields).toMatchObject({ displayName: 'Mine', discountPercent: 9 });
    expect(transport.patch).toHaveBeenCalledTimes(2);
    expect(entry.values.discount_percent).toBe(9);
    expect(tables.pt[0].discount_percent).toBe(9);
  });

  it('two 412s throw the try-again message and leave the row unchanged', async () => {
    const original = seed();
    transport.patch.mockRejectedValue(new BcConflictError());
    await expect(saveEntry(deps, def, { id: 'r1', original, edited: { ...original, display_name: 'X' } }))
      .rejects.toThrow('This entry changed in Business Central again while saving. Try again.');
    expect(tables.pt[0].display_name).toBe('Net');
  });

  it('rename to existing code surfaces BC message and leaves Nexus row unchanged', async () => {
    const original = seed();
    remote.set('OTHER', { rec: bcRec('OTHER', 'o', 0, 'e9') });
    await expect(saveEntry(deps, def, { id: 'r1', original, edited: { ...original, code: 'OTHER' } }))
      .rejects.toThrow('The record already exists');
    expect(tables.pt[0].code).toBe('NET30');
  });

  it('create inserts a row from the returned record', async () => {
    const entry = await saveEntry(deps, def, { id: null, original: null, edited: { code: 'N45', display_name: 'Net 45', discount_percent: 1 } });
    expect(tables.pt).toHaveLength(1);
    expect(tables.pt[0]).toMatchObject({ organization_id: 'org', bc_connection_id: 'conn', bc_id: 'N45', code: 'N45', last_synced_at: 'NOW' });
    expect(entry.values.code).toBe('N45');
    expect(entry.lastSyncedAt).toBe('NOW');
  });

  it('create failure leaves no Nexus row', async () => {
    seed('DUP');
    await expect(saveEntry(deps, def, { id: null, original: null, edited: { code: 'DUP', display_name: 'x', discount_percent: 0 } }))
      .rejects.toThrow('The record already exists');
    expect(tables.pt).toHaveLength(1);
  });

  it('validation failure throws joined messages and makes no BC call', async () => {
    await expect(saveEntry(deps, def, { id: null, original: null, edited: { code: '', discount_percent: 500 } }))
      .rejects.toThrow('Code is required\nDiscount must be between 0 and 100');
    expect(transport.create).not.toHaveBeenCalled();
  });

  it('odata rename keys on the original stored values and updates key in place', async () => {
    tables.areas.push({ id: 'a1', ...base, bc_id: null, bc_etag: 'e0', code: 'OLD', display_name: 'd', discount_percent: 0 });
    remote.set('OLD', { rec: { key: { values: { code: 'OLD' } }, etag: 'e0', fields: { code: 'OLD', displayName: 'd', discountPercent: 0 } } });
    const orig = { code: 'OLD', display_name: 'd', discount_percent: 0 };
    transport.patch.mockImplementationOnce(async (_s, _k, _e, f) => ({ key: { values: { code: String(f.code) } }, etag: 'e1', fields: { code: f.code, displayName: 'd', discountPercent: 0 } }));
    await saveEntry(deps, odataDef, { id: 'a1', original: orig, edited: { ...orig, code: 'NEW' } });
    expect(transport.patch).toHaveBeenCalledWith(odataDef.source, { values: { code: 'OLD' } }, 'e0', { code: 'NEW' });
    expect(tables.areas[0].code).toBe('NEW');
  });
});

describe('saveEntry: validate only what changed', () => {
  const dateDef = {
    ...def,
    fields: [...fields, { name: 'due', bcName: 'due', label: 'Due', type: 'dateFormula', editable: true }],
  } as unknown as ListDefinition;

  it('an old invalid BC value in an untouched field does not block an unrelated edit', async () => {
    const original = { ...seed(), due: 'NOT A FORMULA' };
    tables.pt[0].due = 'NOT A FORMULA';
    await saveEntry(deps, dateDef, { id: 'r1', original, edited: { ...original, display_name: 'Net 30' } });
    expect(transport.patch).toHaveBeenCalledWith(def.source, { bcId: 'NET30' }, 'e0', { displayName: 'Net 30' });
  });

  it('a changed field is still validated on edit', async () => {
    const original = seed();
    await expect(saveEntry(deps, def, { id: 'r1', original, edited: { ...original, discount_percent: 500 } }))
      .rejects.toThrow('Discount must be between 0 and 100');
    expect(transport.patch).not.toHaveBeenCalled();
  });
});

describe('saveEntry: BC accepted but Nexus failed', () => {
  const MSG = 'Saved in Business Central, but Nexus could not record it. Press Sync.';

  it('create', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    deps = { ...deps, supabase: fakeSupabase(tables, { failWrites: ['pt'] }) };
    const err = await saveEntry(deps, def, { id: null, original: null, edited: { code: 'N45', display_name: 'n', discount_percent: 0 } })
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(MSG);
    expect(transport.create).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('update', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = seed();
    deps = { ...deps, supabase: fakeSupabase(tables, { failWrites: ['pt'] }) };
    const err = await saveEntry(deps, def, { id: 'r1', original, edited: { ...original, display_name: 'X' } }).catch((e: Error) => e);
    expect((err as Error).message).toBe(MSG);
    expect(transport.patch).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('a BC failure is still reported as the BC error', async () => {
    seed('DUP');
    await expect(saveEntry(deps, def, { id: null, original: null, edited: { code: 'DUP', display_name: 'x', discount_percent: 0 } }))
      .rejects.toThrow('The record already exists');
  });
});

describe('deleteEntry', () => {
  it('blocked when countUsage returns a message', async () => {
    seed();
    countUsage.mockResolvedValue('Used by 12 customers');
    await expect(deleteEntry(deps, def, 'r1')).rejects.toThrow(ReferenceInUseError);
    await expect(deleteEntry(deps, def, 'r1')).rejects.toThrow('Used by 12 customers');
    expect(transport.remove).not.toHaveBeenCalled();
    expect(tables.pt).toHaveLength(1);
  });

  it('price group delete throws the disabled reason without calling BC', async () => {
    seed();
    const d = { ...def, deleteDisabledReason: 'Cannot delete price groups' } as ListDefinition;
    await expect(deleteEntry(deps, d, 'r1')).rejects.toThrow('Cannot delete price groups');
    expect(transport.remove).not.toHaveBeenCalled();
    expect(countUsage).not.toHaveBeenCalled();
  });

  it('deletes in BC then Nexus', async () => {
    seed();
    await deleteEntry(deps, def, 'r1');
    expect(transport.remove).toHaveBeenCalledWith(def.source, { bcId: 'NET30' }, 'e0');
    expect(tables.pt).toHaveLength(0);
  });

  it('a BC conflict on delete asks the admin to sync', async () => {
    seed();
    transport.remove.mockRejectedValue(new BcConflictError());
    await expect(deleteEntry(deps, def, 'r1')).rejects.toThrow('This entry changed in Business Central. Press Sync and try again.');
    expect(tables.pt).toHaveLength(1);
  });

  it('jurisdiction delete is blocked by a live BC line even when the Nexus copy has none', async () => {
    const jurDef = { ...odataDef, key: 'taxJurisdictions', table: 'jur' } as ListDefinition;
    tables.jur = [{ id: 'j1', ...base, bc_id: null, bc_etag: 'e0', code: 'CA' }];
    tables.business_central_tax_area_lines = [];
    tables.business_central_tax_details = [];
    const live = (source: ReferenceSource): BcRecord[] =>
      source.kind === 'odata' && source.service === 'TaxAreaLines'
        ? [{ key: { values: { Tax_Area: 'A', Tax_Jurisdiction_Code: 'CA' } }, etag: 'e', fields: {} }]
        : [];
    transport.list.mockImplementation(async (source: ReferenceSource) => live(source));
    deps = { ...deps, countUsage: createUsageCounter({} as BcClient, transport) };
    await expect(deleteEntry(deps, jurDef, 'j1')).rejects.toThrow('Used by 1 tax area line and 0 tax details');
    expect(transport.remove).not.toHaveBeenCalled();
    expect(tables.jur).toHaveLength(1);
  });

  it('BC failure keeps the Nexus row', async () => {
    seed();
    transport.remove.mockRejectedValue(new BcReferenceError(400, 'nope'));
    await expect(deleteEntry(deps, def, 'r1')).rejects.toThrow('nope');
    expect(tables.pt).toHaveLength(1);
  });

  it('delete tax area removes its Nexus lines after BC confirms', async () => {
    tables.areas.push({ id: 'a1', ...base, bc_id: null, bc_etag: 'e0', code: 'AREA1' });
    tables.business_central_tax_area_lines.push(
      { id: 'l1', ...base, tax_area_code: 'AREA1' },
      { id: 'l2', ...base, tax_area_code: 'OTHER' },
      { id: 'l3', organization_id: 'org2', bc_connection_id: 'conn', tax_area_code: 'AREA1' },
    );
    remote.set('AREA1', { rec: { key: { values: { code: 'AREA1' } }, etag: 'e0', fields: { code: 'AREA1' } } });
    await deleteEntry(deps, odataDef, 'a1');
    expect(tables.areas).toHaveLength(0);
    expect(tables.business_central_tax_area_lines.map((r) => r.id)).toEqual(['l2', 'l3']);
    expect(ops).toEqual(['business_central_tax_area_lines:delete', 'areas:delete']);
  });
});

describe('syncList', () => {
  it('applies plan and reports counts', async () => {
    tables.pt.push(
      { id: 'keep', ...base, bc_id: 'KEEP', bc_etag: 'e1', code: 'KEEP', display_name: 'k', discount_percent: 0 },
      { id: 'upd', ...base, bc_id: 'UPD', bc_etag: 'e1', code: 'UPD', display_name: 'old', discount_percent: 0 },
      { id: 'gone', ...base, bc_id: 'GONE', bc_etag: 'e1', code: 'GONE', display_name: 'g', discount_percent: 0 },
    );
    remote.set('KEEP', { rec: bcRec('KEEP', 'k', 0, 'e1') });
    remote.set('UPD', { rec: bcRec('UPD', 'new', 0, 'e2') });
    remote.set('NEW', { rec: bcRec('NEW', 'n', 0, 'e1') });
    const result = await syncList(deps, def);
    expect(result).toEqual({ inserted: 1, updated: 1, deleted: 1 });
    expect(tables.pt.map((r) => r.code).sort()).toEqual(['KEEP', 'NEW', 'UPD']);
    expect(tables.pt.find((r) => r.code === 'UPD')).toMatchObject({ display_name: 'new', bc_etag: 'e2', last_synced_at: 'NOW' });
    expect(tables.pt.find((r) => r.code === 'NEW')).toMatchObject({ organization_id: 'org', bc_connection_id: 'conn', bc_id: 'NEW' });
    expect(transport.create).not.toHaveBeenCalled();
    expect(transport.patch).not.toHaveBeenCalled();
    expect(transport.remove).not.toHaveBeenCalled();
  });

  it('applies deletes, then updates, then inserts', async () => {
    tables.pt.push(
      { id: 'upd', ...base, bc_id: 'UPD', bc_etag: 'e1', code: 'UPD', display_name: 'old', discount_percent: 0 },
      { id: 'gone', ...base, bc_id: 'GONE', bc_etag: 'e1', code: 'GONE', display_name: 'g', discount_percent: 0 },
    );
    remote.set('UPD', { rec: bcRec('UPD', 'new', 0, 'e2') });
    remote.set('NEW', { rec: bcRec('NEW', 'n', 0, 'e1') });
    await syncList(deps, def);
    expect(ops).toEqual(['pt:delete', 'pt:update', 'pt:insert']);
  });

  it('an entry deleted and re-created in BC with the same code (new id) syncs despite the unique code', async () => {
    deps = { ...deps, supabase: fakeSupabase(tables, { uniqueCode: ['pt'] }) };
    tables.pt.push({ id: 'old', ...base, bc_id: 'id-old', bc_etag: 'e1', code: 'NET30', display_name: 'Net', discount_percent: 0 });
    remote.set('id-new', { rec: { ...bcRec('NET30', 'Net again', 0, 'e9'), key: { bcId: 'id-new' } } });
    expect(await syncList(deps, def)).toEqual({ inserted: 1, updated: 0, deleted: 1 });
    expect(tables.pt).toHaveLength(1);
    expect(tables.pt[0]).toMatchObject({ bc_id: 'id-new', code: 'NET30', display_name: 'Net again' });
  });
});
