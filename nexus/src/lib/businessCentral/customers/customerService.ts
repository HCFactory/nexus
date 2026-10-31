import type { SupabaseClient } from '@supabase/supabase-js';
import type { FieldSpec } from '@/types/customerReferences';
import type { BcClient } from '../client';
import { mapBcCustomerToDb, type BcCustomer } from '../customerMapper';
import { BcConflictError, BcReferenceError } from '../customerReferences/errors';
import { changedFields } from '../customerReferences/merge';
import type { BcKey, BcRecord, ReferenceTransport } from '../customerReferences/transport';
import { validateEntry } from '../customerReferences/validation';
import type { NumberAssigner } from '../numberAssigner';
import { CUSTOMER_FIELDS, TEMPLATE_TO_CUSTOMER } from './customerFields';
import { CUSTOMER_CARD_SOURCE, mapCardToCustomerColumns } from './customerCardFill';

export interface CustomerServiceDeps {
  supabase: SupabaseClient;
  /** Writes go to OData Customer_Card_Excel (CUSTOMER_CARD_SOURCE). */
  transport: ReferenceTransport;
  assigner: NumberAssigner;
  /** API v2 client, used to read the new customer's id after a create. */
  bc: Pick<BcClient, 'listResourcePage'>;
  orgId: string;
  connectionId: string;
  environment: string;
  companyId: string;
  now: () => string;
  /** Local date (YYYY-MM-DD) for the No. Series Last_Date_Used; omit for UTC. */
  today?: string;
}

type DbRow = Record<string, unknown>;

const TABLE = 'business_central_customers';
const MAX_DUPLICATE_RETRIES = 5;
const BLOCKED_HINT = ' You can set Blocked to All instead.';
const CHANGED_AGAIN = 'This customer changed in Business Central again while saving. Try again.';
const DELETE_CONFLICT = 'This customer changed in Business Central. Press Sync and try again.';

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

function toBcValue(f: FieldSpec, v: unknown): unknown {
  if (f.type === 'boolean') return Boolean(v);
  if (f.type === 'number') return v === null || v === undefined || v === '' ? 0 : Number(v);
  return v === null || v === undefined ? '' : String(v);
}

function toBcFields(names: string[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CUSTOMER_FIELDS) if (names.includes(f.name)) out[f.bcName] = toBcValue(f, values[f.name]);
  return out;
}

function assertValid(fields: FieldSpec[], values: Record<string, unknown>): void {
  const problems = validateEntry(fields, values);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

function isDuplicateNumber(err: unknown): boolean {
  return err instanceof BcReferenceError && (err.status === 409 || /already exists|duplicate/i.test(err.bcMessage));
}

function recordedInBcOnly(number: string): Error {
  return new Error(`Customer ${number} was created in Business Central, but Nexus could not record it. Press Sync.`);
}

async function loadTemplate(deps: CustomerServiceDeps, code: string): Promise<DbRow> {
  const { data, error } = await deps.supabase
    .from('business_central_customer_templates')
    .select('*')
    .eq('code', code)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Customer template ${code} was not found. Press Sync on the templates list.`);
  return data as DbRow;
}

async function loadRow(deps: CustomerServiceDeps, id: string): Promise<DbRow> {
  const { data, error } = await deps.supabase
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Customer not found');
  return data as DbRow;
}

function cardKey(row: DbRow): BcKey {
  const number = row.bc_customer_number;
  if (!number) throw new Error('This customer has no number in Business Central yet. Press Sync and try again.');
  return { values: { No: String(number) } };
}

export async function createCustomer(
  deps: CustomerServiceDeps,
  input: { templateCode: string; values: Record<string, unknown> },
): Promise<{ id: string; number: string; warning?: string }> {
  const template = await loadTemplate(deps, input.templateCode);

  // Template values first; anything the user typed (non-blank) wins.
  const merged: Record<string, unknown> = {};
  for (const [templateCol, customerCol] of Object.entries(TEMPLATE_TO_CUSTOMER)) merged[customerCol] = template[templateCol];
  for (const [k, v] of Object.entries(input.values)) {
    if (k in merged && isBlank(v)) continue;
    merged[k] = v;
  }
  // Creates validate every field.
  assertValid(CUSTOMER_FIELDS, merged);

  const series = String(template.no_series ?? '').trim();
  if (!series) throw new Error(`Customer template ${input.templateCode} has no number series. Set one in Business Central.`);

  const sent = Object.keys(merged).filter((k) => CUSTOMER_FIELDS.some((f) => f.name === k));
  const body = toBcFields(sent, merged);

  let prepared = await deps.assigner.prepare(series);
  let created: BcRecord | null = null;
  for (let attempt = 0; attempt < MAX_DUPLICATE_RETRIES && !created; attempt += 1) {
    try {
      created = await deps.transport.create(CUSTOMER_CARD_SOURCE, { No: prepared.candidate, ...body });
    } catch (err) {
      if (!isDuplicateNumber(err)) throw err; // no commit, no number burned
      prepared = deps.assigner.bump(prepared);
    }
  }
  if (!created) throw new Error(`Could not find a free number in series '${series}' after ${MAX_DUPLICATE_RETRIES} attempts`);
  const number = 'values' in created.key && created.key.values.No ? created.key.values.No : prepared.candidate;
  await deps.assigner.commit(prepared, number, deps.today);

  // BC can touch the record right after the POST; read it back for a fresh etag.
  const card = await deps.transport.get(CUSTOMER_CARD_SOURCE, { values: { No: number } }).catch(() => created as BcRecord);

  let apiCustomer: BcCustomer | undefined;
  try {
    [apiCustomer] = await deps.bc.listResourcePage<BcCustomer>('customers', { filter: `number eq '${number.replace(/'/g, "''")}'`, top: 1 });
  } catch (err) {
    console.error('[customers] could not read the new customer from API v2:', err instanceof Error ? err.message : err);
  }
  if (!apiCustomer) throw recordedInBcOnly(number);

  const now = deps.now();
  const { data, error } = await deps.supabase
    .from(TABLE)
    .insert({
      ...mapBcCustomerToDb({
        organizationId: deps.orgId,
        connectionId: deps.connectionId,
        environment: deps.environment,
        companyId: deps.companyId,
        customer: apiCustomer,
        now,
      }),
      ...mapCardToCustomerColumns(card),
      created_at: now,
    })
    .select()
    .single();
  if (error || !data) {
    console.error('[customers] BC created the customer but the Nexus insert failed:', error?.message);
    throw recordedInBcOnly(number);
  }
  return { id: String((data as DbRow).id), number };
}

