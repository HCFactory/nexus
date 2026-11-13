import type { SupabaseClient } from '@supabase/supabase-js';
import type { ShipToRow, ShipToValues } from '@/types/salesOrders';
import { BcConflictError, BcReferenceError } from '../customerReferences/errors';
import type { BcKey, BcRecord, ReferenceTransport } from '../customerReferences/transport';
import { CUSTOMER_CARD_SOURCE } from '../customers/customerCardFill';
import { makeShipToCode } from './shipToCode';
import { SHIP_TO_FIELDS, SHIP_TO_SOURCE } from './shipToSource';

export interface ShipToDeps {
  supabase: SupabaseClient;
  transport: ReferenceTransport;
  orgId: string;
  connectionId: string;
  now: () => string;
}

type DbRow = Record<string, unknown>;
type ValueKey = Exclude<keyof ShipToValues, 'code'>;

const TABLE = 'customer_ship_to_addresses';
const CUSTOMERS = 'business_central_customers';
const MAX_CODE = 10;
const FIELD_ENTRIES = Object.entries(SHIP_TO_FIELDS) as [ValueKey, string][];

const shipKey = (customerNumber: string, code: string): BcKey => ({ values: { Customer_No: customerNumber, Code: code } });
const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

function toBcValue(col: ValueKey, v: unknown): unknown {
  if (col === 'tax_liable') return Boolean(v);
  return v === null || v === undefined ? '' : String(v);
}

function fromBcValue(col: ValueKey, v: unknown): string | boolean {
  if (col === 'tax_liable') return v === true;
  return v === null || v === undefined ? '' : String(v);
}

/** Local column values for a BC record. */
function recordToColumns(record: BcRecord): Record<ValueKey, string | boolean> {
  const out = {} as Record<ValueKey, string | boolean>;
  for (const [col, bcName] of FIELD_ENTRIES) out[col] = fromBcValue(col, record.fields[bcName]);
  return out;
}

function scoped<T extends { eq: (k: string, v: unknown) => T }>(q: T, deps: ShipToDeps): T {
  return q.eq('organization_id', deps.orgId).eq('bc_connection_id', deps.connectionId);
}

async function loadShipTo(deps: ShipToDeps, id: string): Promise<DbRow> {
  const { data, error } = await scoped(deps.supabase.from(TABLE).select('*').eq('id', id), deps).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Ship-to address not found');
  return data as DbRow;
}

async function loadCustomer(deps: ShipToDeps, customerNumber: string): Promise<DbRow | null> {
  const { data, error } = await scoped(
    deps.supabase.from(CUSTOMERS).select('*').eq('bc_customer_number', customerNumber),
    deps,
  ).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as DbRow | null) ?? null;
}

async function storedOrFreshEtag(deps: ShipToDeps, stored: unknown, source: typeof SHIP_TO_SOURCE, key: BcKey): Promise<string> {
  if (typeof stored === 'string' && stored.trim() !== '') return stored;
  return (await deps.transport.get(source, key)).etag;
}

/** Patch with the stored etag; on a conflict re-read the etag and overwrite (Nexus wins). */
async function patchNexusWins(
  deps: ShipToDeps,
  source: typeof SHIP_TO_SOURCE,
  key: BcKey,
  stored: unknown,
  fields: Record<string, unknown>,
): Promise<BcRecord> {
  try {
    return await deps.transport.patch(source, key, await storedOrFreshEtag(deps, stored, source, key), fields);
  } catch (err) {
    if (!(err instanceof BcConflictError)) throw err;
    const fresh = await deps.transport.get(source, key);
    return deps.transport.patch(source, key, fresh.etag, fields);
  }
}

async function codesTaken(deps: ShipToDeps, customerNumber: string): Promise<Set<string>> {
  const { data, error } = await deps.supabase
    .from(TABLE)
    .select('code')
    .eq('customer_number', customerNumber)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId);
  if (error) throw new Error(error.message);
  return new Set(((data ?? []) as DbRow[]).map((r) => String(r.code)));
}

export async function saveShipTo(
  deps: ShipToDeps,
  input: { id?: string; customerNumber: string; code?: string; values: ShipToValues },
): Promise<ShipToRow> {
  if (input.id) return updateShipTo(deps, input.id, input.values);

  const typed = (input.code ?? input.values.code ?? '').trim().toUpperCase();
  if (typed.length > MAX_CODE) throw new Error('Ship-to code must be 10 characters or fewer.');
  const code = typed || makeShipToCode(input.values.address, await codesTaken(deps, input.customerNumber));

  const body: Record<string, unknown> = { Customer_No: input.customerNumber, Code: code };
  for (const [col, bcName] of FIELD_ENTRIES) body[bcName] = toBcValue(col, input.values[col]);
  const record = await deps.transport.create(SHIP_TO_SOURCE, body);

  const now = deps.now();
  const { data, error } = await deps.supabase
    .from(TABLE)
    .insert({
      organization_id: deps.orgId,
      bc_connection_id: deps.connectionId,
      customer_number: input.customerNumber,
      code,
      ...recordToColumns(record),
      bc_etag: record.etag,
      last_synced_at: now,
    })
    .select()
    .single();
  if (error || !data) {
    console.error('[ship-to] BC created the ship-to but the Nexus insert failed:', error?.message);
    throw new Error('Saved in Business Central, but Nexus could not record it. Press Sync.');
  }
  return data as ShipToRow;
}

