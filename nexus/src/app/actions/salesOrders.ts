'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { createBcClientForOrg } from '@/lib/businessCentral/client';
import { createReferenceTransport } from '@/lib/businessCentral/customerReferences/transport';
import { requireActiveBusinessCentralScope } from '@/lib/businessCentral/environmentScope';
import {
  claimOrder,
  leaseUntil,
  releaseOrder,
  sweepPendingOrders,
  syncWithClaim,
} from '@/lib/salesOrders/orderClaim';
import { canChangeStatus, canDelete, editableFields, todayIn } from '@/lib/salesOrders/orderRules';
import { deleteSalesOrderInBc, findBcOrderByMarker, type OrderSyncDeps } from '@/lib/salesOrders/orderSync';
import { SAVE_UNFINISHED, isUnfinishedSave } from '@/lib/salesOrders/saveMarker';
import { fetchAll } from '@/lib/supabase/fetchAll';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { ListKey } from '@/types/customerReferences';
import type {
  CustomerRow,
  LineDraft,
  OrderStatus,
  SalesOrderInput,
  SalesOrderLineRow,
  SalesOrderListRow,
  SalesOrderRow,
  SyncState,
} from '@/types/salesOrders';
import { getSelectOptions } from './customerReferenceLists';

type Fail = { ok: false; error: string };
type Scope = Awaited<ReturnType<typeof requireActiveBusinessCentralScope>>;
type Option = { code: string; label: string };

export interface SalesOrderItemOption {
  bc_item_number: string;
  display_name: string;
  unit_price: number | null;
  base_unit_of_measure_code: string | null;
}

export interface SalesOrderFormContext {
  customers: CustomerRow[];
  items: SalesOrderItemOption[];
  selectOptions: Record<string, Option[]>;
  companyLocation: string;
  today: string;
}

const ORDERS = 'sales_orders';
const LINES = 'sales_order_lines';

const NO_PERMISSION = "You don't have permission to change sales orders";
const NOT_FOUND = 'Sales order not found.';
const BUSY = 'This order is being sent to BC. Try again in a moment.';
const HAND_STATUS_ONLY = 'Shipped and Invoiced are set by the Ship and Create invoice buttons.';
const DELETE_RULE = 'Only Draft or Final orders can be deleted.';
const CHANGED_ELSEWHERE = 'This order was changed by someone else. Reload and try again.';
const LINE_GONE = 'A line on this order no longer exists. Reload and try again.';
const CUSTOMER_BAD = 'Customer not found or blocked.';
const NOT_SAVED = 'This order was not saved completely. Save it again before sending to BC.';

const STATUS_LABELS: Record<OrderStatus, string> = {
  draft: 'Draft',
  final: 'Final',
  pulled: 'Pulled',
  shipped: 'Shipped',
  invoiced: 'Invoiced',
};
const lockedMessage = (s: OrderStatus) => `This order is ${STATUS_LABELS[s]}. Move it back to Draft to change it.`;

const SELECT_KEYS: ListKey[] = [
  'paymentTerms',
  'taxAreas',
  'generalBusinessPostingGroups',
  'customerPostingGroups',
  'shipmentMethods',
];

/** Header columns copied from the input (status and notes are handled separately). */
const HEADER_FIELDS = [
  'customer_id', 'customer_number', 'order_date', 'requested_delivery_date', 'invoice_number', 'customer_po',
  'bill_name', 'bill_address', 'bill_address_2', 'bill_city', 'bill_state', 'bill_post_code', 'bill_country',
  'bill_contact_no', 'bill_phone', 'bill_mobile', 'bill_email', 'bill_email_cc',
  'ship_to_code', 'ship_to_name', 'ship_to_address', 'ship_to_address_2', 'ship_to_city', 'ship_to_state',
  'ship_to_post_code', 'ship_to_country', 'ship_to_contact', 'ship_to_phone',
  'payment_terms_code', 'tax_area_code', 'gen_bus_posting_group', 'customer_posting_group',
  'shipment_method_code', 'location_code', 'tax_liable',
] as const satisfies readonly (keyof SalesOrderInput & keyof SalesOrderRow)[];

