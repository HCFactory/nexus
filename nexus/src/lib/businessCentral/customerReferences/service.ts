import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReferenceEntry } from '@/types/customerReferences';
import type { ListDefinition } from './listDefinition';
import { BcConflictError, ReferenceInUseError } from './errors';
import { changedFields, planSyncPull, type LocalRow } from './merge';
import { toBcFields, toDbValues } from './mapping';
import type { BcKey, BcRecord, ReferenceTransport } from './transport';
import { validateEntry } from './validation';

export interface ServiceDeps {
  supabase: SupabaseClient;
  transport: ReferenceTransport;
  orgId: string;
  connectionId: string;
  now: () => string;
  /** null = unused; otherwise a message such as 'Used by 12 customers'. */
  countUsage: (def: ListDefinition, row: LocalRow) => Promise<string | null>;
}

type DbRow = Record<string, unknown>;

function toLocalRow(def: ListDefinition, row: DbRow): LocalRow {
  const keyValues: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const f of def.fields) {
    values[f.name] = row[f.name];
    if (f.isKey) keyValues[f.name] = row[f.name] == null ? '' : String(row[f.name]);
  }
  return {
    id: String(row.id),
    bcId: (row.bc_id as string | null) ?? null,
    keyValues,
    values,
    etag: (row.bc_etag as string | null) ?? null,
  };
}

function keyForRow(def: ListDefinition, row: DbRow): BcKey {
  if (def.source.kind === 'api') return { bcId: String(row.bc_id) };
  const values: Record<string, string> = {};
  for (const f of def.fields) if (f.isKey) values[f.bcName] = row[f.name] == null ? '' : String(row[f.name]);
  return { values };
}

function toEntry(def: ListDefinition, row: DbRow): ReferenceEntry {
  const values: Record<string, unknown> = {};
  for (const f of def.fields) values[f.name] = row[f.name] ?? null;
  return {
    id: String(row.id),
    values,
    bcLastModifiedAt: (row.bc_last_modified_at as string | null) ?? null,
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
  };
}

function rowFromRecord(def: ListDefinition, record: BcRecord, now: string): DbRow {
  const modified = record.fields.lastModifiedDateTime;
  return {
    ...toDbValues(def, record),
    bc_id: 'bcId' in record.key ? record.key.bcId : null,
    bc_etag: record.etag,
    bc_last_modified_at: typeof modified === 'string' && modified ? modified : null,
    last_synced_at: now,
  };
}

async function loadRow(deps: ServiceDeps, def: ListDefinition, id: string): Promise<DbRow> {
  const { data, error } = await deps.supabase
    .from(def.table)
    .select('*')
    .eq('id', id)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Entry not found');
  return data as DbRow;
}

async function updateRow(deps: ServiceDeps, def: ListDefinition, id: string, patch: DbRow): Promise<DbRow> {
  const { data, error } = await deps.supabase
    .from(def.table)
    .update({ ...patch, updated_at: deps.now() })
    .eq('id', id)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as DbRow;
}

async function insertRow(deps: ServiceDeps, def: ListDefinition, record: BcRecord): Promise<DbRow> {
  const now = deps.now();
  const { data, error } = await deps.supabase
    .from(def.table)
    .insert({
      organization_id: deps.orgId,
      bc_connection_id: deps.connectionId,
      ...rowFromRecord(def, record, now),
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as DbRow;
}

export async function saveEntry(
  deps: ServiceDeps,
  def: ListDefinition,
  input: { id: string | null; original: Record<string, unknown> | null; edited: Record<string, unknown> },
): Promise<ReferenceEntry> {
  const problems = validateEntry(def.fields, input.edited);
  if (problems.length > 0) throw new Error(problems.join('\n'));

  if (input.id === null) {
    const record = await deps.transport.create(def.source, toBcFields(def, input.edited));
    return toEntry(def, await insertRow(deps, def, record));
  }

  const row = await loadRow(deps, def, input.id);
  const changed = changedFields(input.original ?? toLocalRow(def, row).values, input.edited, def.fields);
  if (changed.length === 0) return toEntry(def, row);

  const body = toBcFields(def, Object.fromEntries(changed.map((name) => [name, input.edited[name]])));
  const key = keyForRow(def, row);
  let record: BcRecord;
  try {
    record = await deps.transport.patch(def.source, key, (row.bc_etag as string | null) ?? '', body);
  } catch (err) {
    if (!(err instanceof BcConflictError)) throw err;
    const fresh = await deps.transport.get(def.source, key);
    try {
      record = await deps.transport.patch(def.source, key, fresh.etag, body);
    } catch (err2) {
      if (err2 instanceof BcConflictError) {
        throw new Error('This entry changed in Business Central again while saving. Try again.');
      }
      throw err2;
    }
  }
  return toEntry(def, await updateRow(deps, def, input.id, rowFromRecord(def, record, deps.now())));
}

export async function deleteEntry(deps: ServiceDeps, def: ListDefinition, id: string): Promise<void> {
  if (def.deleteDisabledReason) throw new Error(def.deleteDisabledReason);
  const row = await loadRow(deps, def, id);
  const usage = await deps.countUsage(def, toLocalRow(def, row));
  if (usage) throw new ReferenceInUseError(usage);

  await deps.transport.remove(def.source, keyForRow(def, row), (row.bc_etag as string | null) ?? '');

  const scope = (q: any) => q.eq('organization_id', deps.orgId).eq('bc_connection_id', deps.connectionId);
  const { error } = await scope(deps.supabase.from(def.table).delete().eq('id', id));
  if (error) throw new Error(error.message);

  if (def.key === 'taxAreas') {
    const res = await scope(
      deps.supabase.from('business_central_tax_area_lines').delete().eq('tax_area_code', row.code as string),
    );
    if (res.error) throw new Error(res.error.message);
  }
}

export async function syncList(
  deps: ServiceDeps,
  def: ListDefinition,
): Promise<{ inserted: number; updated: number; deleted: number }> {
  const remote = await deps.transport.list(def.source);
  const { data, error } = await deps.supabase
    .from(def.table)
    .select('*')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as DbRow[];
  const plan = planSyncPull(def, rows.map((r) => toLocalRow(def, r)), remote);

  for (const record of plan.inserts) await insertRow(deps, def, record);
  for (const u of plan.updates) await updateRow(deps, def, u.id, rowFromRecord(def, u.record, deps.now()));
  for (const id of plan.deletes) {
    const res = await deps.supabase
      .from(def.table)
      .delete()
      .eq('id', id)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.connectionId);
    if (res.error) throw new Error(res.error.message);
  }
  return { inserted: plan.inserts.length, updated: plan.updates.length, deleted: plan.deletes.length };
}
