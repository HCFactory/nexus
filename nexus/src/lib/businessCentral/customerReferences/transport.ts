import 'server-only';
import { apiRoot, createBcClientForOrg, type BcClient } from '../client';
import { BcConflictError, BcReferenceError, ReferencePageUnavailableError } from './errors';

export type ReferenceSource =
  | { kind: 'api'; resource: string }
  | { kind: 'odata'; service: string; pageNumber: number; keyFields: string[] };

export type BcKey = { bcId: string } | { values: Record<string, string> };

export interface BcRecord {
  key: BcKey;
  etag: string;
  fields: Record<string, unknown>;
}

export interface ReferenceTransport {
  list(source: ReferenceSource): Promise<BcRecord[]>;
  get(source: ReferenceSource, key: BcKey): Promise<BcRecord>;
  create(source: ReferenceSource, fields: Record<string, unknown>): Promise<BcRecord>;
  patch(source: ReferenceSource, key: BcKey, etag: string, fields: Record<string, unknown>): Promise<BcRecord>;
  remove(source: ReferenceSource, key: BcKey, etag: string): Promise<void>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function quoteKeyValue(value: string): string {
  // Date-typed key fields are written unquoted in OData v4 key predicates.
  if (DATE_RE.test(value)) return value;
  return `'${encodeURIComponent(value.replace(/'/g, "''"))}'`;
}

function mapRecord(source: ReferenceSource, row: Record<string, unknown>): BcRecord {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('@odata.')) fields[k] = v;
  }
  const etag = String(row['@odata.etag'] ?? '');
  if (source.kind === 'api') {
    return { key: { bcId: String(row.id) }, etag, fields };
  }
  const values: Record<string, string> = {};
  for (const name of source.keyFields) values[name] = String(row[name] ?? '');
  return { key: { values }, etag, fields };
}

export function createReferenceTransport(
  bc: BcClient,
  companyName: string,
  fetchImpl: typeof fetch = fetch,
): ReferenceTransport {
  const odataBase = `${trimTrailingSlash(bc.config.apiBaseUrl ?? 'https://api.businesscentral.dynamics.com')}/v2.0/${encodeURIComponent(bc.config.environment)}/ODataV4/Company('${encodeURIComponent(companyName)}')`;
  const apiBase = `${apiRoot(bc.config)}/companies(${encodeURIComponent(bc.config.companyId)})`;

  function collectionUrl(source: ReferenceSource): string {
    return source.kind === 'api' ? `${apiBase}/${source.resource}` : `${odataBase}/${source.service}`;
  }

  function recordUrl(source: ReferenceSource, key: BcKey): string {
    const root = collectionUrl(source);
    if (source.kind === 'api') {
      if (!('bcId' in key)) throw new Error('API reference records are addressed by bcId');
      return `${root}(${encodeURIComponent(key.bcId)})`;
    }
    if (!('values' in key)) throw new Error('OData reference records are addressed by key field values');
    const names = source.keyFields;
    const value = (name: string): string => {
      const v = key.values[name];
      if (v === undefined) throw new Error(`Missing key field ${name} for ${source.service}`);
      return v;
    };
    if (names.length === 1) return `${root}(${quoteKeyValue(value(names[0]))})`;
    return `${root}(${names.map((n) => `${n}=${quoteKeyValue(value(n))}`).join(',')})`;
  }

  async function send(
    source: ReferenceSource,
    url: string,
    init: { method?: string; etag?: string; body?: Record<string, unknown>; isList?: boolean } = {},
  ): Promise<Response> {
    const token = await bc.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `${token.tokenType} ${token.accessToken}`,
      Accept: 'application/json',
    };
    if (init.body) headers['Content-Type'] = 'application/json';
    if (init.etag !== undefined) headers['If-Match'] = init.etag;
    const res = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.ok) return res;
    if (res.status === 412) throw new BcConflictError();
    let bcMessage = `${res.status} ${res.statusText}`;
    let rawBody = '';
    let bcCode = '';
    try {
      rawBody = await res.text();
      const body = JSON.parse(rawBody) as { error?: { code?: string; message?: string } };
      if (body?.error?.message) bcMessage = body.error.message;
      bcCode = body?.error?.code ?? '';
    } catch {
      // non-JSON body: keep status text
    }
    // BC answers a stale If-Match with 409 Request_EntityChanged rather than 412.
    if (res.status === 409 && bcCode === 'Request_EntityChanged') throw new BcConflictError();
    if (res.status === 404 && source.kind === 'odata') {
      // A 404 on the collection means the page is not published. On a single
      // record URL BC also returns 404 for a missing record, so only treat it
      // as unpublished when BC says the route itself was not found.
      const routeMissing = /No HTTP resource was found/i.test(`${rawBody} ${bcMessage}`);
      if (init.isList || routeMissing) {
        throw new ReferencePageUnavailableError(source.service, source.pageNumber, res.status);
      }
    }
    throw new BcReferenceError(res.status, bcMessage);
  }

  async function readRecord(source: ReferenceSource, res: Response): Promise<BcRecord> {
    return mapRecord(source, (await res.json()) as Record<string, unknown>);
  }

  return {
    async list(source) {
      const out: BcRecord[] = [];
      let url: string | undefined = collectionUrl(source);
      while (url) {
        const res = await send(source, url, { isList: true });
        const json = (await res.json()) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string };
        for (const row of json.value ?? []) out.push(mapRecord(source, row));
        url = json['@odata.nextLink'];
      }
      return out;
    },
    async get(source, key) {
      return readRecord(source, await send(source, recordUrl(source, key)));
    },
    async create(source, fields) {
      return readRecord(source, await send(source, collectionUrl(source), { method: 'POST', body: fields }));
    },
    async patch(source, key, etag, fields) {
      return readRecord(source, await send(source, recordUrl(source, key), { method: 'PATCH', etag, body: fields }));
    },
    async remove(source, key, etag) {
      await send(source, recordUrl(source, key), { method: 'DELETE', etag });
    },
  };
}

export async function createReferenceTransportForOrg(orgId: string, connectionId: string): Promise<ReferenceTransport> {
  const bc = await createBcClientForOrg(orgId, connectionId);
  const company = await bc.getCompany(bc.config.companyId);
  // BC OData company key uses the Company.Name (short name), not displayName.
  return createReferenceTransport(bc, company.name);
}
