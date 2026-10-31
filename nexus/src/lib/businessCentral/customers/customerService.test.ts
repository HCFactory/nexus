import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomer, deleteCustomer, updateCustomer, type CustomerServiceDeps } from './customerService';
import { BcConflictError, BcReferenceError } from '../customerReferences/errors';
import type { BcKey, BcRecord, ReferenceSource } from '../customerReferences/transport';
import type { NumberAssigner, PreparedNumber } from '../numberAssigner';

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

const no = (k: BcKey) => ('values' in k ? k.values.No : k.bcId);

function fakeTransport(cards: Map<string, BcRecord>) {
  let etagN = 1;
  const t = {
    list: vi.fn(async () => [...cards.values()]),
    get: vi.fn(async (_s: ReferenceSource, key: BcKey) => {
      const r = cards.get(no(key));
      if (!r) throw new BcReferenceError(404, 'not found');
      return r;
    }),
    create: vi.fn(async (_s: ReferenceSource, fields: Record<string, unknown>) => {
      const key = String(fields.No);
      if (cards.has(key)) throw new BcReferenceError(400, `The record in table Customer already exists. No.='${key}'`);
      const rec = { key: { values: { No: key } }, etag: `W/"post-${etagN++}"`, fields: { ...fields } };
      // BC touches the record after the POST, so the GET etag differs.
      cards.set(key, { ...rec, etag: `W/"get-${etagN++}"` });
      return rec;
    }),
    patch: vi.fn(async (_s: ReferenceSource, key: BcKey, etag: string, fields: Record<string, unknown>) => {
      const r = cards.get(no(key))!;
      if (r.etag !== etag) throw new BcConflictError();
      const next = { ...r, etag: `W/"e${etagN++}"`, fields: { ...r.fields, ...fields } };
      cards.set(no(key), next);
      return next;
    }),
    remove: vi.fn(async (_s: ReferenceSource, key: BcKey, etag: string) => {
      const r = cards.get(no(key))!;
      if (r.etag !== etag) throw new BcConflictError();
      cards.delete(no(key));
    }),
  };
  return t;
}

function fakeAssigner(start = 1250) {
  const mk = (n: number): PreparedNumber => ({
    seriesCode: 'WHSL-CUST',
    candidate: `W0${n}`,
    line: { seriesCode: 'WHSL-CUST', lineNo: 1, startingNo: 'W00000', endingNo: '', lastNoUsed: `W0${n - 1}`, lastDateUsed: '', incrementByNo: 1, implementation: 'Normal', open: true, etag: 'x' },
  });
  const a = {
    prepare: vi.fn(async () => mk(start)),
    bump: vi.fn((p: PreparedNumber) => mk(Number(p.candidate.slice(1)) + 1)),
    commit: vi.fn(async () => undefined),
  };
  return a satisfies NumberAssigner;
}

const TEMPLATE: Row = {
  id: 't1', organization_id: 'org', bc_connection_id: 'conn', code: 'WHSL', no_series: 'WHSL-CUST',
  customer_posting_group: 'DOMESTIC', gen_bus_posting_group: 'DOMESTIC', customer_price_group: 'WHSL-DLVRY',
  payment_terms_code: 'NET30', tax_area_code: 'TEMPLATE-TAX', tax_liable: true, tax_identification_type: 'Legal Entity',
  application_method: 'Manual', location_code: 'MAIN',
};

const TYPED = {
  display_name: 'ZZNEXUS Test', email: 'a@b.com', phone_number: '555', payment_terms_code: 'NET10', tax_area_code: 'CA',
};

let tables: Record<string, Row[]>;
let cards: Map<string, BcRecord>;
let transport: ReturnType<typeof fakeTransport>;
let assigner: ReturnType<typeof fakeAssigner>;
let listResourcePage: ReturnType<typeof vi.fn>;
let deps: CustomerServiceDeps;

beforeEach(() => {
  tables = { business_central_customer_templates: [{ ...TEMPLATE }, { ...TEMPLATE, id: 't2', organization_id: 'other' }], business_central_customers: [] };
  cards = new Map();
  transport = fakeTransport(cards);
  assigner = fakeAssigner();
  listResourcePage = vi.fn(async (_r: string, opts: { filter?: string }) => {
    const m = /number eq '(.+)'/.exec(opts.filter ?? '');
    return m ? [{ id: `api-${m[1]}`, number: m[1], displayName: 'ZZNEXUS Test', email: 'a@b.com', '@odata.etag': 'W/"api"' }] : [];
  });
  deps = {
    supabase: fakeSupabase(tables),
    transport,
    assigner,
    bc: { listResourcePage } as unknown as CustomerServiceDeps['bc'],
    orgId: 'org',
    connectionId: 'conn',
    environment: 'TEST',
    companyId: 'comp',
    now: () => '2026-10-30T00:00:00Z',
  };
});

