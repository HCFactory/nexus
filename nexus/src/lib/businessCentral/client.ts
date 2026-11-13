import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_BC_API_BASE_URL =
  "https://api.businesscentral.dynamics.com";
export const BC_TOKEN_SCOPE =
  "https://api.businesscentral.dynamics.com/.default";
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

export interface BcClientConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  environment: string;
  companyId: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface BcAccessToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  expiresAt: number;
}

export interface BcListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

export interface BcCompany {
  id: string;
  name: string;
  displayName: string;
  businessProfileId?: string;
  systemVersion?: string;
}

export interface BcItem {
  id: string;
  number: string;
  displayName: string;
  displayName2?: string;
  type: string;
  itemCategoryId: string;
  itemCategoryCode: string;
  blocked: boolean;
  gtin: string;
  inventory: number;
  unitPrice: number;
  priceIncludesTax: boolean;
  unitCost: number;
  taxGroupId: string;
  taxGroupCode: string;
  baseUnitOfMeasureId: string;
  baseUnitOfMeasureCode: string;
  generalProductPostingGroupId?: string;
  generalProductPostingGroupCode?: string;
  inventoryPostingGroupId?: string;
  inventoryPostingGroupCode?: string;
  lastModifiedDateTime: string;
  "@odata.etag"?: string;
  [key: string]: unknown;
}

export interface BcItemCategory {
  id: string;
  code: string;
  displayName: string;
  lastModifiedDateTime: string;
  "@odata.etag"?: string;
}

export interface BcTaxGroup {
  id: string;
  code: string;
  displayName: string;
  taxType: string;
  lastModifiedDateTime: string;
  "@odata.etag"?: string;
}

export interface BcUnitOfMeasure {
  id: string;
  code: string;
  displayName: string;
  internationalStandardCode: string;
  symbol?: string;
  lastModifiedDateTime: string;
  "@odata.etag"?: string;
}

export interface BcGeneralProductPostingGroup {
  id: string;
  code: string;
  description: string;
  defaultVATProductPostingGroup: string;
  autoInsertDefault: boolean;
  lastModifiedDateTime: string;
  "@odata.etag"?: string;
}

export interface BcInventoryPostingGroup {
  id: string;
  code: string;
  description: string;
  lastModifiedDateTime: string;
  "@odata.etag"?: string;
}

export interface BcItemCreatePayload {
  number?: string;
  displayName: string;
  displayName2?: string;
  type?: string;
  itemCategoryId?: string;
  itemCategoryCode?: string;
  blocked?: boolean;
  gtin?: string;
  unitPrice?: number;
  priceIncludesTax?: boolean;
  unitCost?: number;
  taxGroupId?: string;
  taxGroupCode?: string;
  baseUnitOfMeasureId?: string;
  baseUnitOfMeasureCode?: string;
  generalProductPostingGroupId?: string;
  generalProductPostingGroupCode?: string;
  inventoryPostingGroupId?: string;
  inventoryPostingGroupCode?: string;
}

export type BcItemPatchPayload = Partial<Omit<BcItemCreatePayload, "number">>;

export interface BcErrorDetails {
  status: number;
  statusText: string;
  code?: string;
  message?: string;
  retryAfter?: string | null;
  requestId?: string | null;
  url: string;
}

export class BcApiError extends Error {
  readonly details: BcErrorDetails;

  constructor(details: BcErrorDetails) {
    super(details.message || `${details.status} ${details.statusText}`);
    this.name = "BcApiError";
    this.details = details;
  }
}

