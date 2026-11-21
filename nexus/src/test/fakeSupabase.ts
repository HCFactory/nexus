// In-memory Supabase query builder for tests. Supports the subset the sales
// order code uses: select/insert/update/delete, eq/in/or (is.null + lt),
// (is.null, lt, eq, not.like) order, limit, range, maybeSingle/single and awaiting the builder;
// also ilike, gt/gte/lt/lte and select(..., { count: 'exact' }).
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { message: string; code?: string } | null; count?: number | null };
type Op = 'select' | 'insert' | 'update' | 'delete';

export interface FakeSupabase {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** Every write, in order: [table, op, payload]. */
  writes: [string, Op, unknown][];
  /** Return an error message (or { message, code }) to make that call fail. */
  failOn?: (table: string, op: Op, payload: unknown) => string | { message: string; code?: string } | null;
}

/** SQL ILIKE: % and _ are wildcards unless escaped with a backslash. */
function ilikeMatches(cur: unknown, pattern: string): boolean {
  if (cur === null || cur === undefined) return false;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'is').test(String(cur));
}

const cmp = (cur: unknown, test: (s: string) => boolean) => cur !== null && cur !== undefined && test(String(cur));

function orMatches(row: Row, expr: string): boolean {
  return expr.split(',').some((part) => {
    const [col, op, ...rest] = part.split('.');
    const value = rest.join('.');
    const cur = row[col];
    if (op === 'is' && value === 'null') return cur === null || cur === undefined;
    if (op === 'lt') return cur !== null && cur !== undefined && String(cur) < value;
    if (op === 'gte') return cur !== null && cur !== undefined && String(cur) >= value;
    if (op === 'eq') return String(cur) === value;
    if (op === 'not' && rest[0] === 'like') {
      // SQL semantics: NULL NOT LIKE x is not true. `*` is PostgREST's wildcard.
      const pattern = rest.slice(1).join('.');
      if (cur === null || cur === undefined) return false;
      const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      return !re.test(String(cur));
    }
    throw new Error(`fakeSupabase: unsupported or() part ${part}`);
  });
}

export function fakeSupabase(tables: Record<string, Row[]> = {}): FakeSupabase {
  let nextId = 1;
  const fake: FakeSupabase = { client: null as unknown as SupabaseClient, tables, writes: [] };
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: ((r: Row) => boolean)[] = [];
    let op: Op = 'select';
    let payload: Row | Row[] = {};
    const orders: [string, boolean][] = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let counted = false;
    const exec = (): Result => {
      const failure = fake.failOn?.(table, op, payload);
      if (op !== 'select') fake.writes.push([table, op, payload]);
      if (failure) return { data: null, error: typeof failure === 'string' ? { message: failure } : failure };
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload];
        const rows = list.map((p) => ({ id: `gen-${nextId++}`, ...p }));
        tables[table].push(...rows);
        return { data: rows.map((r) => ({ ...r })), error: null };
      }
      const rows = tables[table].filter((r) => filters.every((f) => f(r)));
      if (op === 'update') rows.forEach((r) => Object.assign(r, payload));
      if (op === 'delete') tables[table] = tables[table].filter((r) => !rows.includes(r));
      let out = rows.map((r) => ({ ...r }));
      for (const [k, asc] of [...orders].reverse()) {
        out.sort((a, b) => {
          const x = a[k] as string | number;
          const y = b[k] as string | number;
          const c = x < y ? -1 : x > y ? 1 : 0;
          return asc ? c : -c;
        });
      }
      const count = counted ? out.length : null;
      // Real PostgREST (with count) refuses an offset past the end: HTTP 416, PGRST103.
      if (counted && range && range[0] > 0 && range[0] >= out.length) {
        return { data: null, error: { message: 'Requested range not satisfiable', code: 'PGRST103' }, count: null };
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limit !== null) out = out.slice(0, limit);
      return { data: out, error: null, count };
    };
    const b = {
      select: (_cols?: string, o?: { count?: string }) => { counted = o?.count === 'exact'; return b; },
      insert: (p: Row | Row[]) => { op = 'insert'; payload = p; return b; },
      update: (p: Row) => { op = 'update'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; },
      not: (k: string, o: string, v: unknown) => {
        if (o !== 'is' || v !== null) throw new Error('fakeSupabase: only not(col, is, null)');
        filters.push((r) => r[k] !== null && r[k] !== undefined);
        return b;
      },
      is: (k: string, v: null) => {
        if (v !== null) throw new Error('fakeSupabase: only is(col, null)');
        filters.push((r) => r[k] === null || r[k] === undefined);
        return b;
      },
      ilike: (k: string, p: string) => { filters.push((r) => ilikeMatches(r[k], p)); return b; },
      gt: (k: string, v: string) => { filters.push((r) => cmp(r[k], (x) => x > v)); return b; },
      gte: (k: string, v: string) => { filters.push((r) => cmp(r[k], (x) => x >= v)); return b; },
      lt: (k: string, v: string) => { filters.push((r) => cmp(r[k], (x) => x < v)); return b; },
      lte: (k: string, v: string) => { filters.push((r) => cmp(r[k], (x) => x <= v)); return b; },
      in: (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return b; },
      or: (expr: string) => { filters.push((r) => orMatches(r, expr)); return b; },
      order: (k: string, o?: { ascending?: boolean }) => { orders.push([k, o?.ascending !== false]); return b; },
      limit: (n: number) => { limit = n; return b; },
      range: (a: number, z: number) => { range = [a, z]; return b; },
      maybeSingle: async () => { const r = exec(); return { data: r.data?.[0] ?? null, error: r.error }; },
      single: async () => {
        const r = exec();
        if (r.error) return { data: null, error: r.error };
        return { data: r.data?.[0] ?? null, error: r.data?.[0] ? null : { message: 'no row' } };
      },
      then: (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(exec()).then(res, rej),
    };
    return b;
  };
  fake.client = { from } as unknown as SupabaseClient;
  return fake;
}
