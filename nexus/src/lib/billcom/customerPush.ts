import type { SupabaseClient } from '@supabase/supabase-js';

import type { BillcomClient } from './client';
import {
  payloadHash,
  shouldBeArchived,
  toBillcomCustomer,
  type BillcomCustomerPayload,
} from './customerPayload';
import { BillcomRateLimitError } from './errors';
import { fetchAll } from './fetchAll';
import type { BillcomCustomerLink, BusinessCentralCustomer } from '@/types/database';

/**
 * One-way push of Business Central customers to Bill.com.
 * Matching key: Bill.com accountNumber = BC customer number. Once linked, the
 * stored Bill.com id is authoritative. Bill.com allows duplicate account
 * numbers, so more than one match is never resolved automatically.
 */

export interface PushDeps {
  supabase: SupabaseClient;
  billcom: BillcomClient;
  orgId: string;
  bcConnectionId: string;
  billcomConnectionId: string;
  /** Milliseconds clock; injectable for tests. */
  now?: () => number;
}

export interface PushPreview {
  link: number;
  create: number;
  update: number;
  deactivate: number;
  needsAttention: Array<{ number: string; reason: string }>;
  sample: Array<{ number: string; changes: Record<string, [unknown, unknown]> }>;
}

export interface PushResult {
  created: number;
  updated: number;
  linked: number;
  unchanged: number;
  failed: number;
  needsAttention: number;
  remaining: number;
  stoppedReason?: 'budget' | 'rate_limit' | 'list_failed';
  /** Bill.com's message when the run stopped because the customer list could not be read. */
  error?: string;
}

/** The Bill.com customer list could not be read; the run stops rather than failing every link. */
class BillcomListError extends Error {}

interface BillcomCustomer {
  id: string;
  archived?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  accountNumber?: string;
  billingAddress?: Record<string, unknown>;
}

const LINKS = 'billcom_customer_links';
const BC_CUSTOMERS = 'business_central_customers';
const BILLCOM_PAGE = 100;
const MAX_CONCURRENCY = 3;
const SAMPLE_SIZE = 10;
const DELETED_HASH = 'deleted';
const LEASE_MS = 2 * 60_000;

// ---------- Supabase reads (paged past the 1,000-row cap) ----------


function loadBcCustomers(deps: PushDeps): Promise<BusinessCentralCustomer[]> {
  return fetchAll<BusinessCentralCustomer>(() =>
    deps.supabase
      .from(BC_CUSTOMERS)
      .select('*')
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.bcConnectionId)
      .order('id'),
  );
}

function linksQuery(deps: PushDeps) {
  return deps.supabase
    .from(LINKS)
    .select('*')
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.bcConnectionId)
    .eq('billcom_connection_id', deps.billcomConnectionId);
}

async function loadLinks(deps: PushDeps, numbers?: string[]): Promise<BillcomCustomerLink[]> {
  if (!numbers) {
    return fetchAll<BillcomCustomerLink>(() => linksQuery(deps).order('id'));
  }
  const out: BillcomCustomerLink[] = [];
  for (let i = 0; i < numbers.length; i += 200) {
    const chunk = numbers.slice(i, i + 200);
    out.push(
      ...(await fetchAll<BillcomCustomerLink>(() =>
        linksQuery(deps).in('bc_customer_number', chunk).order('id'),
      )),
    );
  }
  return out;
}

async function updateLink(deps: PushDeps, id: string, patch: Partial<BillcomCustomerLink>) {
  return writeLink(deps, id, { ...patch, claimed_until: null });
}

/** Mid-processing write that keeps the lease (e.g. saving the Bill.com id). */
async function writeLink(deps: PushDeps, id: string, patch: Partial<BillcomCustomerLink>) {
  const { error } = await deps.supabase
    .from(LINKS)
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('organization_id', deps.orgId)
    .eq('bc_connection_id', deps.bcConnectionId)
    .eq('billcom_connection_id', deps.billcomConnectionId);
  if (error) throw new Error(`Could not save Bill.com link: ${error.message}`);
}

// ---------- Bill.com reads ----------