export interface BcClient {
  readonly config: Omit<BcClientConfig, "clientSecret" | "fetchImpl">;
  getAccessToken(): Promise<BcAccessToken>;
  listCompanies(): Promise<BcListResponse<BcCompany>>;
  getCompany(companyId?: string): Promise<BcCompany>;
  listItems(options?: {
    top?: number;
    filter?: string;
  }): Promise<BcListResponse<BcItem>>;
  listAllItems(options?: {
    pageSize?: number;
    filter?: string;
    maxItems?: number;
  }): Promise<{ items: BcItem[]; truncated: boolean }>;
  getItem(itemId: string): Promise<BcItem>;
  createItem(payload: BcItemCreatePayload): Promise<BcItem>;
  updateItem(
    itemId: string,
    payload: BcItemPatchPayload,
    etag: string,
  ): Promise<BcItem>;
  deleteItem(itemId: string, etag: string): Promise<void>;
  listItemCategories(options?: {
    top?: number;
  }): Promise<BcListResponse<BcItemCategory>>;
  listTaxGroups(options?: {
    top?: number;
  }): Promise<BcListResponse<BcTaxGroup>>;
  listUnitsOfMeasure(options?: {
    top?: number;
  }): Promise<BcListResponse<BcUnitOfMeasure>>;
  listGeneralProductPostingGroups(options?: {
    top?: number;
  }): Promise<BcListResponse<BcGeneralProductPostingGroup>>;
  listInventoryPostingGroups(options?: {
    top?: number;
  }): Promise<BcListResponse<BcInventoryPostingGroup>>;
  listResourcePage<T>(
    resource: string,
    options: { filter?: string; orderBy?: string; top: number; expand?: string; select?: string },
  ): Promise<T[]>;
}

interface CachedToken extends BcAccessToken {
  cacheKey: string;
}

let cachedToken: CachedToken | null = null;

export function resetBcClientTokenCacheForTests(): void {
  cachedToken = null;
}

