import 'server-only';

import {
  BillcomApiError,
  BillcomAuthError,
  BillcomRateLimitError,
  BillcomSessionExpiredError,
  type BillcomErrorDetails,
} from './errors';

/** Bill.com expires a session after 35 minutes idle; reuse inside 30 for margin. */
export const SESSION_REUSE_WINDOW_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Waits before each GET retry on a transient gateway error (502/503/504). */
const GATEWAY_RETRY_DELAYS_MS = [1_000, 2_000];
const GATEWAY_STATUSES = new Set([502, 503, 504]);
/**
 * No new GET retry starts once a request has run this long, so one slow
 * customer stays well inside the push run's 2-minute link lease.
 */
const RETRY_WINDOW_MS = 35_000;

export interface StoredSession {
  sessionId: string;
  lastUsedAt: Date;
}

export interface SessionStore {
  get(): Promise<StoredSession | null>;
  set(sessionId: string): Promise<void>;
  touch(): Promise<void>;
  clear(): Promise<void>;
}

export interface BillcomClientConfig {
  apiBaseUrl: string;
  devKey: string;
  username: string;
  password: string;
  billcomOrganizationId: string;
  sessionStore: SessionStore;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Delay between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the retry window; injectable for tests. */
  now?: () => number;
}

export interface BillcomClient {
  login(): Promise<string>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  getSession(): Promise<StoredSession | null>;
}

async function readErrorDetails(response: Response, url: string): Promise<BillcomErrorDetails> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    // v3 returns an array of errors: [{ code, message, severity, ... }].
    const body = (await response.json()) as unknown;
    const first = (Array.isArray(body) ? body[0] : body) as
      | { code?: string; message?: string }
      | undefined;
    code = first?.code;
    message = first?.message;
  } catch {
    // Non-JSON error bodies are expected; fall back to status text.
  }
  return { status: response.status, statusText: response.statusText, code, message, url };
}

function errorFor(details: BillcomErrorDetails): BillcomApiError {
  if (details.code === 'BDC_1144') return new BillcomRateLimitError(details);
  // A 401 that reaches here survived the clear-and-retry in request() — a
  // session that could not be re-established, not an auth failure. login()'s
  // own failure path throws BillcomAuthError directly and never calls this.
  if (details.status === 401) return new BillcomSessionExpiredError(details);
  return new BillcomApiError(details);
}

function isAbort(err: unknown): boolean {
  // DOMException is not an Error subclass in every runtime; check the name.
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function createBillcomClient(config: BillcomClientConfig): BillcomClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, '');

  async function call(path: string, init: RequestInit): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const seconds = () => Math.round(timeoutMs / 1000);

  async function login(): Promise<string> {
    const path = '/v3/login';
    let response: Response;
    try {
      response = await call(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: config.username,
          password: config.password,
          organizationId: config.billcomOrganizationId,
          devKey: config.devKey,
        }),
      });
    } catch (err) {
      if (!isAbort(err)) throw err;
      throw new BillcomApiError({
        status: 0,
        statusText: 'Timeout',
        message: `Bill.com sign-in didn't answer within ${seconds()} seconds.`,
        url: `${baseUrl}${path}`,
      });
    }

    if (!response.ok) {
      const details = await readErrorDetails(response, `${baseUrl}${path}`);
      if (details.code === 'BDC_1144') throw new BillcomRateLimitError(details);
      throw new BillcomAuthError(details);
    }

    const body = (await response.json()) as { sessionId?: string };
    if (!body.sessionId) {
      throw new BillcomAuthError({
        status: response.status,
        statusText: response.statusText,
        message: 'Bill.com login succeeded but returned no sessionId.',
        url: `${baseUrl}${path}`,
      });
    }

    await config.sessionStore.set(body.sessionId);
    return body.sessionId;
  }

  /** Reuse a stored session inside the idle window; otherwise log in. */
  async function ensureSession(): Promise<string> {
    const stored = await config.sessionStore.get();
    if (stored && Date.now() - stored.lastUsedAt.getTime() < SESSION_REUSE_WINDOW_MS) {
      return stored.sessionId;
    }
    return login();
  }

  async function send(path: string, init: RequestInit, sessionId: string): Promise<Response> {
    return call(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
        devKey: config.devKey,
        sessionId,
      },
    });
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${baseUrl}${path}`;
    // Retry only GETs on a transient error (gateway 502/503/504 or our own
    // timeout). Never other methods: a create that timed out may still have
    // gone through.
    const isGet = (init.method ?? 'GET').toUpperCase() === 'GET';
    const started = now();
    let retries = 0;
    let reloggedIn = false;
    let sessionId = await ensureSession();

    const canRetry = () =>
      isGet && retries < GATEWAY_RETRY_DELAYS_MS.length && now() - started < RETRY_WINDOW_MS;

    for (;;) {
      let response: Response;
      try {
        response = await send(path, init, sessionId);
      } catch (err) {
        if (!isAbort(err)) throw err;
        if (canRetry()) {
          await sleep(GATEWAY_RETRY_DELAYS_MS[retries++]);
          continue;
        }
        throw new BillcomApiError({
          status: 0,
          statusText: 'Timeout',
          message: isGet
            ? `Bill.com didn't answer within ${seconds()} seconds.`
            : // A write that timed out may have gone through; the next push
              // matches by account number, so it will not create a duplicate.
              `Bill.com didn't answer within ${seconds()} seconds. It may still have been saved — the next push will check.`,
          url,
        });
      }

      // A 401 means the session died early — at any point, including after
      // a gateway retry. Clear it, log in once, and retry. A second 401
      // propagates rather than looping.
      if (response.status === 401 && !reloggedIn) {
        // Bill.com can report its rate limit as a 401. That is not a dead
        // session: logging in again would cost a second request and throw
        // away a valid session.
        const details = await readErrorDetails(response, url);
        if (details.code === 'BDC_1144') throw new BillcomRateLimitError(details);
        await config.sessionStore.clear();
        sessionId = await login();
        reloggedIn = true;
        continue;
      }

      if (GATEWAY_STATUSES.has(response.status) && canRetry()) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(GATEWAY_RETRY_DELAYS_MS[retries++]);
        continue;
      }

      if (!response.ok) {
        throw errorFor(await readErrorDetails(response, url));
      }

      await config.sessionStore.touch();
      return (await response.json()) as T;
    }
  }

  return { login, request, getSession: () => config.sessionStore.get() };
}