const CUSTOMER_COLUMNS = [
  'id', 'bc_customer_number', 'display_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code',
  'country', 'phone_number', 'email', 'email_cc', 'contact_no', 'mobile_phone_no', 'ship_to_code',
  'shipment_method_code', 'payment_terms_code', 'tax_area_code', 'tax_liable', 'customer_posting_group',
  'gen_bus_posting_group', 'location_code',
].join(', ');

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nowIso = () => new Date().toISOString();

function revalidateSalesOrders() {
  // 'layout' also refreshes /sales-orders/[id] and /sales-orders/new.
  revalidatePath('/sales-orders', 'layout');
}

async function editScope(): Promise<Scope | null> {
  const scope = await requireActiveBusinessCentralScope();
  return scope.access.canEditSalesOrders && scope.access.canViewSalesOrders ? scope : null;
}

async function viewScope(): Promise<Scope | null> {
  try {
    const scope = await requireActiveBusinessCentralScope();
    return scope.access.canViewSalesOrders ? scope : null;
  } catch {
    return null; // no Business Central environment selected
  }
}

const timeZoneOf = (scope: Scope) => (scope.connection as { time_zone?: string | null } | null)?.time_zone ?? null;

async function buildDeps(scope: Scope): Promise<OrderSyncDeps> {
  const bc = await createBcClientForOrg(scope.orgId, scope.bcConnectionId);
  const company = await bc.getCompany(bc.config.companyId);
  return {
    supabase: createServiceClient(),
    transport: createReferenceTransport(bc, company.name),
    orgId: scope.orgId,
    connectionId: scope.bcConnectionId,
    now: nowIso,
  };
}

/**
 * Waits between background attempts when the order is claimed by another run
 * or ends 'pending' (edited mid-sync). 21s in all, well inside LEASE_MS, so a
 * normal sync holding the claim has finished by the last attempt.
 */
