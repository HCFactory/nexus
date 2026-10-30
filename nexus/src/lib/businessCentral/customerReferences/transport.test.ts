import { describe, expect, it, vi } from 'vitest';
import { createReferenceTransport } from './transport';
import { BcConflictError, BcReferenceError, ReferencePageUnavailableError } from './errors';
import type { BcClient } from '../client';

function fakeBcClient(): BcClient {
  return {
    config: { tenantId: 't', clientId: 'c', environment: 'Production', companyId: 'co-guid', apiBaseUrl: 'https://api.businesscentral.dynamics.com', timeoutMs: 30000 },
    getAccessToken: async () => ({ accessToken: 'tok', tokenType: 'Bearer', expiresIn: 3600, expiresAt: Date.now() + 3600000 }),
  } as unknown as BcClient;
}

interface Call { url: string; method: string; headers: Record<string, string>; body?: string }

function setup(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    return queue.shift() ?? new Response('{}', { status: 200 });
  });
  const transport = createReferenceTransport(fakeBcClient(), 'My Co', fetchImpl as unknown as typeof fetch);
  return { transport, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const odataSource = { kind: 'odata' as const, service: 'CustomerPriceGroups', pageNumber: 7, keyFields: ['Code'] };
const apiSource = { kind: 'api' as const, resource: 'paymentTerms' };

describe('reference transport', () => {
  it('list follows nextLink across pages', async () => {
    const { transport, calls } = setup([
      json({ value: [{ id: 'a', '@odata.etag': 'W/"1"' }, { id: 'b', '@odata.etag': 'W/"2"' }], '@odata.nextLink': 'https://next/page2' }),
      json({ value: [{ id: 'c', '@odata.etag': 'W/"3"' }, { id: 'd', '@odata.etag': 'W/"4"' }] }),
    ]);
    const rows = await transport.list(apiSource);
    expect(rows).toHaveLength(4);
    expect(calls[0].url).toBe('https://api.businesscentral.dynamics.com/v2.0/Production/api/v2.0/companies(co-guid)/paymentTerms');
    expect(calls[1].url).toBe('https://next/page2');
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('odata key escapes quotes and encodes', async () => {
    const { transport, calls } = setup([json({ Code: "O'HARE/1", '@odata.etag': 'W/"1"' })]);
    await transport.get(odataSource, { values: { Code: "O'HARE/1" } });
    expect(calls[0].url).toContain("CustomerPriceGroups('O''HARE%2F1')");
    expect(calls[0].url).toContain("ODataV4/Company('My%20Co')/");
  });

  it('odata composite key with date', async () => {
    const source = { kind: 'odata' as const, service: 'TaxDetails', pageNumber: 468, keyFields: ['Tax_Jurisdiction_Code', 'Tax_Group_Code', 'Tax_Type', 'Effective_Date'] };
    const { transport, calls } = setup([json({ '@odata.etag': 'W/"1"' })]);
    await transport.get(source, {
      values: { Tax_Jurisdiction_Code: 'CA', Tax_Group_Code: 'TAXABLE', Tax_Type: 'Sales and Use Tax', Effective_Date: '2026-01-01' },
    });
    expect(calls[0].url).toContain(
      "TaxDetails(Tax_Jurisdiction_Code='CA',Tax_Group_Code='TAXABLE',Tax_Type='Sales%20and%20Use%20Tax',Effective_Date=2026-01-01)",
    );
  });

  it('patch sends If-Match and only given fields', async () => {
    const { transport, calls } = setup([json({ id: 'x', displayName: 'Net 30', '@odata.etag': 'W/"2"' })]);
    const rec = await transport.patch(apiSource, { bcId: 'x' }, 'W/"1"', { displayName: 'Net 30' });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain('/paymentTerms(x)');
    expect(calls[0].headers['If-Match']).toBe('W/"1"');
    expect(JSON.parse(calls[0].body!)).toEqual({ displayName: 'Net 30' });
    expect(rec.etag).toBe('W/"2"');
  });

  it('412 throws BcConflictError', async () => {
    const { transport } = setup([new Response('', { status: 412, statusText: 'Precondition Failed' })]);
    await expect(transport.patch(apiSource, { bcId: 'x' }, 'W/"1"', {})).rejects.toThrow(BcConflictError);
  });

  it('409 Request_EntityChanged throws BcConflictError', async () => {
    const body = JSON.stringify({ error: { code: 'Request_EntityChanged', message: 'Another user has already changed the record.' } });
    const { transport } = setup([new Response(body, { status: 409, statusText: 'Conflict' })]);
    await expect(transport.patch(apiSource, { bcId: 'x' }, 'W/"1"', {})).rejects.toThrow(BcConflictError);
  });

  it('other 409 throws BcReferenceError with BC message', async () => {
    const body = JSON.stringify({ error: { code: 'Something_Else', message: 'Nope' } });
    const { transport } = setup([new Response(body, { status: 409, statusText: 'Conflict' })]);
    const err = await transport.patch(apiSource, { bcId: 'x' }, 'W/"1"', {}).catch((e) => e);
    expect(err).toBeInstanceOf(BcReferenceError);
    expect(err.bcMessage).toBe('Nope');
  });

  it('404 on odata throws ReferencePageUnavailableError naming page and service', async () => {
    const { transport } = setup([new Response('Not Found', { status: 404, statusText: 'Not Found' })]);
    const err = await transport.list(odataSource).catch((e) => e);
    expect(err).toBeInstanceOf(ReferencePageUnavailableError);
    expect(err.message).toContain('page 7');
    expect(err.message).toContain('CustomerPriceGroups');
  });

  it('404 on an odata record URL with a not-found body throws BcReferenceError with BC message', async () => {
    const { transport } = setup([json({ error: { code: 'Request_ResourceNotFound', message: "Resource not found for the segment 'CustomerPriceGroups'." } }, 404)]);
    const err = await transport.get(odataSource, { values: { Code: 'X' } }).catch((e) => e);
    expect(err).toBeInstanceOf(BcReferenceError);
    expect(err.message).toBe("Resource not found for the segment 'CustomerPriceGroups'.");
  });

  it('404 on an odata record URL with "No HTTP resource" body throws ReferencePageUnavailableError', async () => {
    const { transport } = setup([new Response('No HTTP resource was found that matches the request URI', { status: 404 })]);
    await expect(transport.remove(odataSource, { values: { Code: 'X' } }, 'W/"1"')).rejects.toThrow(ReferencePageUnavailableError);
  });

  it("400 throws BcReferenceError carrying BC's message", async () => {
    const { transport } = setup([
      json({ error: { code: 'Internal_EntityWithSameKeyExists', message: 'The record already exists.' } }, 400),
    ]);
    const err = await transport.create(apiSource, { code: 'X' }).catch((e) => e);
    expect(err).toBeInstanceOf(BcReferenceError);
    expect(err.message).toBe('The record already exists.');
    expect(err.status).toBe(400);
  });

  it('falls back to status text when no BC message', async () => {
    const { transport } = setup([new Response('oops', { status: 500, statusText: 'Server Error' })]);
    await expect(transport.create(apiSource, {})).rejects.toThrow('500 Server Error');
  });

  it('api record key uses id, etag from @odata.etag', async () => {
    const { transport } = setup([json({ value: [{ id: 'g1', code: 'NET30', '@odata.etag': 'W/"9"' }] })]);
    const [rec] = await transport.list(apiSource);
    expect(rec.key).toEqual({ bcId: 'g1' });
    expect(rec.etag).toBe('W/"9"');
    expect(rec.fields).toMatchObject({ code: 'NET30' });
    expect(rec.fields).not.toHaveProperty('@odata.etag');
  });

  it('odata record key is built from keyFields; remove sends DELETE with If-Match', async () => {
    const { transport, calls } = setup([
      json({ value: [{ Code: 'A', Description: 'd', '@odata.etag': 'W/"1"' }] }),
      new Response(null, { status: 204 }),
    ]);
    const [rec] = await transport.list(odataSource);
    expect(rec.key).toEqual({ values: { Code: 'A' } });
    await transport.remove(odataSource, rec.key, rec.etag);
    expect(calls[1].method).toBe('DELETE');
    expect(calls[1].headers['If-Match']).toBe('W/"1"');
  });
});