export async function updateCustomer(
  deps: CustomerServiceDeps,
  input: { id: string; original: Record<string, unknown>; edited: Record<string, unknown> },
): Promise<void> {
  const row = await loadRow(deps, input.id);
  const changed = changedFields(input.original, input.edited, CUSTOMER_FIELDS);
  if (changed.length === 0) return;
  // Edits validate only what changed: an old BC value must never block an unrelated edit.
  assertValid(CUSTOMER_FIELDS.filter((f) => changed.includes(f.name)), input.edited);

  const body = toBcFields(changed, input.edited);
  const key = cardKey(row);
  let record: BcRecord;
  try {
    record = await deps.transport.patch(CUSTOMER_CARD_SOURCE, key, (row.bc_card_etag as string | null) ?? '', body);
  } catch (err) {
    if (!(err instanceof BcConflictError)) throw err;
    const fresh = await deps.transport.get(CUSTOMER_CARD_SOURCE, key);
    try {
      record = await deps.transport.patch(CUSTOMER_CARD_SOURCE, key, fresh.etag, body);
    } catch (err2) {
      if (err2 instanceof BcConflictError) throw new Error(CHANGED_AGAIN);
      throw err2;
    }
  }

  const patch: DbRow = { bc_card_etag: record.etag || null, updated_at: deps.now() };
  for (const name of changed) patch[name] = input.edited[name];
  const { error } = await deps.supabase
    .from(TABLE)
    .update(patch)
    .eq('id', input.id)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId);
  if (error) {
    console.error('[customers] BC saved the change but the Nexus update failed:', error.message);
    throw new Error('Saved in Business Central, but Nexus could not record it. Press Sync.');
  }
}

export async function deleteCustomer(deps: CustomerServiceDeps, id: string): Promise<void> {
  const row = await loadRow(deps, id);
  try {
    await deps.transport.remove(CUSTOMER_CARD_SOURCE, cardKey(row), (row.bc_card_etag as string | null) ?? '');
  } catch (err) {
    if (err instanceof BcConflictError) throw new Error(DELETE_CONFLICT);
    if (err instanceof BcReferenceError && err.status >= 400 && err.status < 500) {
      throw new Error(`${err.bcMessage}${BLOCKED_HINT}`);
    }
    throw err;
  }
  const { error } = await deps.supabase
    .from(TABLE)
    .delete()
    .eq('id', id)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.connectionId);
  if (error) throw new Error(error.message);
}