const RETRY_DELAYS_MS = [3_000, 6_000, 12_000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sync the order after the response is sent, retrying a few times while the
 * claim is held or the result is 'pending'. Never throws; a missed sync is
 * picked up by the list sweep.
 */
function syncInBackground(scope: Scope, orderId: string) {
  after(async () => {
    try {
      const deps = await buildDeps(scope);
      for (let attempt = 0; ; attempt += 1) {
        const state = await syncWithClaim(deps, orderId);
        if ((state !== null && state !== 'pending') || attempt >= RETRY_DELAYS_MS.length) break;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    } catch (e) {
      console.error(`[sales-orders] background sync of ${orderId} failed:`, e);
    }
  });
}

async function loadOrder(scope: Scope, id: string): Promise<SalesOrderRow | null> {
  const { data, error } = await createServiceClient()
    .from(ORDERS)
    .select('*')
    .eq('id', id)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the sales order: ${error.message}`);
  return (data as SalesOrderRow | null) ?? null;
}

async function loadLines(scope: Scope, orderId: string): Promise<SalesOrderLineRow[]> {
  const { data, error } = await createServiceClient()
    .from(LINES)
    .select('*')
    .eq('sales_order_id', orderId)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .order('position', { ascending: true });
  if (error) throw new Error(`Could not load the sales order lines: ${error.message}`);
  return (data ?? []) as SalesOrderLineRow[];
}

// ---------------------------------------------------------------- reads

/** Orders for the active connection, newest first. Schedules a background sweep of unsent orders. */
export async function listSalesOrders(): Promise<SalesOrderListRow[]> {
  const scope = await viewScope();
  if (!scope) return [];
  const supabase = await createClient();
  const rows = await fetchAll<Record<string, unknown>>(
    () =>
      supabase
        .from(ORDERS)
        .select(
          'id, status, customer_id, customer_number, bill_name, order_date, requested_delivery_date, invoice_number, ' +
            'bc_order_number, customer_po, total_incl_tax, sync_state, sync_error, customer:business_central_customers(display_name)',
        )
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId)
        .order('order_date', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: true }),
    1000,
    'sales orders',
  );
  const list: SalesOrderListRow[] = rows.map((r) => {
    const customer = r.customer as { display_name?: string } | null | undefined;
    return {
      id: String(r.id),
      status: r.status as OrderStatus,
      customer_id: String(r.customer_id),
      customer_number: String(r.customer_number ?? ''),
      customer_name: customer?.display_name || String(r.bill_name ?? ''),
      order_date: String(r.order_date),
      requested_delivery_date: (r.requested_delivery_date as string | null) ?? null,
      invoice_number: (r.invoice_number as string | null) ?? null,
      bc_order_number: (r.bc_order_number as string | null) ?? null,
      customer_po: String(r.customer_po ?? ''),
      total_incl_tax: r.total_incl_tax === null || r.total_incl_tax === undefined ? null : Number(r.total_incl_tax),
      sync_state: r.sync_state as SyncState,
      sync_error: (r.sync_error as string | null) ?? null,
    };
  });

  if (list.some((r) => r.sync_state === 'pending' || r.sync_state === 'failed')) {
    after(async () => {
      try {
        await sweepPendingOrders(await buildDeps(scope));
      } catch (e) {
        console.error('[sales-orders] background sweep failed:', e);
      }
    });
  }
  return list;
}

/** One order with its lines (lines waiting to be removed in BC are left out); null if not visible. */
export async function getSalesOrder(
  id: string,
): Promise<{ order: SalesOrderRow; lines: SalesOrderLineRow[] } | null> {
  const scope = await viewScope();
  if (!scope) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(ORDERS)
    .select('*')
    .eq('id', id)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the sales order: ${error.message}`);
  if (!data) return null;
  const lines = await supabase
    .from(LINES)
    .select('*')
    .eq('sales_order_id', id)
    .eq('organization_id', scope.orgId)
    .eq('bc_connection_id', scope.bcConnectionId)
    .eq('removed', false)
    .order('position', { ascending: true });
  if (lines.error) throw new Error(`Could not load the sales order lines: ${lines.error.message}`);
  return { order: data as SalesOrderRow, lines: (lines.data ?? []) as SalesOrderLineRow[] };
}

/** The most-used non-empty location_code across the customers, or ''. */
function mostUsedLocation(customers: CustomerRow[]): string {
  const counts = new Map<string, number>();
  for (const c of customers) {
    const code = (c.location_code ?? '').trim();
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [code, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) [best, bestCount] = [code, n];
  }
  return best;
}

/** Everything the order form needs: customers, sellable items, dropdowns, default location, today. */
export async function getSalesOrderFormContext(): Promise<SalesOrderFormContext> {
  const scope = await viewScope();
  if (!scope) return { customers: [], items: [], selectOptions: {}, companyLocation: '', today: todayIn(null) };
  const supabase = await createClient();

  const [customers, items, lists] = await Promise.all([
    fetchAll<CustomerRow>(
      () =>
        supabase
          .from('business_central_customers')
          .select(CUSTOMER_COLUMNS)
          .eq('organization_id', scope.orgId)
          .eq('bc_connection_id', scope.bcConnectionId)
          .not('bc_customer_number', 'is', null)
          // Blocked customers can't take new orders; "not blocked" is stored as null (normalizeBlocked).
          .is('blocked', null)
          .order('display_name', { ascending: true })
          .order('id', { ascending: true }),
      1000,
      'customers',
    ),
    fetchAll<SalesOrderItemOption & { id?: string }>(
      () =>
        supabase
          .from('business_central_items')
          .select('id, bc_item_number, display_name, unit_price, base_unit_of_measure_code')
          .eq('organization_id', scope.orgId)
          .eq('bc_connection_id', scope.bcConnectionId)
          .eq('blocked', false)
          .not('bc_item_number', 'is', null)
          .order('bc_item_number', { ascending: true })
          .order('id', { ascending: true }),
      1000,
      'items',
    ),
    Promise.all(SELECT_KEYS.map((k) => getSelectOptions(k))),
  ]);

  return {
    customers,
    items: items.map((i) => ({
      bc_item_number: String(i.bc_item_number),
      display_name: i.display_name,
      unit_price: i.unit_price === null || i.unit_price === undefined ? null : Number(i.unit_price),
      base_unit_of_measure_code: i.base_unit_of_measure_code ?? null,
    })),
    selectOptions: Object.fromEntries(SELECT_KEYS.map((k, i) => [k, lists[i]])),
    companyLocation: mostUsedLocation(customers),
    today: todayIn(timeZoneOf(scope)),
  };
}

// ---------------------------------------------------------------- writes

const sameValue = (a: unknown, b: unknown) => {
  const norm = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return typeof a === 'boolean' || typeof b === 'boolean' ? Boolean(a) === Boolean(b) : norm(a) === norm(b);
};
const sameNumber = (a: unknown, b: unknown) =>
  a === null || a === undefined || b === null || b === undefined ? (a ?? null) === (b ?? null) : Number(a) === Number(b);

/** Lines the rep actually filled in; the trailing blank row has no item number. */
const realLines = (lines: LineDraft[]) => lines.filter((l) => (l.item_number ?? '').trim() !== '');

function validate(input: SalesOrderInput): string | null {
  if ((input.invoice_number ?? '').trim().length > 35) return 'Invoice # must be 35 characters or fewer.';
  for (const l of realLines(input.lines ?? [])) {
    if (!(Number(l.quantity) > 0)) return 'Quantity must be greater than 0.';
    const d = Number(l.discount_percent ?? 0);
    if (!(d >= 0 && d <= 100)) return 'Discount % must be between 0 and 100.';
  }
  return null;
}

function headerValues(input: SalesOrderInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of HEADER_FIELDS) out[k] = input[k];
  const invoice = (input.invoice_number ?? '').trim();
  out.invoice_number = invoice || null;
  out.requested_delivery_date = input.requested_delivery_date || null;
  return out;
}

