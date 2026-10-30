import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BcClient } from '../client';
import type { ListDefinition } from './listDefinition';
import type { LocalRow } from './merge';
import { createUsageCounter } from './usage';

const def = (key: string) => ({ key }) as unknown as ListDefinition;
const row = (over: Partial<LocalRow> = {}): LocalRow => ({
  id: 'r1', bcId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', keyValues: {}, values: {}, etag: null, ...over,
});

function fakeBc(n: number) {
  const listResourcePage = vi.fn(async (_r: string, _o: { filter?: string; top: number }) => Array.from({ length: n }, (_, i) => ({ id: String(i) })));
  return { bc: { listResourcePage } as unknown as BcClient, listResourcePage };
}

function fakeSupabase(counts: Record<string, number>) {
  const calls: { table: string; filters: [string, unknown][] }[] = [];
  const from = (table: string) => {
    const call = { table, filters: [] as [string, unknown][] };
    calls.push(call);
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => { call.filters.push([c, v]); return q; },
      then: (res: (v: unknown) => unknown) => res({ count: counts[table] ?? 0, error: null }),
    };
    return q;
  };
  return { supabase: { from } as unknown as SupabaseClient, calls };
}

const none = () => fakeSupabase({}).supabase;

describe('createUsageCounter', () => {
  it('payment term used by 3 customers', async () => {
    const { bc, listResourcePage } = fakeBc(3);
    const count = createUsageCounter(bc, none(), 'o', 'c');
    expect(await count(def('paymentTerms'), row())).toBe('Used by 3 customers');
    expect(listResourcePage).toHaveBeenCalledWith('customers', {
      filter: 'paymentTermsId eq 3fa85f64-5717-4562-b3fc-2c963f66afa6', top: 1000,
    });
  });

  it('uses live BC count regardless of mirror', async () => {
    const { bc } = fakeBc(2);
    const { supabase, calls } = fakeSupabase({ business_central_customers: 0 });
    const count = createUsageCounter(bc, supabase, 'o', 'c');
    expect(await count(def('taxAreas'), row())).toBe('Used by 2 customers');
    expect(calls).toHaveLength(0);
  });

  it('taxAreas filters on taxAreaId', async () => {
    const { bc, listResourcePage } = fakeBc(1);
    await createUsageCounter(bc, none(), 'o', 'c')(def('taxAreas'), row());
    expect(listResourcePage.mock.calls[0]?.[1].filter).toBe('taxAreaId eq 3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('unused returns null', async () => {
    const { bc } = fakeBc(0);
    expect(await createUsageCounter(bc, none(), 'o', 'c')(def('paymentTerms'), row())).toBeNull();
  });

  it('1 customer is singular', async () => {
    const { bc } = fakeBc(1);
    expect(await createUsageCounter(bc, none(), 'o', 'c')(def('paymentTerms'), row())).toBe('Used by 1 customer');
  });

  it('1000 results means 1000 or more', async () => {
    const { bc } = fakeBc(1000);
    expect(await createUsageCounter(bc, none(), 'o', 'c')(def('paymentTerms'), row())).toBe('Used by 1000 or more customers');
  });

  it('throws without bcId', async () => {
    const { bc } = fakeBc(0);
    await expect(createUsageCounter(bc, none(), 'o', 'c')(def('paymentTerms'), row({ bcId: null })))
      .rejects.toThrow('Cannot check usage: this entry has no Business Central id. Sync the list and try again.');
  });

  it('jurisdiction used by 2 lines and 1 detail', async () => {
    const { supabase, calls } = fakeSupabase({ business_central_tax_area_lines: 2, business_central_tax_details: 1 });
    const { bc } = fakeBc(0);
    const msg = await createUsageCounter(bc, supabase, 'org', 'conn')(def('taxJurisdictions'), row({ bcId: null, values: { code: 'CA' } }));
    expect(msg).toBe('Used by 2 tax area lines and 1 tax detail');
    expect(calls.map((c) => c.table).sort()).toEqual(['business_central_tax_area_lines', 'business_central_tax_details']);
    expect(calls[0].filters).toEqual([['organization_id', 'org'], ['bc_connection_id', 'conn'], ['tax_jurisdiction_code', 'CA']]);
  });

  it('jurisdiction singular line, plural details; zero side keeps sentence', async () => {
    const a = fakeSupabase({ business_central_tax_area_lines: 1, business_central_tax_details: 2 });
    const { bc } = fakeBc(0);
    expect(await createUsageCounter(bc, a.supabase, 'o', 'c')(def('taxJurisdictions'), row({ values: { code: 'X' } })))
      .toBe('Used by 1 tax area line and 2 tax details');
    const b = fakeSupabase({ business_central_tax_area_lines: 0, business_central_tax_details: 3 });
    expect(await createUsageCounter(bc, b.supabase, 'o', 'c')(def('taxJurisdictions'), row({ values: { code: 'X' } })))
      .toBe('Used by 0 tax area lines and 3 tax details');
  });

  it('unused jurisdiction returns null', async () => {
    const { bc } = fakeBc(0);
    expect(await createUsageCounter(bc, none(), 'o', 'c')(def('taxJurisdictions'), row({ values: { code: 'X' } }))).toBeNull();
  });

  it('other lists return null', async () => {
    const { bc, listResourcePage } = fakeBc(5);
    const count = createUsageCounter(bc, none(), 'o', 'c');
    for (const k of ['taxAreaLines', 'taxDetails', 'customerPriceGroups', 'locations', 'customerPostingGroups', 'generalBusinessPostingGroups']) {
      expect(await count(def(k), row())).toBeNull();
    }
    expect(listResourcePage).not.toHaveBeenCalled();
  });
});
