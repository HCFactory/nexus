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
          [{ code: 'BDC_1144', severity: 'ERROR', message: 'Rate limit exceeded' }],
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
          [{ code: 'BDC_1001', severity: 'ERROR', message: 'Invalid credentials' }],
          { status: 401, statusText: 'Unauthorized' },
        ),
      );
    const client = createBillcomClient({ ...config, sessionStore: memoryStore(null), fetchImpl });

    await expect(client.login()).rejects.toBeInstanceOf(BillcomAuthError);
  });

  it("surfaces Bill.com's own error message from the v3 error array", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          [{ code: 'BDC_1102', severity: 'ERROR', message: 'Developer key is invalid.' }],
          { status: 400, statusText: 'Bad Request' },
        ),
      );
    const client = createBillcomClient({ ...config, sessionStore: memoryStore(null), fetchImpl });

    await expect(client.login()).rejects.toMatchObject({
      message: 'Developer key is invalid.',
      details: { code: 'BDC_1102' },
    });
  });

  it('discards the first 401 body before logging in again', async () => {
    const first = new Response('expired', { status: 401, statusText: 'Unauthorized' });
    const cancel = vi.spyOn(first.body!, 'cancel');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'session-2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const store = memoryStore({ sessionId: 'session-1', lastUsedAt: new Date() });
    const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl });

    await client.request('/v3/customers');
    expect(cancel).toHaveBeenCalled();
  });

  describe('transient gateway errors', () => {
    const gateway = (status = 504) => new Response('', { status, statusText: 'Gateway Timeout' });
    const fresh = () => memoryStore({ sessionId: 'session-1', lastUsedAt: new Date() });

    it('retries a GET that 504s once, then returns the data', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(gateway())
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const sleep = vi.fn(async () => {});
      const client = createBillcomClient({ ...config, sessionStore: fresh(), fetchImpl, sleep });

      expect(await client.request('/v3/customers')).toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(1000);
    });

    it('retries 502 and 503 on GET too', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(gateway(502))
        .mockResolvedValueOnce(gateway(503))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const sleep = vi.fn(async () => {});
      const client = createBillcomClient({ ...config, sessionStore: fresh(), fetchImpl, sleep });

      expect(await client.request('/v3/customers', { method: 'GET' })).toEqual({ ok: true });
      expect(sleep.mock.calls).toEqual([[1000], [2000]]);
    });

    it('throws after a GET 504s three times', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => gateway());
      const sleep = vi.fn(async () => {});
      const client = createBillcomClient({ ...config, sessionStore: fresh(), fetchImpl, sleep });

      await expect(client.request('/v3/customers')).rejects.toMatchObject({ details: { status: 504 } });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('never retries a POST (a create could duplicate)', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => gateway());
      const sleep = vi.fn(async () => {});
      const client = createBillcomClient({ ...config, sessionStore: fresh(), fetchImpl, sleep });

      await expect(client.request('/v3/customers', { method: 'POST', body: '{}' })).rejects.toMatchObject({
        details: { status: 504 },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('logs in again when a 401 arrives after a gateway retry', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(gateway())
        .mockResolvedValueOnce(new Response('', { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ sessionId: 'session-2' }))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const sleep = vi.fn(async () => {});
      const store = fresh();
      const client = createBillcomClient({ ...config, sessionStore: store, fetchImpl, sleep });

      expect(await client.request('/v3/customers')).toEqual({ ok: true });
      expect(store.clear).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[2][0])).toContain('/v3/login');
      expect((fetchImpl.mock.calls[3][1]?.headers as Record<string, string>).sessionId).toBe('session-2');
    });

    it('retries a GET that times out, then returns the data', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new DOMException('This operation was aborted', 'AbortError'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const sleep = vi.fn(async () => {});
      const client = createBillcomClient({ ...config, sessionStore: fresh(), fetchImpl, sleep });

      expect(await client.request('/v3/customers')).toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('never retries a POST that times out, and says Bill.com did not answer', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException('This operation was aborted', 'AbortError'));
      const sleep = vi.fn(async () => {});
      const client = createBillcomClient({ ...config, sessionStore: fresh(), fetchImpl, sleep });

      await expect(client.request('/v3/customers', { method: 'POST', body: '{}' })).rejects.toThrow(
        /didn't answer within 30 seconds/,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('stops retrying once the request has run 35 seconds, so one slow customer cannot outlast its lease', async () => {
      let clock = 0;
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
        clock += 30_000; // each attempt takes the full timeout
        return gateway();
      });
      const sleep = vi.fn(async (ms: number) => {
        clock += ms;
      });
      const client = createBillcomClient({ ...config, sessionStore: fresh(), fetchImpl, sleep, now: () => clock });

      await expect(client.request('/v3/customers')).rejects.toMatchObject({ details: { status: 504 } });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