function lineValues(l: LineDraft, position: number) {
  return {
    position,
    item_number: l.item_number.trim(),
    description: l.description ?? '',
    unit_of_measure_code: l.unit_of_measure_code ?? '',
    quantity: Number(l.quantity),
    unit_price: l.unit_price === null || l.unit_price === undefined ? null : Number(l.unit_price),
    discount_percent: Number(l.discount_percent ?? 0),
  };
}

/** True when a locked order's header (other than status/notes) or lines would change. */
function lockedChange(existing: SalesOrderRow, existingLines: SalesOrderLineRow[], input: SalesOrderInput): boolean {
  const wanted = headerValues(input);
  if (HEADER_FIELDS.some((k) => !sameValue(existing[k], wanted[k]))) return true;
  const current = existingLines.filter((l) => !l.removed);
  const next = realLines(input.lines);
  if (next.length !== current.length) return true;
  return next.some((l, i) => {
    const row = current[i];
    const v = lineValues(l, i);
    return (
      l.id !== row.id ||
      v.item_number !== row.item_number ||
      v.description !== row.description ||
      v.unit_of_measure_code !== row.unit_of_measure_code ||
      !sameNumber(v.quantity, row.quantity) ||
      !sameNumber(v.unit_price, row.unit_price) ||
      !sameNumber(v.discount_percent, row.discount_percent)
    );
  });
}