export function createBcClient(config: BcClientConfig): BcClient {
  const normalized = normalizeConfig(config);
  const fetchImpl = config.fetchImpl ?? fetch;

  async function getAccessToken(): Promise<BcAccessToken> {
    const cacheKey = `${normalized.tenantId}:${normalized.clientId}:${normalized.apiBaseUrl}`;
    if (
      cachedToken?.cacheKey === cacheKey &&
      cachedToken.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS
    ) {
      return stripCacheKey(cachedToken);
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: normalized.clientId,
      client_secret: config.clientSecret,
      scope: BC_TOKEN_SCOPE,
    });

    const response = await fetchWithTimeout(
      fetchImpl,
      `https://login.microsoftonline.com/${encodeURIComponent(normalized.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      normalized.timeoutMs,
    );

    if (!response.ok) {
      throw await buildBcApiError(response, "token");
    }

    const payload = (await response.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };

    if (!payload.access_token || !payload.expires_in) {
      throw new Error(
        "Business Central token response did not include access_token and expires_in.",
      );
    }

    cachedToken = {
      cacheKey,
      accessToken: payload.access_token,
      tokenType: payload.token_type ?? "Bearer",
      expiresIn: payload.expires_in,
      expiresAt: Date.now() + payload.expires_in * 1000,
    };

    return stripCacheKey(cachedToken);
  }

  async function request<T>(
    pathOrUrl: string,
    init: RequestInit = {},
  ): Promise<T> {
    const token = await getAccessToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${apiRoot(normalized)}${pathOrUrl}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `${token.tokenType} ${token.accessToken}`);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let lastError: BcApiError | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      let response: Response;
      try {
        response = await fetchWithTimeout(
          fetchImpl,
          url,
          { ...init, headers },
          normalized.timeoutMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BcApiError({
          status: 0,
          statusText: "Network Error",
          code: "NetworkError",
          message: `Business Central request failed before receiving a response (${message})`,
          retryAfter: null,
          requestId: null,
          url,
        });
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const error = await buildBcApiError(response, url);
      lastError = error;
      if (!shouldRetry(response.status) || attempt === RETRY_DELAYS_MS.length) {
        throw error;
      }

      await delay(
        parseRetryDelay(response.headers.get("Retry-After")) ??
          RETRY_DELAYS_MS[attempt],
      );
    }

    throw (
      lastError ??
      new Error("Business Central request failed without response details.")
    );
  }

  function companyPath(path = ""): string {
    return `/companies(${encodeURIComponent(normalized.companyId)})${path}`;
  }

  async function listAllItems(options: { pageSize?: number; filter?: string; maxItems?: number } = {}): Promise<{ items: BcItem[]; truncated: boolean }> {
    const pageSize = options.pageSize ?? 500;
    const maxItems = options.maxItems ?? 10_000;
    const items: BcItem[] = [];
    let nextUrl: string | undefined = withQuery(companyPath("/items"), {
      top: pageSize,
      filter: options.filter,
    });

    while (nextUrl) {
      const page: BcListResponse<BcItem> = await request<BcListResponse<BcItem>>(nextUrl);
      items.push(...page.value);
      if (items.length >= maxItems) {
        return { items: items.slice(0, maxItems), truncated: true };
      }
      nextUrl = page["@odata.nextLink"];
    }

    return { items, truncated: false };
  }

  async function listResourcePage<T>(
    resource: string,
    options: { filter?: string; orderBy?: string; top: number; expand?: string; select?: string },
  ): Promise<T[]> {
    const params: string[] = [];
    if (options.filter) {
      params.push(`$filter=${encodeURIComponent(options.filter)}`);
    }
    if (options.orderBy) {
      params.push(`$orderby=${encodeURIComponent(options.orderBy)}`);
    }
    params.push(`$top=${encodeURIComponent(String(options.top))}`);
    if (options.expand) {
      params.push(`$expand=${encodeURIComponent(options.expand)}`);
    }
    if (options.select) {
      params.push(`$select=${encodeURIComponent(options.select)}`);
    }
    const response = await request<BcListResponse<T>>(
      `${companyPath(`/${resource}`)}?${params.join("&")}`,
    );
    return response.value ?? [];
  }

  return {
    config: normalized,
    getAccessToken,
    listCompanies: () => request<BcListResponse<BcCompany>>("/companies"),
    getCompany: (companyId = normalized.companyId) =>
      request<BcCompany>(`/companies(${encodeURIComponent(companyId)})`),
    listItems: (options = {}) =>
      request<BcListResponse<BcItem>>(
        withQuery(companyPath("/items"), options),
      ),
    listAllItems,
    getItem: (itemId) =>
      request<BcItem>(companyPath(`/items(${encodeURIComponent(itemId)})`)),
    createItem: (payload) =>
      request<BcItem>(companyPath("/items"), {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    updateItem: (itemId, payload, etag) =>
      request<BcItem>(companyPath(`/items(${encodeURIComponent(itemId)})`), {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: JSON.stringify(payload),
      }),
    deleteItem: (itemId, etag) =>
      request<void>(companyPath(`/items(${encodeURIComponent(itemId)})`), {
        method: "DELETE",
        headers: { "If-Match": etag },
      }),
    listItemCategories: (options = {}) =>
      request<BcListResponse<BcItemCategory>>(
        withQuery(companyPath("/itemCategories"), options),
      ),
    listTaxGroups: (options = {}) =>
      request<BcListResponse<BcTaxGroup>>(
        withQuery(companyPath("/taxGroups"), options),
      ),
    listUnitsOfMeasure: (options = {}) =>
      request<BcListResponse<BcUnitOfMeasure>>(
        withQuery(companyPath("/unitsOfMeasure"), options),
      ),
    listGeneralProductPostingGroups: (options = {}) =>
      request<BcListResponse<BcGeneralProductPostingGroup>>(
        withQuery(companyPath("/generalProductPostingGroups"), options),
      ),
    listInventoryPostingGroups: (options = {}) =>
      request<BcListResponse<BcInventoryPostingGroup>>(
        withQuery(companyPath("/inventoryPostingGroups"), options),
      ),
    listResourcePage,
  };
}

export interface CreateBcClientForOrgOptions {
  /**
   * Service-role Supabase client used for the credential/connection reads.
   * Injected in tests; defaults to `createServiceClient()` at call time.
   */
  supabase?: SupabaseClient;
}

async function getServiceClient(): Promise<SupabaseClient> {
  // Imported lazily so this module's static graph (and its unit tests) do not
  // pull in the Next.js server runtime.
  const { createServiceClient } = await import("@/lib/supabase/server");
  return createServiceClient() as unknown as SupabaseClient;
}

/**
 * Builds a Business Central client from an organization's stored credentials
 * and a specific environment connection.
 *
 * - `connectionId` selects the environment; when omitted the org's default
 *   (`is_default`) connection is used.
 * - The shared tenant/client IDs come from `business_central_credentials`; the
 *   client secret is decrypted from Supabase Vault via the
 *   `get_bc_client_secret` SECURITY DEFINER wrapper.
 * - When no credentials row exists for the org, this throws a clear error —
 *   credentials must be configured in Settings (or via the one-time seed).
 */
export async function createBcClientForOrg(
  orgId: string,
  connectionId?: string,
  options: CreateBcClientForOrgOptions = {},
): Promise<BcClient> {
  const supabase = options.supabase ?? (await getServiceClient());

  const { data: credentials, error: credentialsError } = await supabase
    .from("business_central_credentials")
    .select("tenant_id, client_id, default_api_base_url")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (credentialsError) {
    throw new Error(
      `Failed to load Business Central credentials: ${credentialsError.message}`,
    );
  }

  if (!credentials) {
    throw new Error(
      "No Business Central credentials are configured for this organization.",
    );
  }

  const connectionQuery = supabase
    .from("business_central_connections")
    .select("environment, company_id, api_base_url")
    .eq("organization_id", orgId);
  const { data: connection, error: connectionError } = connectionId
    ? await connectionQuery.eq("id", connectionId).maybeSingle()
    : await connectionQuery.eq("is_default", true).maybeSingle();

  if (connectionError) {
    throw new Error(
      `Failed to load Business Central environment: ${connectionError.message}`,
    );
  }
  if (!connection) {
    throw new Error(
      connectionId
        ? `Business Central environment ${connectionId} was not found for this organization.`
        : "No default Business Central environment is configured for this organization.",
    );
  }

  const { data: clientSecret, error: secretError } = await supabase.rpc(
    "get_bc_client_secret",
    { p_org_id: orgId },
  );
  if (secretError) {
    throw new Error(
      `Failed to read the Business Central client secret: ${secretError.message}`,
    );
  }
  if (!clientSecret) {
    throw new Error(
      "No Business Central client secret is stored for this organization.",
    );
  }

  const config: BcClientConfig = {
    tenantId: credentials.tenant_id,
    clientId: credentials.client_id,
    clientSecret: clientSecret as string,
    environment: connection.environment,
    companyId: connection.company_id,
    apiBaseUrl:
      connection.api_base_url ?? credentials.default_api_base_url ?? undefined,
  };

  return createBcClient(config);
}

export function apiRoot(
  config: Pick<BcClientConfig, "environment" | "apiBaseUrl">,
): string {
  return `${trimTrailingSlash(config.apiBaseUrl ?? DEFAULT_BC_API_BASE_URL)}/v2.0/${encodeURIComponent(config.environment)}/api/v2.0`;
}

function normalizeConfig(
  config: BcClientConfig,
): Omit<BcClientConfig, "clientSecret" | "fetchImpl"> & {
  apiBaseUrl: string;
  timeoutMs: number;
} {
  if (
    !config.tenantId ||
    !config.clientId ||
    !config.clientSecret ||
    !config.environment ||
    !config.companyId
  ) {
    throw new Error(
      "Business Central client config requires tenantId, clientId, clientSecret, environment, and companyId.",
    );
  }

  return {
    tenantId: config.tenantId,
    clientId: config.clientId,
    environment: config.environment,
    companyId: config.companyId,
    apiBaseUrl: trimTrailingSlash(config.apiBaseUrl ?? DEFAULT_BC_API_BASE_URL),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function withQuery(
  path: string,
  query: { top?: number; filter?: string },
): string {
  const params = new URLSearchParams();
  if (query.top !== undefined) params.set("$top", String(query.top));
  if (query.filter) params.set("$filter", query.filter);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function buildBcApiError(
  response: Response,
  url: string,
): Promise<BcApiError> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = payload.error?.code;
    message = payload.error?.message;
  } catch {
    message = await response.text().catch(() => undefined);
  }

  return new BcApiError({
    status: response.status,
    statusText: response.statusText,
    code,
    message,
    retryAfter: response.headers.get("Retry-After"),
    requestId:
      response.headers.get("request-id") ??
      response.headers.get("x-ms-request-id"),
    url,
  });
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function parseRetryDelay(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripCacheKey(token: CachedToken): BcAccessToken {
  return {
    accessToken: token.accessToken,
    tokenType: token.tokenType,
    expiresIn: token.expiresIn,
    expiresAt: token.expiresAt,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