async function updateShipTo(deps: ShipToDeps, id: string, values: ShipToValues): Promise<ShipToRow> {
  const row = await loadShipTo(deps, id);
  const changed = FIELD_ENTRIES.filter(([col]) => values[col] !== row[col]);
  if (changed.length === 0) return row as unknown as ShipToRow;

  const body: Record<string, unknown> = {};
  for (const [col, bcName] of changed) body[bcName] = toBcValue(col, values[col]);
  const key = shipKey(String(row.customer_number), String(row.code));
  const record = await patchNexusWins(deps, SHIP_TO_SOURCE, key, row.bc_etag, body);

  const now = deps.now();
  const { data, error } = await scoped(
    deps.supabase
      .from(TABLE)
      .update({ ...recordToColumns(record), bc_etag: record.etag, last_synced_at: now, updated_at: now })
      .eq('id', id),
    deps,
  )
    .select()
    .single();
  if (error || !data) {
    console.error('[ship-to] BC saved the change but the Nexus update failed:', error?.message);
    throw new Error('Saved in Business Central, but Nexus could not record it. Press Sync.');
  }
  return data as ShipToRow;
}

export async function setDefaultShipTo(deps: ShipToDeps, customerNumber: string, code: string | ''): Promise<void> {
  const customer = await loadCustomer(deps, customerNumber);
  if (!customer) throw new Error('Customer not found');
  const key: BcKey = { values: { No: customerNumber } };
  const stored = customer.bc_card_etag;
  const fields = { Ship_to_Code: code };
  let record: BcRecord;
  try {
    const etag =
      typeof stored === 'string' && stored.trim() !== '' ? stored : (await deps.transport.get(CUSTOMER_CARD_SOURCE, key)).etag;
    record = await deps.transport.patch(CUSTOMER_CARD_SOURCE, key, etag, fields);
  } catch (err) {
    if (!(err instanceof BcConflictError)) throw err;
    const fresh = await deps.transport.get(CUSTOMER_CARD_SOURCE, key);
    record = await deps.transport.patch(CUSTOMER_CARD_SOURCE, key, fresh.etag, fields);
  }
  const { error } = await scoped(
    deps.supabase
      .from(CUSTOMERS)
      .update({ ship_to_code: code, bc_card_etag: record.etag, updated_at: deps.now() })
      .eq('id', String(customer.id)),
    deps,
  );
  if (error) {
    console.error('[ship-to] BC saved the default but the Nexus update failed:', error.message);
    throw new Error('Saved in Business Central, but Nexus could not record it. Press Sync.');
  }
}

export async function deleteShipTo(deps: ShipToDeps, id: string): Promise<void> {
  const row = await loadShipTo(deps, id);
  const customerNumber = String(row.customer_number);
  const code = String(row.code);

  // BC will not drop a ship-to a customer still uses as its default, so clear that first.
  const customer = await loadCustomer(deps, customerNumber);
  if (customer && customer.ship_to_code === code) await setDefaultShipTo(deps, customerNumber, '');

  const key = shipKey(customerNumber, code);
  try {
    try {
      await deps.transport.remove(SHIP_TO_SOURCE, key, await storedOrFreshEtag(deps, row.bc_etag, SHIP_TO_SOURCE, key));
    } catch (err) {
      if (!(err instanceof BcConflictError)) throw err;
      const fresh = await deps.transport.get(SHIP_TO_SOURCE, key);
      await deps.transport.remove(SHIP_TO_SOURCE, key, fresh.etag);
    }
  } catch (err) {
    // 404: already gone from BC; still remove the Nexus row.
    if (!(err instanceof BcReferenceError && err.status === 404)) throw err;
  }
  const { error } = await scoped(deps.supabase.from(TABLE).delete().eq('id', id), deps);
  if (error) throw new Error(error.message);
}

export async function pullShipTos(deps: ShipToDeps, customerNumber?: string): Promise<{ upserted: number; deleted: number }> {
  const remote = await deps.transport.list(
    SHIP_TO_SOURCE,
    customerNumber ? { filter: `Customer_No eq ${quote(customerNumber)}` } : {},
  );

  const base = deps.supabase
    .from(TABLE)
    .select('*')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId);
  const { data, error } = await (customerNumber ? base.eq('customer_number', customerNumber) : base);
  if (error) throw new Error(error.message);
  const local = new Map<string, DbRow>();
  for (const r of (data ?? []) as DbRow[]) local.set(`${r.customer_number}\u0000${r.code}`, r);

  let upserted = 0;
  const seen = new Set<string>();
  for (const record of remote) {
    if (!('values' in record.key)) continue;
    const cust = record.key.values.Customer_No;
    const code = record.key.values.Code;
    const k = `${cust}\u0000${code}`;
    seen.add(k);
    const existing = local.get(k);
    const now = deps.now();
    if (!existing) {
      const { error: e } = await deps.supabase.from(TABLE).insert({
        organization_id: deps.orgId,
        bc_connection_id: deps.connectionId,
        customer_number: cust,
        code,
        ...recordToColumns(record),
        bc_etag: record.etag,
        last_synced_at: now,
      });
      if (e) throw new Error(e.message);
      upserted += 1;
    } else if (existing.bc_etag !== record.etag) {
      // BC changed after Nexus last wrote or read it: BC's version wins.
      const { error: e } = await scoped(
        deps.supabase
          .from(TABLE)
          .update({ ...recordToColumns(record), bc_etag: record.etag, last_synced_at: now, updated_at: now })
          .eq('id', String(existing.id)),
        deps,
      );
      if (e) throw new Error(e.message);
      upserted += 1;
    }
  }

  let deleted = 0;
  for (const [k, row] of local) {
    if (seen.has(k)) continue;
    const { error: e } = await scoped(deps.supabase.from(TABLE).delete().eq('id', String(row.id)), deps);
    if (e) throw new Error(e.message);
    deleted += 1;
  }
  return { upserted, deleted };
}