async function listBillcomCustomers(deps: PushDeps): Promise<BillcomCustomer[]> {
  try {
    return await listBillcomCustomersRaw(deps);
  } catch (err) {
    if (err instanceof BillcomRateLimitError) throw err;
    throw new BillcomListError(err instanceof Error ? err.message : String(err));
  }
}

async function listBillcomCustomersRaw(deps: PushDeps): Promise<BillcomCustomer[]> {
  const byId = new Map<string, BillcomCustomer>();
  for (const filter of [null, 'archived:eq:true']) {
    let page: string | undefined;
    do {
      const qs = new URLSearchParams({ max: String(BILLCOM_PAGE) });
      if (filter) qs.set('filters', filter);
      if (page) qs.set('page', page);
      const res = await deps.billcom.request<{ results?: BillcomCustomer[]; nextPage?: string }>(
        `/v3/customers?${qs.toString()}`,
      );
      for (const c of res.results ?? []) byId.set(c.id, c);
      page = res.nextPage || undefined;
    } while (page);
  }
  return [...byId.values()];
}

function indexByAccount(customers: BillcomCustomer[]) {
  const byAccount = new Map<string, BillcomCustomer[]>();
  const byId = new Map<string, BillcomCustomer>();
  for (const c of customers) {
    byId.set(c.id, c);
    const key = (c.accountNumber ?? '').trim();
    if (!key) continue;
    byAccount.set(key, [...(byAccount.get(key) ?? []), c]);
  }
  return { byAccount, byId };
}

const duplicateReason = (no: string, matches: BillcomCustomer[]) =>
  `Bill.com has ${matches.length} customers with account number ${no} (${matches
    .map((m) => m.id)
    .join(', ')}). Merge or renumber them in Bill.com, then retry.`;

function diff(current: BillcomCustomer | undefined, next: BillcomCustomerPayload, archived: boolean) {
  const changes: Record<string, [unknown, unknown]> = {};
  const cur = (current ?? {}) as Record<string, unknown>;
  const curAddr = (current?.billingAddress ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) {
    if (k === 'billingAddress') continue;
    if ((cur[k] ?? '') !== v) changes[k] = [cur[k] ?? '', v];
  }
  for (const [k, v] of Object.entries(next.billingAddress)) {
    if ((curAddr[k] ?? '') !== v) changes[`billingAddress.${k}`] = [curAddr[k] ?? '', v];
  }
  if (Boolean(current?.archived) !== archived) changes.archived = [Boolean(current?.archived), archived];
  return changes;
}

// ---------- Public API ----------

/** Dry run of the initial push. Reads BC, links and Bill.com; writes nothing. */
export async function planInitialPush(deps: PushDeps): Promise<PushPreview> {
  const [rows, links, billcomCustomers] = await Promise.all([
    loadBcCustomers(deps),
    loadLinks(deps),
    listBillcomCustomers(deps),
  ]);
  const { byAccount, byId } = indexByAccount(billcomCustomers);
  const linkByNo = new Map(links.map((l) => [l.bc_customer_number, l]));
  const preview: PushPreview = { link: 0, create: 0, update: 0, deactivate: 0, needsAttention: [], sample: [] };
  const seen = new Set<string>();

  for (const row of rows) {
    const no = row.bc_customer_number;
    if (!no) continue;
    seen.add(no);
    const payload = toBillcomCustomer(row);
    const archived = shouldBeArchived(row);
    const existing = linkByNo.get(no);
    let current: BillcomCustomer | undefined;

    if (existing?.billcom_customer_id) {
      if (existing.last_pushed_hash === payloadHash(payload, archived)) continue;
      current = byId.get(existing.billcom_customer_id);
      preview.update++;
    } else {
      const matches = byAccount.get(no) ?? [];
      if (matches.length > 1) {
        preview.needsAttention.push({ number: no, reason: duplicateReason(no, matches) });
        continue;
      }
      current = matches[0];
      if (current) preview.link++;
      else preview.create++;
    }
    if (archived && !current?.archived) preview.deactivate++;
    if (preview.sample.length < SAMPLE_SIZE) {
      const changes = diff(current, payload, archived);
      if (Object.keys(changes).length) preview.sample.push({ number: no, changes });
    }
  }

  for (const l of links) {
    if (seen.has(l.bc_customer_number) || !l.billcom_customer_id) continue;
    if (!byId.get(l.billcom_customer_id)?.archived) preview.deactivate++;
  }
  return preview;
}