describe('createCustomer', () => {
  it('create applies every template field and the typed values', async () => {
    await createCustomer(deps, { templateCode: 'WHSL', values: TYPED });
    expect(transport.create).toHaveBeenCalledTimes(1);
    const body = transport.create.mock.calls[0][1];
    expect(body).toMatchObject({
      Name: 'ZZNEXUS Test', E_Mail: 'a@b.com', Phone_No: '555',
      Customer_Posting_Group: 'DOMESTIC', Gen_Bus_Posting_Group: 'DOMESTIC', Customer_Price_Group: 'WHSL-DLVRY',
      Tax_Liable: true, Tax_Identification_Type: 'Legal Entity', Application_Method: 'Manual', Location_Code: 'MAIN',
      Payment_Terms_Code: 'NET10', Tax_Area_Code: 'CA',
    });
  });

  it('create numbers from the template series, stores the GET etag and the Nexus row', async () => {
    const out = await createCustomer(deps, { templateCode: 'WHSL', values: TYPED });
    expect(assigner.prepare).toHaveBeenCalledWith('WHSL-CUST');
    expect(transport.create.mock.calls[0][1].No).toBe('W01250');
    expect(assigner.commit).toHaveBeenCalledWith(expect.objectContaining({ candidate: 'W01250' }), 'W01250', undefined);
    expect(out.number).toBe('W01250');
    expect(listResourcePage).toHaveBeenCalledWith('customers', { filter: "number eq 'W01250'", top: 1 });
    const row = tables.business_central_customers[0];
    expect(row).toMatchObject({
      id: out.id, organization_id: 'org', bc_connection_id: 'conn', bc_environment: 'TEST', bc_company_id: 'comp',
      bc_customer_id: 'api-W01250', bc_customer_number: 'W01250', payment_terms_code: 'NET10', tax_area_code: 'CA',
    });
    expect(row.bc_card_etag).toMatch(/get-/);
  });

  it('bumps the number when BC says it already exists', async () => {
    cards.set('W01250', { key: { values: { No: 'W01250' } }, etag: 'x', fields: {} });
    const out = await createCustomer(deps, { templateCode: 'WHSL', values: TYPED });
    expect(out.number).toBe('W01251');
    expect(assigner.commit).toHaveBeenCalledTimes(1);
    expect(assigner.commit).toHaveBeenCalledWith(expect.objectContaining({ candidate: 'W01251' }), 'W01251', undefined);
  });

  it('treats BC code Internal_EntityWithSameKeyExists as a duplicate number, whatever the text', async () => {
    transport.create.mockRejectedValueOnce(new BcReferenceError(400, 'Der Datensatz existiert bereits.', 'Internal_EntityWithSameKeyExists'));
    const out = await createCustomer(deps, { templateCode: 'WHSL', values: TYPED });
    expect(out.number).toBe('W01251');
    expect(transport.create).toHaveBeenCalledTimes(2);
  });

  it('a failed number-series commit after a successful POST still records the customer and warns', async () => {
    assigner.commit.mockRejectedValueOnce(new Error('No. Series busy'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await createCustomer(deps, { templateCode: 'WHSL', values: TYPED });
    expect(out.number).toBe('W01250');
    expect(out.warning).toBe('Created W01250, but the number series in Business Central could not be updated. Tell an admin.');
    expect(tables.business_central_customers).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('create validates every field', async () => {
    await expect(createCustomer(deps, { templateCode: 'WHSL', values: { ...TYPED, display_name: '' } })).rejects.toThrow('Name is required');
    expect(transport.create).not.toHaveBeenCalled();
    expect(assigner.prepare).not.toHaveBeenCalled();
  });

  it('refuses an unknown template (scoped to org)', async () => {
    tables.business_central_customer_templates = [{ ...TEMPLATE, organization_id: 'other' }];
    await expect(createCustomer(deps, { templateCode: 'WHSL', values: TYPED })).rejects.toThrow(/template/i);
    expect(transport.create).not.toHaveBeenCalled();
  });
});

function seedCustomer(): Row {
  cards.set('W00001', { key: { values: { No: 'W00001' } }, etag: 'W/"e0"', fields: { No: 'W00001', Name: 'Old', Credit_Limit_LCY: 0 } });
  const row = { id: 'c1', organization_id: 'org', bc_connection_id: 'conn', bc_customer_number: 'W00001', display_name: 'Old', email: 'a@b.com', phone_number: '1', credit_limit: 0, bc_card_etag: 'W/"e0"' };
  tables.business_central_customers.push(row);
  return { ...row };
}

describe('blocked storage', () => {
  it('create stores null blocked when API v2 returns _x0020_', async () => {
    listResourcePage.mockImplementationOnce(async (_r: string, opts: { filter?: string }) => {
      const m = /number eq '(.+)'/.exec(opts.filter ?? '');
      return [{ id: `api-${m![1]}`, number: m![1], displayName: 'ZZNEXUS Test', blocked: '_x0020_' }];
    });
    await createCustomer(deps, { templateCode: 'WHSL', values: TYPED });
    expect(tables.business_central_customers[0].blocked).toBeNull();
  });
  it('edit sends a single space to BC when set to Not blocked, stores null', async () => {
    const original = { ...seedCustomer(), blocked: 'All' };
    await updateCustomer(deps, { id: 'c1', original, edited: { ...original, blocked: null } });
    expect(transport.patch.mock.calls[0][3]).toEqual({ Blocked: ' ' });
    expect(tables.business_central_customers[0].blocked).toBeNull();
  });
});

describe('updateCustomer', () => {
  it('edit sends only changed fields', async () => {
    const original = seedCustomer();
    await updateCustomer(deps, { id: 'c1', original, edited: { ...original, credit_limit: 500 } });
    expect(transport.patch).toHaveBeenCalledTimes(1);
    expect(transport.patch.mock.calls[0][2]).toBe('W/"e0"');
    expect(transport.patch.mock.calls[0][3]).toEqual({ Credit_Limit_LCY: 500 });
    expect(tables.business_central_customers[0]).toMatchObject({ credit_limit: 500, bc_card_etag: cards.get('W00001')!.etag });
  });

  it('edit validates only changed fields', async () => {
    const original = { ...seedCustomer(), email: '' }; // old BC value is invalid
    await updateCustomer(deps, { id: 'c1', original, edited: { ...original, credit_limit: 5 } });
    expect(transport.patch).toHaveBeenCalledTimes(1);
    await expect(updateCustomer(deps, { id: 'c1', original, edited: { ...original, display_name: '' } })).rejects.toThrow('Name is required');
  });

  it('stale etag retries once', async () => {
    const original = seedCustomer();
    cards.set('W00001', { ...cards.get('W00001')!, etag: 'W/"newer"' });
    await updateCustomer(deps, { id: 'c1', original, edited: { ...original, display_name: 'New' } });
    expect(transport.patch).toHaveBeenCalledTimes(2);
    expect(transport.patch.mock.calls[1][2]).toBe('W/"newer"');
    expect(transport.patch.mock.calls[1][3]).toEqual({ Name: 'New' });
    expect(tables.business_central_customers[0].display_name).toBe('New');
  });

  it('with no stored card etag, reads the card first and uses its etag', async () => {
    const original = { ...seedCustomer(), bc_card_etag: null };
    tables.business_central_customers[0].bc_card_etag = null;
    await updateCustomer(deps, { id: 'c1', original, edited: { ...original, credit_limit: 9 } });
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(transport.patch).toHaveBeenCalledTimes(1);
    expect(transport.patch.mock.calls[0][2]).toBe('W/"e0"');
  });

  it('stores what BC returned, mapped like sync (blank Blocked -> null)', async () => {
    const original = { ...seedCustomer(), blocked: 'All' };
    transport.patch.mockImplementationOnce(async (_s, key) => {
      const next = { key, etag: 'W/"bc"', fields: { No: 'W00001', Name: 'Trimmed', Blocked: ' ', Credit_Limit_LCY: 0 } };
      cards.set('W00001', next);
      return next;
    });
    await updateCustomer(deps, { id: 'c1', original, edited: { ...original, blocked: ' ', display_name: ' Trimmed ' } });
    expect(tables.business_central_customers[0]).toMatchObject({ blocked: null, display_name: 'Trimmed', bc_card_etag: 'W/"bc"' });
  });
});

describe('deleteCustomer', () => {
  it('delete refused keeps the row and adds the Blocked hint', async () => {
    seedCustomer();
    transport.remove.mockRejectedValueOnce(new BcReferenceError(400, 'You cannot delete W00001 because it has ledger entries.'));
    await expect(deleteCustomer(deps, 'c1')).rejects.toThrow(
      'You cannot delete W00001 because it has ledger entries. You can set Blocked to All instead.',
    );
    expect(tables.business_central_customers).toHaveLength(1);
  });

  it('delete removes the Nexus row on success', async () => {
    seedCustomer();
    await deleteCustomer(deps, 'c1');
    expect(transport.remove.mock.calls[0][2]).toBe('W/"e0"');
    expect(cards.has('W00001')).toBe(false);
    expect(tables.business_central_customers).toHaveLength(0);
  });

  it('with no stored card etag, reads the card first and deletes with its etag', async () => {
    seedCustomer();
    tables.business_central_customers[0].bc_card_etag = '';
    await deleteCustomer(deps, 'c1');
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(transport.remove.mock.calls[0][2]).toBe('W/"e0"');
    expect(tables.business_central_customers).toHaveLength(0);
  });

  it('a 404 from BC on delete means already gone: removes the Nexus row, no Blocked hint', async () => {
    seedCustomer();
    transport.remove.mockRejectedValueOnce(new BcReferenceError(404, 'The record does not exist.'));
    await deleteCustomer(deps, 'c1');
    expect(tables.business_central_customers).toHaveLength(0);
  });
});
