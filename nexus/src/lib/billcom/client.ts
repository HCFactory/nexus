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
    const body = (await response.json()) as { error_code?: string; error_message?: string };
    code = body.error_code;
    message = body.error_message;
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

export function createBillcomClient(config: BillcomClientConfig): BillcomClient {
  const fetchImpl = config.fetchImpl ?? fetch;
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

  async function login(): Promise<string> {
    const path = '/v3/login';
    const response = await call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: config.username,
        password: config.password,
        organizationId: config.billcomOrganizationId,
        devKey: config.devKey,
      }),
    });

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
    let sessionId = await ensureSession();
    let response = await send(path, init, sessionId);

    // A 401 mid-request means the session died early. Clear it, log in once,
    // and retry. A second 401 propagates rather than looping.
    if (response.status === 401) {
      await config.sessionStore.clear();
      sessionId = await login();
      response = await send(path, init, sessionId);
    }

    if (!response.ok) {
      throw errorFor(await readErrorDetails(response, `${baseUrl}${path}`));
    }

    await config.sessionStore.touch();
    return (await response.json()) as T;
  }

  return { login, request, getSession: () => config.sessionStore.get() };
}