/** Upsert links for the given BC numbers to `pending`. */
export async function markPending(deps: PushDeps, numbers: string[]): Promise<void> {
  if (!numbers.length) return;
  const rowIdByNo = new Map<string, string>();
  for (let i = 0; i < numbers.length; i += 200) {
    const chunk = numbers.slice(i, i + 200);
    const rows = await fetchAll<BusinessCentralCustomer>(() =>
      deps.supabase
        .from(BC_CUSTOMERS)
        .select('id, bc_customer_number')
        .eq('organization_id', deps.orgId)
        .eq('bc_connection_id', deps.bcConnectionId)
        .in('bc_customer_number', chunk)
        .order('id'),
    );
    for (const r of rows) if (r.bc_customer_number) rowIdByNo.set(r.bc_customer_number, r.id);
  }
  const stamp = new Date().toISOString();
  const payload = [...new Set(numbers)].map((no) => ({
    organization_id: deps.orgId,
    bc_connection_id: deps.bcConnectionId,
    billcom_connection_id: deps.billcomConnectionId,
    bc_customer_number: no,
    business_central_customer_id: rowIdByNo.get(no) ?? null,
    status: 'pending' as const,
    updated_at: stamp,
  }));
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await deps.supabase.from(LINKS).upsert(payload.slice(i, i + 500), {
      onConflict: 'organization_id,bc_connection_id,billcom_connection_id,bc_customer_number',
    });
    if (error) throw new Error(`Could not queue customers for Bill.com: ${error.message}`);
  }
}

type Outcome = 'created' | 'updated' | 'linked' | 'unchanged' | 'failed' | 'needsAttention' | 'synced';

/**
 * Push the given numbers (or every pending/failed link). Up to 3 customers run
 * at once; the run stops at `budgetMs` or on a Bill.com rate limit, leaving
 * unprocessed links pending for the next run.
 */