/** Limit a query to the active organization and connection. */
function scoped<Q extends { eq: (k: string, v: unknown) => Q }>(scope: Scope, q: Q): Q {
  return q.eq('organization_id', scope.orgId).eq('bc_connection_id', scope.bcConnectionId);
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** True when the input refers to a line id that is no longer on the order. */
function refersToGoneLine(existing: SalesOrderLineRow[], input: SalesOrderInput): boolean {
  const ids = new Set(existing.filter((l) => !l.removed).map((l) => l.id));
  return realLines(input.lines).some((l) => l.id && !ids.has(l.id));
}

/** Bring the stored lines in line with the input (blank row ignored, positions from input order). */
async function writeLines(scope: Scope, orderId: string, existing: SalesOrderLineRow[], input: SalesOrderInput) {
  const supabase = createServiceClient();
  const byId = new Map(existing.filter((l) => !l.removed).map((l) => [l.id, l]));
  const lines = realLines(input.lines);
  if (refersToGoneLine(existing, input)) throw new Error(LINE_GONE);
  const kept = new Set(lines.flatMap((l) => (l.id ? [l.id] : [])));

  for (const row of byId.values()) {
    if (kept.has(row.id)) continue;
    const q = row.bc_line_no !== null
      ? supabase.from(LINES).update({ removed: true, updated_at: nowIso() })
      : supabase.from(LINES).delete();
    check(
      await q
        .eq('id', row.id)
        .eq('sales_order_id', orderId)
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId),
      'Could not remove the line',
    );
  }

  const inserts: Record<string, unknown>[] = [];
  for (const [i, l] of lines.entries()) {
    const values = lineValues(l, i);
    if (!l.id) {
      inserts.push({
        ...values,
        sales_order_id: orderId,
        organization_id: scope.orgId,
        bc_connection_id: scope.bcConnectionId,
      });
      continue;
    }
    check(
      await supabase
        .from(LINES)
        .update({ ...values, updated_at: nowIso() })
        .eq('id', l.id)
        .eq('sales_order_id', orderId)
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId),
      'Could not save the line',
    );
  }
  if (inserts.length > 0) check(await supabase.from(LINES).insert(inserts), 'Could not save the lines');
}

/** The customer row (scoped to org + connection); null when missing or without a BC number. */
async function loadCustomer(
  scope: Scope,
  customerId: string,
): Promise<{ id: string; bc_customer_number: string; blocked: string | null } | null> {
  const row = check(
    await createServiceClient()
      .from('business_central_customers')
      .select('id, bc_customer_number, blocked')
      .eq('id', customerId)
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId)
      .maybeSingle(),
    'Could not load the customer',
  ) as { id: string; bc_customer_number: string | null; blocked: string | null } | null;
  if (!row || !row.bc_customer_number) return null;
  return { id: row.id, bc_customer_number: row.bc_customer_number, blocked: row.blocked ?? null };
}

/** A customer that can take an order: exists for this org + connection and isn't blocked. */
async function orderableCustomerNumber(scope: Scope, customerId: string): Promise<string | null> {
  const c = await loadCustomer(scope, customerId);
  // "Not blocked" is stored as null (normalizeBlocked), same rule as the form's customer list.
  return c && c.blocked === null ? c.bc_customer_number : null;
}

async function createOrder(scope: Scope, input: SalesOrderInput): Promise<string> {
  const supabase = createServiceClient();
  const inserted = check(
    await supabase
      .from(ORDERS)
      .insert({
        ...headerValues(input),
        order_date: input.order_date || todayIn(timeZoneOf(scope)),
        status: input.status ?? 'draft',
        notes: input.notes ?? '',
        organization_id: scope.orgId,
        bc_connection_id: scope.bcConnectionId,
        sync_state: 'pending',
        local_version: 1,
        created_by: scope.user.id,
      })
      .select('id')
      .single(),
    'Could not save the sales order',
  ) as { id: string } | null;
  if (!inserted) throw new Error('Could not save the sales order');
  try {
    await writeLines(scope, inserted.id, [], input);
  } catch (e) {
    // Don't leave a header without its lines behind.
    await supabase
      .from(ORDERS)
      .delete()
      .eq('id', inserted.id)
      .eq('organization_id', scope.orgId)
      .eq('bc_connection_id', scope.bcConnectionId);
    throw e;
  }
  return inserted.id;
}

