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

/** Transport whose CustomerTemplates service returns the given template codes. */
function templateTransport(codes: string[]) {
  const list = vi.fn(async (source: ReferenceSource, options?: { filter?: string }) => {
    void options;
    if (source.kind === 'odata' && source.service === 'CustomerTemplates') {
      return codes.map((Code): BcRecord => ({ key: { values: { Code } }, etag: '', fields: { Code } }));
    }
    return [];
  });
  return { transport: { list } as unknown as ReferenceTransport, list };
}
const withCode = { values: { code: 'NET30' } };

describe('createUsageCounter', () => {
  it('payment term used by 3 customers', async () => {
    const { bc, listResourcePage } = fakeBc(3);
    const count = createUsageCounter(bc, none());
    expect(await count(def('paymentTerms'), row(withCode))).toBe('Used by 3 customers');
    expect(listResourcePage).toHaveBeenCalledWith('customers', {
      filter: 'paymentTermsId eq 3fa85f64-5717-4562-b3fc-2c963f66afa6', top: 1000,
    });
  });

  it('taxAreas filters on taxAreaId', async () => {
    const { bc, listResourcePage } = fakeBc(1);
    await createUsageCounter(bc, none())(def('taxAreas'), row(withCode));
    expect(listResourcePage.mock.calls[0]?.[1].filter).toBe('taxAreaId eq 3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('unused returns null', async () => {
    const { bc } = fakeBc(0);
    expect(await createUsageCounter(bc, none())(def('paymentTerms'), row(withCode))).toBeNull();
  });

  it('1 customer is singular', async () => {
    const { bc } = fakeBc(1);
    expect(await createUsageCounter(bc, none())(def('paymentTerms'), row(withCode))).toBe('Used by 1 customer');
  });

  it('1000 results means 1000 or more', async () => {
    const { bc } = fakeBc(1000);
    expect(await createUsageCounter(bc, none())(def('paymentTerms'), row(withCode))).toBe('Used by 1000 or more customers');
  });

  it('throws without bcId', async () => {
    const { bc } = fakeBc(0);
    await expect(createUsageCounter(bc, none())(def('paymentTerms'), row({ bcId: null, ...withCode })))
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

  it('blocks a payment term used only by a template', async () => {
    const { bc } = fakeBc(0);
    const { transport, list } = templateTransport(['WHOLESALE']);
    expect(await createUsageCounter(bc, transport)(def('paymentTerms'), row({ values: { code: 'NET30' } })))
      .toBe('Used by template WHOLESALE');
    expect(list.mock.calls[0]?.[1]?.filter).toBe("Payment_Terms_Code eq 'NET30'");
  });

  it('combines customers and templates', async () => {
    const { bc } = fakeBc(2);
    const { transport } = templateTransport(['A', 'B']);
    expect(await createUsageCounter(bc, transport)(def('paymentTerms'), row(withCode)))
      .toBe('Used by 2 customers and templates A, B');
  });

  it('combines 1 customer and 1 template', async () => {
    const { bc } = fakeBc(1);
    const { transport } = templateTransport(['A']);
    expect(await createUsageCounter(bc, transport)(def('paymentTerms'), row(withCode)))
      .toBe('Used by 1 customer and template A');
  });

  it('tax area counts templates by Tax_Area_Code', async () => {
    const { bc } = fakeBc(0);
    const { transport, list } = templateTransport(['T1', 'T2']);
    expect(await createUsageCounter(bc, transport)(def('taxAreas'), row({ values: { code: 'HI-HNL-RT' } })))
      .toBe('Used by templates T1, T2');
    expect(list.mock.calls[0]?.[1]?.filter).toBe("Tax_Area_Code eq 'HI-HNL-RT'");
  });

  it('escapes quotes in the template filter', async () => {
    const { bc } = fakeBc(0);
    const { transport, list } = templateTransport([]);
    await createUsageCounter(bc, transport)(def('paymentTerms'), row({ values: { code: "O'B/1" } }));
    expect(list.mock.calls[0]?.[1]?.filter).toBe("Payment_Terms_Code eq 'O''B/1'");
  });

  it('falls back to keyValues.code', async () => {
    const { bc } = fakeBc(0);
    const { transport, list } = templateTransport([]);
    await createUsageCounter(bc, transport)(def('paymentTerms'), row({ keyValues: { code: 'KV' } }));
    expect(list.mock.calls[0]?.[1]?.filter).toBe("Payment_Terms_Code eq 'KV'");
  });

  it('fails closed when templates cannot be read', async () => {
    const { bc } = fakeBc(0);
    const list = vi.fn(async () => { throw new Error('BC down'); });
    const transport = { list } as unknown as ReferenceTransport;
    await expect(createUsageCounter(bc, transport)(def('paymentTerms'), row(withCode))).rejects.toThrow('BC down');
  });

  it('blank code throws for payment terms and tax areas', async () => {
    const { bc } = fakeBc(0);
    for (const k of ['paymentTerms', 'taxAreas']) {
      await expect(createUsageCounter(bc, none())(def(k), row({ values: { code: ' ' } })))
        .rejects.toThrow('Cannot check usage: this entry has no code. Sync the list and try again.');
    }
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