export async function pushCustomers(
  deps: PushDeps,
  opts: { numbers?: string[]; budgetMs: number },
): Promise<PushResult> {
  const now = deps.now ?? Date.now;
  const started = now();

  // Mark every given number pending up front so a stop leaves them queued.
  if (opts.numbers) await markPending(deps, opts.numbers);
  const links = (await loadLinks(deps, opts.numbers)).filter(
    (l) => opts.numbers || l.status === 'pending' || l.status === 'failed',
  );

  const rows = await loadBcCustomers(deps);
  const rowById = new Map(rows.map((r) => [r.id, r]));

  let billcomIndex: Promise<ReturnType<typeof indexByAccount>> | null = null;
  const getIndex = () => (billcomIndex ??= listBillcomCustomers(deps).then(indexByAccount));

  const result: PushResult = {
    created: 0,
    updated: 0,
    linked: 0,
    unchanged: 0,
    failed: 0,
    needsAttention: 0,
    remaining: 0,
  };
  let stop: PushResult['stoppedReason'];
  let next = 0;
  let done = 0;

  /** DB-checked lease: the update only matches a link with no live lease. */
  async function claim(link: BillcomCustomerLink): Promise<boolean> {
    const at = now();
    const nowIso = new Date(at).toISOString();
    const { data, error } = await deps.supabase
      .from(LINKS)
      .update({ claimed_until: new Date(at + LEASE_MS).toISOString(), updated_at: new Date().toISOString() })
      .eq('id', link.id)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.bcConnectionId)
      .eq('billcom_connection_id', deps.billcomConnectionId)
      .or(`claimed_until.is.null,claimed_until.lt.${nowIso}`)
      .select('id');
    if (error) throw new Error(`Could not claim Bill.com link: ${error.message}`);
    return Array.isArray(data) && data.length > 0;
  }

  async function currentBillcomId(link: BillcomCustomerLink): Promise<string | null> {
    const { data, error } = await deps.supabase
      .from(LINKS)
      .select('billcom_customer_id')
      .eq('id', link.id)
      .eq('organization_id', deps.orgId)
      .eq('bc_connection_id', deps.bcConnectionId)
      .eq('billcom_connection_id', deps.billcomConnectionId);
    if (error) throw new Error(`Could not read Bill.com link: ${error.message}`);
    return ((data ?? []) as Array<{ billcom_customer_id: string | null }>)[0]?.billcom_customer_id ?? null;
  }

  async function processLink(link: BillcomCustomerLink): Promise<Outcome | 'skipped'> {
    if (!(await claim(link))) return 'skipped';
    const row = link.business_central_customer_id
      ? rowById.get(link.business_central_customer_id)
      : undefined;

    if (!row) {
      // Deleted in Nexus/BC: make it inactive in Bill.com.
      if (link.billcom_customer_id && link.last_pushed_hash !== DELETED_HASH) {
        const { byId } = await getIndex();
        if (!byId.get(link.billcom_customer_id)?.archived) {
          await deps.billcom.request(`/v3/customers/${link.billcom_customer_id}/archive`, { method: 'POST' });
        }
      }
      await updateLink(deps, link.id, {
        status: 'synced',
        last_pushed_hash: DELETED_HASH,
        last_pushed_at: new Date(now()).toISOString(),
        last_error: null,
      });
      return 'synced';
    }

    const payload = toBillcomCustomer(row);
    const archived = shouldBeArchived(row);
    const hash = payloadHash(payload, archived);

    if (link.billcom_customer_id && link.last_pushed_hash === hash) {
      await updateLink(deps, link.id, { status: 'synced', last_error: null });
      return 'unchanged';
    }

    const { byAccount, byId } = await getIndex();
    let id = link.billcom_customer_id;
    let current: BillcomCustomer | undefined;
    let outcome: Outcome;

    if (id) {
      current = byId.get(id);
      outcome = 'updated';
    } else {
      const matches = byAccount.get(link.bc_customer_number) ?? [];
      if (matches.length > 1) {
        await updateLink(deps, link.id, {
          status: 'needs_attention',
          last_error: duplicateReason(link.bc_customer_number, matches),
        });
        return 'needsAttention';
      }
      current = matches[0];
      if (current) {
        id = current.id;
        // Save the id first so a later failure never leads to a duplicate.
        await writeLink(deps, link.id, { billcom_customer_id: id });
        outcome = 'linked';
      } else {
        // Another run may have created it since we loaded the link.
        if (await currentBillcomId(link)) {
          await updateLink(deps, link.id, {});
          return 'skipped';
        }
        const createdCustomer = await deps.billcom.request<BillcomCustomer>('/v3/customers', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        id = createdCustomer.id;
        current = createdCustomer;
        await writeLink(deps, link.id, { billcom_customer_id: id });
        outcome = 'created';
      }
    }

    if (!archived && current?.archived) {
      await deps.billcom.request(`/v3/customers/${id}/restore`, { method: 'POST' });
    }
    if (outcome !== 'created') {
      await deps.billcom.request(`/v3/customers/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    }
    if (archived && !current?.archived) {
      await deps.billcom.request(`/v3/customers/${id}/archive`, { method: 'POST' });
    }

    await updateLink(deps, link.id, {
      billcom_customer_id: id,
      status: 'synced',
      last_pushed_hash: hash,
      last_pushed_at: new Date(now()).toISOString(),
      last_error: null,
    });
    return outcome;
  }

  async function worker() {
    while (!stop && next < links.length) {
      if (now() - started >= opts.budgetMs) {
        stop ??= 'budget';
        return;
      }
      const link = links[next++];
      try {
        const outcome = await processLink(link);
        if (outcome !== 'synced' && outcome !== 'skipped') result[outcome]++;
        done++;
      } catch (err) {
        if (err instanceof BillcomRateLimitError || err instanceof BillcomListError) {
          if (err instanceof BillcomRateLimitError) stop = 'rate_limit';
          else {
            stop = 'list_failed';
            result.error ??= err.message;
          }
          // Release the lease; status and error stay as they were.
          await updateLink(deps, link.id, {}).catch(() => undefined);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        try {
          await updateLink(deps, link.id, { status: 'failed', last_error: message });
        } catch {
          // The link stays as it was; one DB error must not drop the run's results.
        }
        result.failed++;
        done++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, links.length) }, worker));
  result.remaining = links.length - done;
  if (stop) result.stoppedReason = stop;
  return result;
}
