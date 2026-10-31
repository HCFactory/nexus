import { describe, expect, it, vi } from 'vitest';
import type { BcClient } from '../client';
import type { ListDefinition } from './listDefinition';
import type { LocalRow } from './merge';
import type { BcRecord, ReferenceSource, ReferenceTransport } from './transport';
import { createUsageCounter } from './usage';

const def = (key: string) => ({ key }) as unknown as ListDefinition;
const row = (over: Partial<LocalRow> = {}): LocalRow => ({
  id: 'r1', bcId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', keyValues: {}, values: {}, etag: null, ...over,
});

function fakeBc(n: number) {
  const listResourcePage = vi.fn(async (resource: string, options: { filter?: string; top: number }) => {
    void resource;
    void options;
    return Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  });
  return { bc: { listResourcePage } as unknown as BcClient, listResourcePage };
}

const records = (n: number): BcRecord[] =>
  Array.from({ length: n }, (_, i) => ({ key: { values: { k: String(i) } }, etag: '', fields: {} }));

/** Live BC counts per OData service name (TaxAreaLines / TaxDetails). */
function fakeTransport(counts: Record<string, number>) {
  const list = vi.fn(async (source: ReferenceSource, options?: { filter?: string }) => {
    void options;
    return records(source.kind === 'odata' ? counts[source.service] ?? 0 : 0);
  });
  return { transport: { list } as unknown as ReferenceTransport, list };
}

const none = () => fakeTransport({}).transport;

describe('createUsageCounter', () => {
  it('payment term used by 3 customers', async () => {
    const { bc, listResourcePage } = fakeBc(3);
    const count = createUsageCounter(bc, none());
    expect(await count(def('paymentTerms'), row())).toBe('Used by 3 customers');
    expect(listResourcePage).toHaveBeenCalledWith('customers', {
      filter: 'paymentTermsId eq 3fa85f64-5717-4562-b3fc-2c963f66afa6', top: 1000,
    });
  });

  it('taxAreas filters on taxAreaId', async () => {
    const { bc, listResourcePage } = fakeBc(1);
    await createUsageCounter(bc, none())(def('taxAreas'), row());
    expect(listResourcePage.mock.calls[0]?.[1].filter).toBe('taxAreaId eq 3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('unused returns null', async () => {
    const { bc } = fakeBc(0);
    expect(await createUsageCounter(bc, none())(def('paymentTerms'), row())).toBeNull();
  });

  it('1 customer is singular', async () => {
    const { bc } = fakeBc(1);
    expect(await createUsageCounter(bc, none())(def('paymentTerms'), row())).toBe('Used by 1 customer');
  });

  it('1000 results means 1000 or more', async () => {
    const { bc } = fakeBc(1000);
    expect(await createUsageCounter(bc, none())(def('paymentTerms'), row())).toBe('Used by 1000 or more customers');
  });

  it('throws without bcId', async () => {
    const { bc } = fakeBc(0);
    await expect(createUsageCounter(bc, none())(def('paymentTerms'), row({ bcId: null })))
      .rejects.toThrow('Cannot check usage: this entry has no Business Central id. Sync the list and try again.');
  });

  it('jurisdiction counts live from BC with an OData filter on the code', async () => {
    const { transport, list } = fakeTransport({ TaxAreaLines: 2, TaxDetails: 1 });
    const { bc } = fakeBc(0);
    const msg = await createUsageCounter(bc, transport)(def('taxJurisdictions'), row({ bcId: null, values: { code: 'CA' } }));
    expect(msg).toBe('Used by 2 tax area lines and 1 tax detail');
    const calls = list.mock.calls.map(([s, o]) => [s.kind === 'odata' ? s.service : '', o?.filter]);
    expect(calls.sort()).toEqual([
      ['TaxAreaLines', "Tax_Jurisdiction_Code eq 'CA'"],
      ['TaxDetails', "Tax_Jurisdiction_Code eq 'CA'"],
    ]);
  });

  it('jurisdiction filter doubles single quotes in the code', async () => {
    const { transport, list } = fakeTransport({});
    const { bc } = fakeBc(0);
    await createUsageCounter(bc, transport)(def('taxJurisdictions'), row({ values: { code: "O'B" } }));
    expect(list.mock.calls[0]?.[1]?.filter).toBe("Tax_Jurisdiction_Code eq 'O''B'");
  });

  it('jurisdiction with a blank code throws instead of reporting unused', async () => {
    const { transport, list } = fakeTransport({});
    const { bc } = fakeBc(0);
    for (const code of ['', '  ', null]) {
      await expect(createUsageCounter(bc, transport)(def('taxJurisdictions'), row({ values: { code } })))
        .rejects.toThrow('Cannot check usage: this jurisdiction has no code. Sync the list and try again.');
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('jurisdiction singular line, plural details; zero side keeps sentence', async () => {
    const { bc } = fakeBc(0);
    const a = fakeTransport({ TaxAreaLines: 1, TaxDetails: 2 }).transport;
    expect(await createUsageCounter(bc, a)(def('taxJurisdictions'), row({ values: { code: 'X' } })))
      .toBe('Used by 1 tax area line and 2 tax details');
    const b = fakeTransport({ TaxAreaLines: 0, TaxDetails: 3 }).transport;
    expect(await createUsageCounter(bc, b)(def('taxJurisdictions'), row({ values: { code: 'X' } })))
      .toBe('Used by 0 tax area lines and 3 tax details');
  });

  it('unused jurisdiction returns null', async () => {
    const { bc } = fakeBc(0);
    expect(await createUsageCounter(bc, none())(def('taxJurisdictions'), row({ values: { code: 'X' } }))).toBeNull();
  });

  it('other lists return null', async () => {
    const { bc, listResourcePage } = fakeBc(5);
    const { transport, list } = fakeTransport({ TaxAreaLines: 5, TaxDetails: 5 });
    const count = createUsageCounter(bc, transport);
    for (const k of ['taxAreaLines', 'taxDetails', 'customerPriceGroups', 'locations', 'customerPostingGroups', 'generalBusinessPostingGroups']) {
      expect(await count(def(k), row())).toBeNull();
    }
    expect(listResourcePage).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