/** Save a new order (no id) or changes to an existing one, then sync it to BC in the background. */
export async function saveSalesOrder(
  input: SalesOrderInput & { id?: string },
): Promise<{ ok: true; id: string } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const invalid = validate(input);
    if (invalid) return { ok: false, error: invalid };
    const status = input.status ?? 'draft';

    if (!input.id) {
      if (!canChangeStatus('draft', status)) return { ok: false, error: HAND_STATUS_ONLY };
      if (!input.customer_id) return { ok: false, error: 'Choose a customer.' };
      const customerNumber = await orderableCustomerNumber(scope, input.customer_id);
      if (!customerNumber) return { ok: false, error: CUSTOMER_BAD };
      const id = await createOrder(scope, { ...input, customer_number: customerNumber });
      syncInBackground(scope, id);
      revalidateSalesOrders();
      return { ok: true, id };
    }

    const existing = await loadOrder(scope, input.id);
    if (!existing) return { ok: false, error: NOT_FOUND };
    // A running sync reads the order; don't change it underneath.
    if (existing.claimed_until && Date.parse(existing.claimed_until) > Date.now()) return { ok: false, error: BUSY };
    if (status !== existing.status && !canChangeStatus(existing.status, status)) {
      return { ok: false, error: HAND_STATUS_ONLY };
    }
    // The customer number always comes from the customer row, never the client.
    // A new customer must exist and not be blocked; an unchanged one (even if
    // blocked since) keeps the order's number.
    let customerNumber = existing.customer_number;
    if (input.customer_id !== existing.customer_id) {
      const n = input.customer_id ? await orderableCustomerNumber(scope, input.customer_id) : null;
      if (!n) return { ok: false, error: CUSTOMER_BAD };
      customerNumber = n;
    }
    const existingLines = await loadLines(scope, existing.id);
    // An empty order date means "keep the current one", for the lock check and the write alike.
    const edited: SalesOrderInput = {
      ...input,
      customer_number: customerNumber,
      order_date: input.order_date || existing.order_date,
    };
    const locked = editableFields(existing.status) !== 'all';
    if (locked && lockedChange(existing, existingLines, edited)) {
      return { ok: false, error: lockedMessage(existing.status) };
    }
    // Pure input checks go before step 1, so a refused save never marks the order failed.
    if (!locked && refersToGoneLine(existingLines, edited)) return { ok: false, error: LINE_GONE };

    // 1. Take the save: bump the version only if nobody saved since we read
    //    it. A sync already running now ends 'pending', not 'synced'.
    const v = existing.local_version;
    const taken = check(
      await scoped(scope, createServiceClient().from(ORDERS).update({
        local_version: v + 1,
        sync_state: 'pending',
        sync_error: null,
        updated_at: nowIso(),
      }).eq('id', existing.id))
        .eq('local_version', v)
        .select('id'),
      'Could not save the sales order',
    ) as { id: string }[] | null;
    if (!taken || taken.length === 0) return { ok: false, error: CHANGED_ELSEWHERE };

    try {
      // 2. Write the lines and header.
      if (!locked) await writeLines(scope, existing.id, existingLines, edited);
      check(
        await scoped(scope, createServiceClient().from(ORDERS).update({
          ...(locked ? {} : headerValues(edited)),
          status,
          notes: input.notes ?? '',
          updated_at: nowIso(),
        }).eq('id', existing.id)),
        'Could not save the sales order',
      );

      // 3. Bump again, so a sync that read the order during step 2 (version
      //    v+1, half-written lines) can't mark it 'synced'. If another save has
      //    already moved past v+1, its own final bump does the same job.
      check(
        await scoped(scope, createServiceClient().from(ORDERS).update({ local_version: v + 2, sync_state: 'pending' })
          .eq('id', existing.id))
          .eq('local_version', v + 1),
        'Could not save the sales order',
      );
    } catch (e) {
      // The save stopped part-way: mark it failed with the reason, not pending.
      const message = errorMessage(e);
      try {
        check(
          await scoped(scope, createServiceClient().from(ORDERS).update({
            sync_state: 'failed',
            sync_error: `${SAVE_UNFINISHED}: ${message}`,
            updated_at: nowIso(),
          }).eq('id', existing.id)),
          'Could not save the sales order',
        );
      } catch (markError) {
        console.error('[sales-orders] could not mark the unfinished save as failed:', markError);
      }
      return { ok: false, error: message };
    }

    syncInBackground(scope, existing.id);
    revalidateSalesOrders();
    return { ok: true, id: existing.id };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Change the business status (Draft/Final/Pulled only). Status isn't sent to BC, so no sync. */
