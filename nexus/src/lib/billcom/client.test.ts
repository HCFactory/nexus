import { describe, expect, it, vi } from 'vitest';

import { createBillcomClient, type SessionStore } from './client';
import { BillcomAuthError, BillcomRateLimitError, BillcomSessionExpiredError } from './errors';

const config = {
  apiBaseUrl: 'https://gateway.stage.bill.com/connect',
  devKey: 'dev-key',
  username: 'user@example.com',
  password: 'secret',
  billcomOrganizationId: '008ORG',
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/** In-memory SessionStore for tests. */
function memoryStore(initial: { sessionId: string; lastUsedAt: Date } | null = null): SessionStore {
  let state = initial;
  return {
    get: vi.fn(async () => state),
    set: vi.fn(async (sessionId: string) => {
      state = { sessionId, lastUsedAt: new Date() };
    }),
    touch: vi.fn(async () => {}),
    clear: vi.fn(async () => {
      state = null;
    }),
  };
}

describe('Bill.com client', () => {
  it('logs in when no session is stored and sends the credentials as JSON', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'session-1' }));
    const store = memoryStore(null);
    const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl });

    const sessionId = await client.login();

    expect(sessionId).toBe('session-1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://gateway.stage.bill.com/connect/v3/login');
    expect(JSON.parse(String(init?.body))).toEqual({
      username: 'user@example.com',
      password: 'secret',
      organizationId: '008ORG',
      devKey: 'dev-key',
    });
    expect(store.set).toHaveBeenCalledWith('session-1');
  });

  it('reuses a stored session inside the 30-minute window without logging in again', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const store = memoryStore({ sessionId: 'session-1', lastUsedAt: new Date() });
    const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl });

    await client.request('/v3/customers');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://gateway.stage.bill.com/connect/v3/customers');
    expect((init?.headers as Record<string, string>).sessionId).toBe('session-1');
    expect((init?.headers as Record<string, string>).devKey).toBe('dev-key');
  });

  it('logs in again when the stored session is past the idle window', async () => {
    const stale = new Date(Date.now() - 31 * 60_000);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'session-2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const store = memoryStore({ sessionId: 'session-1', lastUsedAt: stale });
    const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl });

    await client.request('/v3/customers');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/v3/login');
    expect(store.set).toHaveBeenCalledWith('session-2');
  });

  it('clears the session, logs in once and retries when a request returns 401', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'session-2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const store = memoryStore({ sessionId: 'session-1', lastUsedAt: new Date() });
    const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl });

    const result = await client.request<{ ok: boolean }>('/v3/customers');

    expect(result).toEqual({ ok: true });
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [, retryInit] = fetchImpl.mock.calls[2];
    expect((retryInit?.headers as Record<string, string>).sessionId).toBe('session-2');
  });

  it('propagates a second 401 instead of looping', async () => {
    const unauthorized = () => new Response('', { status: 401, statusText: 'Unauthorized' });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'session-2' }))
      .mockResolvedValueOnce(unauthorized());
    const store = memoryStore({ sessionId: 'session-1', lastUsedAt: new Date() });
    const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl });

    await expect(client.request('/v3/customers')).rejects.toBeInstanceOf(
      BillcomSessionExpiredError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('maps BDC_1144 to BillcomRateLimitError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error_code: 'BDC_1144', error_message: 'Rate limit exceeded' },
          { status: 429, statusText: 'Too Many Requests' },
        ),
      );
    const store = memoryStore({ sessionId: 'session-1', lastUsedAt: new Date() });
    const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl });

    await expect(client.request('/v3/customers')).rejects.toBeInstanceOf(BillcomRateLimitError);
  });

  it('rejects a failed login with BillcomAuthError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error_code: 'BDC_1001', error_message: 'Invalid credentials' },
          { status: 401, statusText: 'Unauthorized' },
        ),
      );
    const client = createBillcomClient({ ...config, sessionStore: memoryStore(null), fetchImpl });

    await expect(client.login()).rejects.toBeInstanceOf(BillcomAuthError);
  });
});
