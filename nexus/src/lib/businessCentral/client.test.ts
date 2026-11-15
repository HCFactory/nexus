import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BC_TOKEN_SCOPE,
  apiRoot,
  createBcClient,
  createBcClientForOrg,
  resetBcClientTokenCacheForTests,
} from './client';

const config = {
  tenantId: 'tenant-id',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  environment: 'sandbox',
  companyId: 'company-id',
  timeoutMs: 1_000,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function tokenResponse() {
  return jsonResponse({ access_token: 'access-token', token_type: 'Bearer', expires_in: 3600 });
}

describe('Business Central client', () => {
  beforeEach(() => {
    resetBcClientTokenCacheForTests();
  });

  it('builds the Business Central API root from environment and base URL', () => {
    expect(apiRoot({ environment: 'sandbox' })).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0'
    );
    expect(apiRoot({ environment: 'Production', apiBaseUrl: 'https://example.test/' })).toBe(
      'https://example.test/v2.0/Production/api/v2.0'
    );
  });

  it('authenticates with client credentials and calls company-scoped item endpoints', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'item-id', number: '1000' }] }));
    const client = createBcClient({ ...config, fetchImpl });

    const response = await client.listItems({ top: 5, filter: "lastModifiedDateTime gt 2026-04-01T00:00:00Z" });

    expect(response.value[0]).toMatchObject({ id: 'item-id', number: '1000' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0];
    expect(String(tokenUrl)).toBe('https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token');
    expect(String((tokenInit?.body as URLSearchParams).get('scope'))).toBe(BC_TOKEN_SCOPE);
    expect(String((tokenInit?.body as URLSearchParams).get('grant_type'))).toBe('client_credentials');

    const [itemsUrl, itemsInit] = fetchImpl.mock.calls[1];
    expect(String(itemsUrl)).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0/companies(company-id)/items?%24top=5&%24filter=lastModifiedDateTime+gt+2026-04-01T00%3A00%3A00Z'
    );
    expect(new Headers(itemsInit?.headers).get('Authorization')).toBe('Bearer access-token');
  });


  it('follows Business Central item pagination links', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse({
          value: [{ id: 'item-1', number: '1000' }],
          '@odata.nextLink': 'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0/companies(company-id)/items?$skiptoken=abc',
        })
      )
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'item-2', number: '1001' }] }));

    const client = createBcClient({ ...config, fetchImpl });

    await expect(client.listAllItems({ pageSize: 1 })).resolves.toEqual({
      items: [
        { id: 'item-1', number: '1000' },
        { id: 'item-2', number: '1001' },
      ],
      truncated: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0/companies(company-id)/items?%24top=1'
    );
    expect(String(fetchImpl.mock.calls[2][0])).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0/companies(company-id)/items?$skiptoken=abc'
    );
  });

  it('retries 429 responses and preserves sanitized error details', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'TooManyRequests', message: 'Slow down' } }, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ value: [] }));

    const client = createBcClient({ ...config, fetchImpl });

    await expect(client.listCompanies()).resolves.toEqual({ value: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('calls Business Central posting group reference endpoints', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'gppg-id', code: 'RETAIL' }] }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'ipg-id', code: 'FINISHED' }] }));
    const client = createBcClient({ ...config, fetchImpl });

    await expect(client.listGeneralProductPostingGroups({ top: 100 })).resolves.toMatchObject({
      value: [{ id: 'gppg-id', code: 'RETAIL' }],
    });
    await expect(client.listInventoryPostingGroups({ top: 100 })).resolves.toMatchObject({
      value: [{ id: 'ipg-id', code: 'FINISHED' }],
    });

    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0/companies(company-id)/generalProductPostingGroups?%24top=100'
    );
    expect(String(fetchImpl.mock.calls[2][0])).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0/companies(company-id)/inventoryPostingGroups?%24top=100'
    );
  });

  it('routes listResourcePage through the company path with $orderby and $top', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'cust-1' }] }));
    const client = createBcClient({ ...config, fetchImpl });

    const result = await client.listResourcePage('customers', {
      orderBy: 'lastModifiedDateTime',
      top: 500,
    });

    expect(result).toEqual([{ id: 'cust-1' }]);
    const [url] = fetchImpl.mock.calls[1];
    expect(String(url)).toContain('/companies(company-id)/customers');
    expect(String(url)).toContain('$orderby=lastModifiedDateTime');
    expect(String(url)).toContain('$top=500');
    expect(String(url)).not.toContain('$filter');
    expect(String(url)).not.toContain('$expand');
  });

  it('includes $expand on listResourcePage when supplied', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'cust-1' }] }));
    const client = createBcClient({ ...config, fetchImpl });

    await client.listResourcePage('customers', {
      orderBy: 'lastModifiedDateTime',
      top: 500,
      expand: 'customerFinancialDetails',
    });

    const [url] = fetchImpl.mock.calls[1];
    expect(String(url)).toContain('$expand=customerFinancialDetails');
  });

  it('encodes listResourcePage filter values with %20 rather than +, and the decoded filter round-trips', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [] }));
    const client = createBcClient({ ...config, fetchImpl });

    const filter = "lastModifiedDateTime ge 2026-03-01T00:00:00Z and status ne 'Draft'";
    await client.listResourcePage('salesInvoices', {
      filter,
      orderBy: 'lastModifiedDateTime',
      top: 500,
    });

    const [url] = fetchImpl.mock.calls[1];
    const rawUrl = String(url);
    expect(rawUrl).not.toContain('+');

    const filterMatch = rawUrl.match(/\$filter=([^&]+)/);
    expect(filterMatch).not.toBeNull();
    expect(decodeURIComponent(filterMatch![1])).toBe(filter);
  });

  it('omits $orderby from listResourcePage when orderBy is not supplied', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: 'line-1' }] }));
    const client = createBcClient({ ...config, fetchImpl });

    const result = await client.listResourcePage('salesInvoiceLines', {
      filter: 'documentId eq 123',
      top: 500,
    });

    expect(result).toEqual([{ id: 'line-1' }]);
    const [url] = fetchImpl.mock.calls[1];
    expect(String(url)).toContain('/companies(company-id)/salesInvoiceLines');
    expect(String(url)).toContain('$top=500');
    expect(String(url)).not.toContain('$orderby');
  });

  it('returns an empty array when the response has no value field', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({}));
    const client = createBcClient({ ...config, fetchImpl });

    const result = await client.listResourcePage('customers', {
      orderBy: 'lastModifiedDateTime',
      top: 500,
    });

    expect(result).toEqual([]);
  });

  it('invokes a company-scoped action with POST and no body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createBcClient({ ...config, fetchImpl });

    await expect(client.invokeAction('/salesOrders(abc-123)/Microsoft.NAV.shipAndInvoice')).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[1];
    expect(String(url)).toBe(
      'https://api.businesscentral.dynamics.com/v2.0/sandbox/api/v2.0/companies(company-id)/salesOrders(abc-123)/Microsoft.NAV.shipAndInvoice'
    );
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
  });

  it('surfaces a BC 400 refusal message from invokeAction', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'BadRequest', message: 'Posting Date is not within your range of allowed posting dates.' } },
          { status: 400 }
        )
      );
    const client = createBcClient({ ...config, fetchImpl });

    await expect(client.invokeAction('/salesOrders(abc)/Microsoft.NAV.shipAndInvoice')).rejects.toThrow(
      /allowed posting dates/
    );
  });
});