export async function setSalesOrderStatus(id: string, status: OrderStatus): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const existing = await loadOrder(scope, id);
    if (!existing) return { ok: false, error: NOT_FOUND };
    if (!canChangeStatus(existing.status, status)) return { ok: false, error: HAND_STATUS_ONLY };
    check(
      await createServiceClient()
        .from(ORDERS)
        .update({ status, updated_at: nowIso() })
        .eq('id', id)
        .eq('organization_id', scope.orgId)
        .eq('bc_connection_id', scope.bcConnectionId),
      'Could not change the status',
    );
    revalidateSalesOrders();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/**
 * Delete a Draft/Final order: BC first (if it reached BC), then Nexus. Refused
 * while a sync holds the order. If BC refuses, the order stays and shows Failed.
 */
export async function deleteSalesOrder(id: string): Promise<{ ok: true } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const first = await loadOrder(scope, id);
    if (!first) return { ok: false, error: NOT_FOUND };
    if (!canDelete(first.status)) return { ok: false, error: DELETE_RULE };

    const supabase = createServiceClient();
    const claimedAt = nowIso();
    if (!(await claimOrder(supabase, id, claimedAt, { orgId: scope.orgId, connectionId: scope.bcConnectionId }))) {
      return { ok: false, error: BUSY };
    }
    try {
      // Re-read under the lease: a sync that just finished may have stored the BC number.
      const order = await loadOrder(scope, id);
      if (!order) return { ok: false, error: NOT_FOUND };
      if (!canDelete(order.status)) return { ok: false, error: DELETE_RULE };
      if (order.bc_order_number || order.bc_create_marker) {
        try {
          const deps = await buildDeps(scope);
          let bcNumber = order.bc_order_number;
          if (!bcNumber && order.bc_create_marker) {
            // A create whose answer never reached Nexus may still have made the BC order.
            const found = await findBcOrderByMarker(deps, order.bc_create_marker);
            bcNumber = found ? String(found.fields.No ?? '') || null : null;
          }
          if (bcNumber) await deleteSalesOrderInBc(deps, { ...order, bc_order_number: bcNumber });
        } catch (e) {
          const message = errorMessage(e) || 'BC error';
          check(
            await supabase
              .from(ORDERS)
              .update({ sync_state: 'failed', sync_error: message, updated_at: nowIso() })
              .eq('id', id)
              .eq('organization_id', scope.orgId)
              .eq('bc_connection_id', scope.bcConnectionId),
            'Could not save the sales order',
          );
          revalidateSalesOrders();
          return { ok: false, error: message };
        }
      }
      // Lines go with the order (on delete cascade).
      check(
        await supabase
          .from(ORDERS)
          .delete()
          .eq('id', id)
          .eq('organization_id', scope.orgId)
          .eq('bc_connection_id', scope.bcConnectionId),
        'Could not delete the sales order',
      );
      revalidateSalesOrders();
      return { ok: true };
    } finally {
      try {
        await releaseOrder(supabase, id, leaseUntil(claimedAt));
      } catch (e) {
        console.error('[sales-orders] could not release the order lease:', e);
      }
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function syncNow(id: string, overwrite: boolean): Promise<{ ok: true; state: SyncState } | Fail> {
  try {
    const scope = await editScope();
    if (!scope) return { ok: false, error: NO_PERMISSION };
    const order = await loadOrder(scope, id);
    if (!order) return { ok: false, error: NOT_FOUND };
    // Try again and Overwrite alike: the order must be saved again first.
    if (isUnfinishedSave(order)) return { ok: false, error: NOT_SAVED };
    const state = await syncWithClaim(await buildDeps(scope), id, overwrite ? { overwrite: true } : {});
    if (state === null) return { ok: false, error: BUSY };
    revalidateSalesOrders();
    return { ok: true, state };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** "Try again": sync this order now. */
export async function retrySalesOrderSync(id: string): Promise<{ ok: true; state: SyncState } | Fail> {
  return syncNow(id, false);
}

/** "Overwrite BC with Nexus's version": sync ignoring BC-side changes (fresh etags, BC-only lines removed). */
export async function overwriteBcWithNexus(id: string): Promise<{ ok: true; state: SyncState } | Fail> {
  return syncNow(id, true);
}
