// The Sales invoices list: search, filters and paging run in the database
// (view sales_invoice_list, migration 075) across every invoice, 100 at a time.
// The page's address holds the current search/filters/page, so links and
// refreshes keep them.
import type { SupabaseClient } from '@supabase/supabase-js';

export const SALES_INVOICE_PAGE_SIZE = 100;

/** Statuses a posted BC sales invoice can have (BC's salesInvoice status values for posted invoices). */
export const SALES_INVOICE_STATUSES = ['Open', 'Paid', 'Canceled', 'Corrective'] as const;

export type BillcomFilter = 'all' | 'paid' | 'pastdue' | 'open' | 'unmatched';
const BILLCOM_FILTERS: BillcomFilter[] = ['all', 'paid', 'pastdue', 'open', 'unmatched'];

export interface SalesInvoiceListParams {
  search: string;
  status: string;
  billcom: BillcomFilter;
  /** Posting date range, YYYY-MM-DD or ''. */
  from: string;
  to: string;
  page: number;
}

/** One row of the list (the view's columns). */
export interface SalesInvoiceListRow {
  id: string;
  bc_invoice_id: string;
  bc_invoice_number: string | null;
  external_document_number: string | null;
  customer_number: string | null;
  customer_name: string | null;
  posting_date: string | null;
  due_date: string | null;
  currency_code: string | null;
  total_amount_including_tax: number | null;
  status: string | null;
  billcom_match: 'found' | 'mismatch' | null;
  billcom_status: string | null;
  billcom_due_amount: number | string | null;
  billcom_due_date: string | null;
}

type Raw = string | string[] | undefined;
const first = (v: Raw) => (Array.isArray(v) ? v[0] : v) ?? '';
/** A real calendar date as YYYY-MM-DD (2026-02-30 is not). */
const isDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
/** Far beyond any real list; keeps the database offset a normal number. */
const MAX_PAGE = 10_000;

/** Reads the page address (?q=&status=&billcom=&from=&to=&page=), ignoring anything invalid. */
export function parseSalesInvoiceListParams(sp: Record<string, Raw>): SalesInvoiceListParams {
  const status = first(sp.status);
  const billcom = first(sp.billcom) as BillcomFilter;
  const from = first(sp.from);
  const to = first(sp.to);
  const page = Number.parseInt(first(sp.page), 10);
  return {
    search: first(sp.q).trim(),
    status: (SALES_INVOICE_STATUSES as readonly string[]).includes(status) ? status : 'all',
    billcom: BILLCOM_FILTERS.includes(billcom) ? billcom : 'all',
    from: isDate(from) ? from : '',
    to: isDate(to) ? to : '',
    page: /^\d+$/.test(first(sp.page)) && page > 1 && page <= MAX_PAGE ? page : 1,
  };
}

/** The page address for these params; default values are left out. */
export function salesInvoiceListSearch(p: SalesInvoiceListParams): string {
  const qs = new URLSearchParams();
  if (p.search) qs.set('q', p.search);
  if (p.status !== 'all') qs.set('status', p.status);
  if (p.billcom !== 'all') qs.set('billcom', p.billcom);
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (p.page > 1) qs.set('page', String(p.page));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** Typed text matches literally: % and _ are not wildcards. */
const likeLiteral = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

type ListResult = { invoices: SalesInvoiceListRow[]; total: number; page: number; error: string | null };

/**
 * One page of the list, newest first, with the total that match and the page
 * actually shown: a page past the end (say, invoices were paid since the link
 * was made) shows the last page instead. The Bill.com filter applies only
 * when the environment has Bill.com. Never throws.
 */
export async function querySalesInvoiceList(
  supabase: SupabaseClient,
  orgId: string,
  bcConnectionId: string,
  p: SalesInvoiceListParams,
  today: string,
  billcomEnabled: boolean,
): Promise<ListResult> {
  const first = await readPage(supabase, orgId, bcConnectionId, p, today, billcomEnabled);
  if (first.error !== 'past_end') return first;
  const counted = await readPage(supabase, orgId, bcConnectionId, { ...p, page: 1 }, today, billcomEnabled);
  if (counted.error) return counted.error === 'past_end' ? { invoices: [], total: 0, page: 1, error: null } : counted;
  const last = Math.max(1, Math.ceil(counted.total / SALES_INVOICE_PAGE_SIZE));
  if (last === 1) return counted;
  const lastPage = await readPage(supabase, orgId, bcConnectionId, { ...p, page: last }, today, billcomEnabled);
  return lastPage.error === 'past_end' ? counted : lastPage;
}

async function readPage(
  supabase: SupabaseClient,
  orgId: string,
  bcConnectionId: string,
  p: SalesInvoiceListParams,
  today: string,
  billcomEnabled: boolean,
): Promise<ListResult> {
  let q = supabase
    .from('sales_invoice_list')
    .select('*', { count: 'exact' })
    .eq('organization_id', orgId)
    .eq('bc_connection_id', bcConnectionId);
  // Note: PostgREST treats * in a like pattern as a wildcard and it cannot be escaped; accepted.
  if (p.search) q = q.ilike('search_text', `%${likeLiteral(p.search)}%`);
  if (p.status !== 'all') q = q.eq('status', p.status);
  if (p.from) q = q.gte('posting_date', p.from);
  if (p.to) q = q.lte('posting_date', p.to);
  if (billcomEnabled) {
    if (p.billcom === 'paid') q = q.eq('billcom_group', 'paid');
    if (p.billcom === 'unmatched') q = q.eq('billcom_group', 'unmatched');
    if (p.billcom === 'pastdue') q = q.lt('billcom_owed_due_date', today);
    if (p.billcom === 'open') q = q.or(`billcom_group.eq.open,billcom_owed_due_date.gte.${today}`);
  }
  const start = (p.page - 1) * SALES_INVOICE_PAGE_SIZE;
  const { data, error, count } = await q
    .order('posting_date', { ascending: false, nullsFirst: false })
    .order('bc_invoice_number', { ascending: false })
    // Unique last key: rows with the same date and number keep one order across pages.
    .order('id', { ascending: true })
    .range(start, start + SALES_INVOICE_PAGE_SIZE - 1);
  // With a count, PostgREST answers 416 (PGRST103) for an offset past the end.
  if (error) return { invoices: [], total: 0, page: p.page, error: error.code === 'PGRST103' ? 'past_end' : error.message };
  return { invoices: (data ?? []) as SalesInvoiceListRow[], total: count ?? 0, page: p.page, error: null };
}