// ---------------------------------------------------------------------------
// createBcClientForOrg
// ---------------------------------------------------------------------------

interface BcCredentialsMock {
  tenant_id: string;
  client_id: string;
  default_api_base_url: string | null;
}

interface BcConnectionMock {
  environment: string;
  company_id: string;
  api_base_url: string | null;
}

interface SupaMockOptions {
  credentials?: BcCredentialsMock | null;
  credentialsError?: { message: string } | null;
  connection?: BcConnectionMock | null;
  connectionError?: { message: string } | null;
  clientSecret?: string | null;
  secretError?: { message: string } | null;
}

function makeQueryChain(result: { data: unknown; error: { message: string } | null }) {
  type QueryChain = {
    select: () => QueryChain;
    eq: () => QueryChain;
    maybeSingle: () => Promise<typeof result>;
  };
  const chain: QueryChain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return chain;
}

function makeSupaMock({
  credentials = { tenant_id: 'tenant-id', client_id: 'client-id', default_api_base_url: null },
  credentialsError = null,
  connection = { environment: 'sandbox', company_id: 'company-id', api_base_url: null },
  connectionError = null,
  clientSecret = 'mock-secret',
  secretError = null,
}: SupaMockOptions = {}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'business_central_credentials') {
        return makeQueryChain({ data: credentialsError ? null : credentials, error: credentialsError ?? null });
      }
      if (table === 'business_central_connections') {
        return makeQueryChain({ data: connectionError ? null : connection, error: connectionError ?? null });
      }
      return makeQueryChain({ data: null, error: null });
    },
    rpc: async (_fn: string, _params: unknown) => ({
      data: secretError ? null : clientSecret,
      error: secretError ?? null,
    }),
  } as unknown as SupabaseClient;
}

describe('createBcClientForOrg', () => {
  it('builds a BcClient from database credentials and the org default connection', async () => {
    const client = await createBcClientForOrg('org-id', undefined, { supabase: makeSupaMock() });
    expect(client.config).toMatchObject({
      tenantId: 'tenant-id',
      clientId: 'client-id',
      environment: 'sandbox',
      companyId: 'company-id',
      apiBaseUrl: 'https://api.businesscentral.dynamics.com',
    });
  });

  it('uses a connection-level api_base_url when present', async () => {
    const client = await createBcClientForOrg('org-id', undefined, {
      supabase: makeSupaMock({
        connection: { environment: 'Production', company_id: 'prod-co', api_base_url: 'https://custom.bc.example.com' },
      }),
    });
    expect(client.config).toMatchObject({
      environment: 'Production',
      companyId: 'prod-co',
      apiBaseUrl: 'https://custom.bc.example.com',
    });
  });

  it('throws when no default connection is configured for the org', async () => {
    await expect(
      createBcClientForOrg('org-id', undefined, { supabase: makeSupaMock({ connection: null }) }),
    ).rejects.toThrow(/No default Business Central environment/);
  });

  it('throws when the client secret is absent from Vault', async () => {
    await expect(
      createBcClientForOrg('org-id', undefined, { supabase: makeSupaMock({ clientSecret: null }) }),
    ).rejects.toThrow(/No Business Central client secret/);
  });
});
