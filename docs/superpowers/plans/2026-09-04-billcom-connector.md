# Bill.com Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an authenticated, toggleable Bill.com connection — credential storage, per-environment connection records, an enable/disable switch, and a test-connection action — without writing any business data to Bill.com.

**Architecture:** A pure HTTP client (`client.ts`) that depends on an injected `SessionStore` interface and an injected `fetch`, so it is fully testable without a network or a database. A database-backed `sessionStore.ts` implements that interface against the connection row. A `connection.ts` factory loads the row, decrypts credentials from Supabase Vault, and wires the two together. Server actions and an admin UI card sit on top.

**Tech Stack:** Next.js 15 (App Router, server actions), TypeScript, Supabase (Postgres + Vault), Vitest.

**Spec:** [`docs/superpowers/specs/2026-09-03-billcom-connector-design.md`](../specs/2026-09-03-billcom-connector-design.md)

## Global Constraints

Every task's requirements implicitly include these.

- **Bill.com API version is v3.** Login is `POST {apiBaseUrl}/v3/login`; authenticated calls send `devKey` and `sessionId` as HTTP headers.
- **Secret values never appear in a table column.** Only Vault pointer UUIDs (`dev_key_secret_id`, `password_secret_id`) are stored. Secrets are read back only through `SECURITY DEFINER` RPCs.
- **Migrations must stay re-runnable.** Use `create table if not exists`, `create index if not exists`, `create or replace function`. **Do not write a `create policy` statement** — it has no `IF NOT EXISTS` and would make the migration fail with `42710` on re-application.
- **RLS is enabled with no select policy.** All access goes through service-role server actions. This is deliberate: the row holds `session_id`, a live bearer credential.
- **Session reuse window is 30 minutes**; Bill.com's idle expiry is 35. **`session_last_used_at` is rewritten only when the stored value is older than 5 minutes.**
- **This slice writes no business data to Bill.com.** The only network calls are `POST /v3/login` and, in tests, a stubbed authenticated request.
- **All server actions are admin-gated** (`access.isAdmin`) and use `createServiceClient()` for writes.
- Migration numbers `041`–`044` are taken. This plan adds `045` and `046`.
- **Every connection-id-keyed operation must be org-scoped by the caller.** The Vault RPCs and the client factory are keyed by connection id alone, and Supabase does NOT error when an org-scoped `.update()`/`.delete()` matches zero rows. So a foreign connection id silently slips past a scoped row write and still reaches the RPC. `loadBillcomConnection` and `createBillcomClientForConnection` take an `organizationId`, and `saveBillcomConnection`/`deleteBillcomConnection`/`testBillcomConnection` call an ownership guard that fails closed before any Vault RPC or Bill.com call.
- **A `'use server'` module may only export async functions.** No `interface`, `type`, or `export type` declarations in `actions/billcom.ts` — Turbopack's dev transform sweeps them into the server-actions manifest and fails the dev build, while `tsc`, `next build` and the test suite all still pass. All shared types live in `@/types/billcom`. See commit `93094f8`.

## File Structure

| File | Responsibility |
|---|---|
| `nexus/supabase/migrations/045_add_billcom_connections.sql` | `billcom_connections` table, indexes, RLS enabled with no policy |
| `nexus/supabase/migrations/046_billcom_credential_functions.sql` | Five Vault accessor functions (get/set pairs plus delete) |
| `nexus/src/types/billcom.ts` | All Bill.com types: row, form input, client-safe summary, test result |
| `nexus/src/lib/billcom/errors.ts` | Typed error classes |
| `nexus/src/lib/billcom/client.ts` | Pure HTTP client; login, authenticated request, 401 retry |
| `nexus/src/lib/billcom/sessionStore.ts` | DB-backed `SessionStore`, including the 5-minute write throttle |
| `nexus/src/lib/billcom/connection.ts` | `createBillcomClientForConnection` — loads row **scoped by organization**, decrypts secrets, wires store |
| `nexus/src/app/actions/billcom.ts` | Server actions: save, toggle, delete, test |
| `nexus/src/components/billcom/BillcomConnectionsCard.tsx` | Admin UI card |

---

### Task 1: Database schema and row types

**Files:**
- Create: `nexus/supabase/migrations/045_add_billcom_connections.sql`
- Create: `nexus/src/types/billcom.ts`

**Interfaces:**
- Produces: table `billcom_connections`; TypeScript `BillcomConnection`, `BillcomEnvironment`, `BillcomConnectionInput`, `BillcomConnectionSummary`, `BillcomTestResult`.

- [ ] **Step 1: Write the migration**

Create `nexus/supabase/migrations/045_add_billcom_connections.sql`:

```sql
-- 045_add_billcom_connections.sql
-- One row per Bill.com environment per organization.
--
-- Credentials live on this row rather than in a shared per-org table (the
-- pattern business_central_credentials uses) because Bill.com requires
-- separate developer keys per environment — sandbox keys do not work against
-- production, so a shared credential set would be empty structure.
--
-- RLS is enabled with NO SELECT POLICY, deliberately departing from
-- business_central_items and item_templates. session_id is a live bearer
-- credential: anyone holding it can act as this connection against Bill.com
-- until it idles out. A member-scoped policy would expose it through PostgREST
-- to every user in the organization. Nothing needs client-side reads here —
-- every access goes through a service-role server action, which bypasses RLS.
--
-- This migration is re-runnable: it contains no `create policy`, which is the
-- one statement with no IF NOT EXISTS form (see migrations 039 and 041).

create table if not exists public.billcom_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  environment text not null check (environment in ('sandbox', 'production')),
  api_base_url text not null,
  username text not null,
  billcom_organization_id text not null,
  dev_key_secret_id uuid,
  password_secret_id uuid,
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  session_id text,
  session_last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billcom_connections_org_idx
  on public.billcom_connections (organization_id);

-- At most one default connection per organization, mirroring
-- idx_bc_connections_one_default_per_org.
create unique index if not exists billcom_connections_one_default_per_org
  on public.billcom_connections (organization_id)
  where is_default;

alter table public.billcom_connections enable row level security;
```

- [ ] **Step 2: Apply the migration and verify**

Apply `045` in the Supabase SQL editor, then run:

```sql
select
  to_regclass('public.billcom_connections') is not null as table_exists,
  (select relrowsecurity from pg_class where relname = 'billcom_connections') as rls_enabled,
  (select count(*) from pg_policy
     where polrelid = 'public.billcom_connections'::regclass) as policy_count;
```

Expected: `table_exists = true`, `rls_enabled = true`, `policy_count = 0`.

The zero policy count is the point — it is what makes the table deny-by-default for clients.

- [ ] **Step 3: Add the row types**

Create `nexus/src/types/billcom.ts`:

```typescript
export type BillcomEnvironment = 'sandbox' | 'production';

export interface BillcomConnection {
  id: string;
  organization_id: string;
  display_name: string;
  environment: BillcomEnvironment;
  api_base_url: string;
  username: string;
  billcom_organization_id: string;
  dev_key_secret_id: string | null;
  password_secret_id: string | null;
  is_enabled: boolean;
  is_default: boolean;
  session_id: string | null;
  session_last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the admin form submits. Secrets are write-only and optional on edit. */
export interface BillcomConnectionInput {
  id?: string;
  displayName: string;
  environment: BillcomEnvironment;
  apiBaseUrl: string;
  username: string;
  billcomOrganizationId: string;
  devKey?: string;
  password?: string;
  isDefault: boolean;
}

/**
 * Safe projection returned to the client: no Vault pointers, no session id.
 *
 * Lives here rather than in the 'use server' actions module. A 'use server'
 * module may only export async functions — Turbopack's dev transform sweeps
 * even `export type` into the server-actions manifest and fails the dev build,
 * while tsc/build/test all still pass. See commit 93094f8.
 */
export interface BillcomConnectionSummary {
  id: string;
  displayName: string;
  environment: BillcomEnvironment;
  apiBaseUrl: string;
  username: string;
  billcomOrganizationId: string;
  isEnabled: boolean;
  isDefault: boolean;
  hasCredentials: boolean;
}

export interface BillcomTestResult {
  ok: boolean;
  message: string;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd nexus && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add nexus/supabase/migrations/045_add_billcom_connections.sql nexus/src/types/billcom.ts
git commit -m "feat(billcom): add billcom_connections table and row types"
```

---

### Task 2: Vault credential accessors

**Files:**
- Create: `nexus/supabase/migrations/046_billcom_credential_functions.sql`

**Interfaces:**
- Consumes: `billcom_connections.dev_key_secret_id` / `.password_secret_id` from Task 1.
- Produces: RPCs `set_billcom_dev_key(p_connection_id uuid, p_secret text) returns uuid`, `get_billcom_dev_key(p_connection_id uuid) returns text`, `set_billcom_password(...)`, `get_billcom_password(...)` — same signatures for both pairs — plus `delete_billcom_secrets(p_connection_id uuid) returns void`.

- [ ] **Step 1: Write the migration**

Create `nexus/supabase/migrations/046_billcom_credential_functions.sql`. Each setter follows the same three-branch logic as `set_bc_client_secret`: rotate an existing pointer, adopt an orphaned secret found under the canonical name, or create a new one.

```sql
-- 046_billcom_credential_functions.sql
-- Vault accessors for Bill.com credentials, keyed by connection id rather than
-- organization id (credentials are per-environment). Shaped exactly like
-- set_bc_client_secret / get_bc_client_secret.
--
-- Re-runnable: create or replace function is idempotent.

create or replace function public.set_billcom_dev_key(p_connection_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_name text := 'billcom_dev_key_' || p_connection_id::text;
begin
  select dev_key_secret_id into v_secret_id
  from public.billcom_connections
  where id = p_connection_id;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_secret);
  else
    select id into v_secret_id from vault.secrets where name = v_name;

    if v_secret_id is not null then
      perform vault.update_secret(v_secret_id, p_secret);
    else
      v_secret_id := vault.create_secret(
        p_secret, v_name,
        'Bill.com developer key for connection ' || p_connection_id::text
      );
    end if;

    update public.billcom_connections
    set dev_key_secret_id = v_secret_id, updated_at = now()
    where id = p_connection_id;
  end if;

  return v_secret_id;
end;
$$;

create or replace function public.get_billcom_dev_key(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  select dev_key_secret_id into v_secret_id
  from public.billcom_connections
  where id = p_connection_id;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_secret;
end;
$$;

create or replace function public.set_billcom_password(p_connection_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_name text := 'billcom_password_' || p_connection_id::text;
begin
  select password_secret_id into v_secret_id
  from public.billcom_connections
  where id = p_connection_id;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_secret);
  else
    select id into v_secret_id from vault.secrets where name = v_name;

    if v_secret_id is not null then
      perform vault.update_secret(v_secret_id, p_secret);
    else
      v_secret_id := vault.create_secret(
        p_secret, v_name,
        'Bill.com password for connection ' || p_connection_id::text
      );
    end if;

    update public.billcom_connections
    set password_secret_id = v_secret_id, updated_at = now()
    where id = p_connection_id;
  end if;

  return v_secret_id;
end;
$$;

create or replace function public.get_billcom_password(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  select password_secret_id into v_secret_id
  from public.billcom_connections
  where id = p_connection_id;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_secret;
end;
$$;

-- Deleting a connection row must not orphan its Vault entries. Called before
-- the row is removed, while the pointers are still readable.
create or replace function public.delete_billcom_secrets(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev_key_id uuid;
  v_password_id uuid;
begin
  select dev_key_secret_id, password_secret_id
  into v_dev_key_id, v_password_id
  from public.billcom_connections
  where id = p_connection_id;

  if v_dev_key_id is not null then
    delete from vault.secrets where id = v_dev_key_id;
  end if;

  if v_password_id is not null then
    delete from vault.secrets where id = v_password_id;
  end if;
end;
$$;

-- Lock the wrappers down: only the service-role client may call them.
--
-- This is NOT optional. Postgres grants EXECUTE to PUBLIC on a newly created
-- function, and Supabase exposes public-schema functions as PostgREST RPC
-- endpoints callable by anon/authenticated. These functions are SECURITY
-- DEFINER and take a connection id as a parameter, so without this block any
-- caller could read, overwrite or erase the Bill.com credentials of ANY
-- connection in the system — defeating the point of storing them in Vault.
--
-- `create or replace function` does not preserve prior grants, so any future
-- migration that redefines these must restate this block. Migrations 024 and
-- 025 set the same precedent for set_bc_client_secret/get_bc_client_secret.

revoke all on function public.set_billcom_dev_key(uuid, text) from public, anon;
revoke all on function public.get_billcom_dev_key(uuid) from public, anon;
revoke all on function public.set_billcom_password(uuid, text) from public, anon;
revoke all on function public.get_billcom_password(uuid) from public, anon;
revoke all on function public.delete_billcom_secrets(uuid) from public, anon;

grant execute on function public.set_billcom_dev_key(uuid, text) to service_role;
grant execute on function public.get_billcom_dev_key(uuid) to service_role;
grant execute on function public.set_billcom_password(uuid, text) to service_role;
grant execute on function public.get_billcom_password(uuid) to service_role;
grant execute on function public.delete_billcom_secrets(uuid) to service_role;
```

- [ ] **Step 2: Apply and round-trip the functions**

Apply `046`, then verify a real round trip:

```sql
insert into public.billcom_connections
  (organization_id, display_name, environment, api_base_url, username, billcom_organization_id)
select id, 'Vault round-trip test', 'sandbox',
       'https://gateway.stage.bill.com/connect', 'test@example.com', '008TESTORG'
from public.organizations limit 1
returning id;
```

Take the returned id and run, substituting it for `<id>`:

```sql
select public.set_billcom_dev_key('<id>', 'dev-key-value');
select public.set_billcom_password('<id>', 'password-value');
select public.get_billcom_dev_key('<id>') = 'dev-key-value' as dev_key_ok,
       public.get_billcom_password('<id>') = 'password-value' as password_ok,
       dev_key_secret_id is not null as dev_pointer_set,
       password_secret_id is not null as password_pointer_set
from public.billcom_connections where id = '<id>';
```

Expected: all four columns `true`.

Then call `set_billcom_dev_key('<id>', 'rotated')` a second time and confirm `get_billcom_dev_key` returns `rotated` while `dev_key_secret_id` is unchanged — this is the rotation branch.

- [ ] **Step 3: Verify secret deletion**

```sql
select public.delete_billcom_secrets('<id>');
select public.get_billcom_dev_key('<id>') is null as dev_key_gone,
       public.get_billcom_password('<id>') is null as password_gone;
```

Expected: both `true`. This is what keeps deleting a connection from orphaning Vault entries.

- [ ] **Step 4: Clean up the test row**

```sql
delete from public.billcom_connections where display_name = 'Vault round-trip test';
```

- [ ] **Step 5: Commit**

```bash
git add nexus/supabase/migrations/046_billcom_credential_functions.sql
git commit -m "feat(billcom): add Vault accessors for Bill.com credentials"
```

---

### Task 3: Typed errors and the pure HTTP client

**Files:**
- Create: `nexus/src/lib/billcom/errors.ts`
- Create: `nexus/src/lib/billcom/client.ts`
- Test: `nexus/src/lib/billcom/client.test.ts`

**Interfaces:**
- Produces: `BillcomAuthError`, `BillcomSessionExpiredError`, `BillcomRateLimitError`, `BillcomConnectionDisabledError`; `SessionStore` interface; `BillcomClientConfig`; `createBillcomClient(config): BillcomClient` with `login()`, `request<T>(path, init?)`, `getSession()`.

- [ ] **Step 1: Write the errors module**

Create `nexus/src/lib/billcom/errors.ts`:

```typescript
export interface BillcomErrorDetails {
  status: number;
  statusText: string;
  code?: string;
  message?: string;
  url: string;
}

export class BillcomApiError extends Error {
  readonly details: BillcomErrorDetails;

  constructor(details: BillcomErrorDetails) {
    super(details.message || `${details.status} ${details.statusText}`);
    this.name = 'BillcomApiError';
    this.details = details;
  }
}

export class BillcomAuthError extends BillcomApiError {
  constructor(details: BillcomErrorDetails) {
    super(details);
    this.name = 'BillcomAuthError';
  }
}

export class BillcomSessionExpiredError extends BillcomApiError {
  constructor(details: BillcomErrorDetails) {
    super(details);
    this.name = 'BillcomSessionExpiredError';
  }
}

/** Bill.com returns BDC_1144 when the hourly request ceiling is exceeded. */
export class BillcomRateLimitError extends BillcomApiError {
  constructor(details: BillcomErrorDetails) {
    super(details);
    this.name = 'BillcomRateLimitError';
  }
}

export class BillcomConnectionDisabledError extends Error {
  constructor(connectionId: string) {
    super(
      `Bill.com connection ${connectionId} is disabled. Enable it in Admin before making requests.`,
    );
    this.name = 'BillcomConnectionDisabledError';
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `nexus/src/lib/billcom/client.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { createBillcomClient, type SessionStore } from './client';
import { BillcomAuthError, BillcomRateLimitError } from './errors';

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

    await expect(client.request('/v3/customers')).rejects.toBeInstanceOf(BillcomAuthError);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd nexus && npx vitest run src/lib/billcom/client.test.ts`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 4: Implement the client**

Create `nexus/src/lib/billcom/client.ts`:

```typescript
import 'server-only';

import {
  BillcomApiError,
  BillcomAuthError,
  BillcomRateLimitError,
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
  if (details.status === 401) return new BillcomAuthError(details);
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd nexus && npx vitest run src/lib/billcom/client.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add nexus/src/lib/billcom/errors.ts nexus/src/lib/billcom/client.ts nexus/src/lib/billcom/client.test.ts
git commit -m "feat(billcom): add typed errors and session-aware HTTP client"
```

---

### Task 4: Database-backed session store

**Files:**
- Create: `nexus/src/lib/billcom/sessionStore.ts`
- Test: `nexus/src/lib/billcom/sessionStore.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `StoredSession` from Task 3.
- Produces: `createDbSessionStore(supabase, connectionId): SessionStore`; `SESSION_TOUCH_THROTTLE_MS`.

- [ ] **Step 1: Write the failing tests**

Create `nexus/src/lib/billcom/sessionStore.test.ts`. The Supabase client is stubbed — these tests assert which calls are made, not database behaviour.

```typescript
import { describe, expect, it, vi } from 'vitest';

import { createDbSessionStore } from './sessionStore';

interface StubRow {
  session_id: string | null;
  session_last_used_at: string | null;
}

/** Minimal stub of the Supabase query chain used by the store. */
function stubSupabase(row: StubRow | null) {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: row, error: null })) })),
      })),
      update,
    })),
  };
  return { supabase, update };
}

describe('Bill.com DB session store', () => {
  it('returns null when the row holds no session', async () => {
    const { supabase } = stubSupabase({ session_id: null, session_last_used_at: null });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    expect(await store.get()).toBeNull();
  });

  it('returns the stored session with lastUsedAt parsed as a Date', async () => {
    const when = '2026-09-04T10:00:00.000Z';
    const { supabase } = stubSupabase({ session_id: 'session-1', session_last_used_at: when });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    const stored = await store.get();

    expect(stored?.sessionId).toBe('session-1');
    expect(stored?.lastUsedAt.toISOString()).toBe(when);
  });

  it('writes the session id and a fresh timestamp on set', async () => {
    const { supabase, update } = stubSupabase(null);
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.set('session-2');

    const payload = update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.session_id).toBe('session-2');
    expect(typeof payload.session_last_used_at).toBe('string');
  });

  it('does not write on touch inside the throttle window', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const { supabase, update } = stubSupabase({
      session_id: 'session-1',
      session_last_used_at: recent,
    });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.touch();

    expect(update).not.toHaveBeenCalled();
  });

  it('writes on touch once the throttle window has passed', async () => {
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    const { supabase, update } = stubSupabase({
      session_id: 'session-1',
      session_last_used_at: stale,
    });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.touch();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('nulls both session columns on clear', async () => {
    const { supabase, update } = stubSupabase({
      session_id: 'session-1',
      session_last_used_at: new Date().toISOString(),
    });
    const store = createDbSessionStore(supabase as never, 'conn-1');

    await store.clear();

    expect(update.mock.calls[0][0]).toEqual({
      session_id: null,
      session_last_used_at: null,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd nexus && npx vitest run src/lib/billcom/sessionStore.test.ts`
Expected: FAIL — `Failed to resolve import "./sessionStore"`.

- [ ] **Step 3: Implement the store**

Create `nexus/src/lib/billcom/sessionStore.ts`:

```typescript
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { SessionStore, StoredSession } from './client';

/**
 * `session_last_used_at` only needs to be accurate to within Bill.com's
 * 35-minute idle window. Writing it on every API call would mean a database
 * write per API call, so only write when the stored value is older than this.
 */
export const SESSION_TOUCH_THROTTLE_MS = 5 * 60_000;

export function createDbSessionStore(
  supabase: SupabaseClient,
  connectionId: string,
): SessionStore {
  async function readRow(): Promise<StoredSession | null> {
    const { data, error } = await supabase
      .from('billcom_connections')
      .select('session_id, session_last_used_at')
      .eq('id', connectionId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read the Bill.com session: ${error.message}`);
    }
    if (!data?.session_id || !data.session_last_used_at) {
      return null;
    }
    return {
      sessionId: data.session_id as string,
      lastUsedAt: new Date(data.session_last_used_at as string),
    };
  }

  async function write(payload: Record<string, string | null>): Promise<void> {
    const { error } = await supabase
      .from('billcom_connections')
      .update(payload)
      .eq('id', connectionId);
    if (error) {
      throw new Error(`Failed to update the Bill.com session: ${error.message}`);
    }
  }

  return {
    get: readRow,

    async set(sessionId: string) {
      await write({
        session_id: sessionId,
        session_last_used_at: new Date().toISOString(),
      });
    },

    async touch() {
      const stored = await readRow();
      if (!stored) return;
      if (Date.now() - stored.lastUsedAt.getTime() < SESSION_TOUCH_THROTTLE_MS) return;
      await write({ session_last_used_at: new Date().toISOString() });
    },

    async clear() {
      await write({ session_id: null, session_last_used_at: null });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd nexus && npx vitest run src/lib/billcom/sessionStore.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add nexus/src/lib/billcom/sessionStore.ts nexus/src/lib/billcom/sessionStore.test.ts
git commit -m "feat(billcom): add DB-backed session store with throttled touch"
```

---

### Task 5: Org-scoped client factory

**Files:**
- Create: `nexus/src/lib/billcom/connection.ts`
- Test: `nexus/src/lib/billcom/connection.test.ts`

**Interfaces:**
- Consumes: `createBillcomClient` (Task 3), `createDbSessionStore` (Task 4), `BillcomConnectionDisabledError` (Task 3), RPCs from Task 2.
- Produces: `createBillcomClientForConnection(connectionId, organizationId, options?): Promise<BillcomClient>`; `loadBillcomConnection(supabase, connectionId, organizationId): Promise<BillcomConnection>`. **Both take the organization id and scope the query by it** — see the Global Constraint on org scoping.

- [ ] **Step 1: Write the failing tests**

Create `nexus/src/lib/billcom/connection.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { createBillcomClientForConnection } from './connection';
import { BillcomConnectionDisabledError } from './errors';

const row = {
  id: 'conn-1',
  organization_id: 'org-1',
  display_name: 'Sandbox',
  environment: 'sandbox',
  api_base_url: 'https://gateway.stage.bill.com/connect',
  username: 'user@example.com',
  billcom_organization_id: '008ORG',
  is_enabled: true,
  session_id: null,
  session_last_used_at: null,
};

function stubSupabase(connectionRow: Record<string, unknown> | null, secrets: Record<string, string | null>) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: connectionRow, error: null })) })),
      })),
      update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
    })),
    rpc: vi.fn(async (name: string) => ({ data: secrets[name] ?? null, error: null })),
  };
}

describe('Bill.com connection factory', () => {
  it('refuses to build a client for a disabled connection', async () => {
    const supabase = stubSupabase({ ...row, is_enabled: false }, {});

    await expect(
      createBillcomClientForConnection('conn-1', { supabase: supabase as never }),
    ).rejects.toBeInstanceOf(BillcomConnectionDisabledError);

    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('throws a clear error when the connection does not exist', async () => {
    const supabase = stubSupabase(null, {});

    await expect(
      createBillcomClientForConnection('missing', { supabase: supabase as never }),
    ).rejects.toThrow(/was not found/);
  });

  it('throws a clear error when credentials have not been stored', async () => {
    const supabase = stubSupabase(row, { get_billcom_dev_key: null, get_billcom_password: null });

    await expect(
      createBillcomClientForConnection('conn-1', { supabase: supabase as never }),
    ).rejects.toThrow(/credentials/i);
  });

  it('decrypts both secrets and returns a usable client', async () => {
    const supabase = stubSupabase(row, {
      get_billcom_dev_key: 'dev-key',
      get_billcom_password: 'password',
    });

    const client = await createBillcomClientForConnection('conn-1', {
      supabase: supabase as never,
      fetchImpl: vi.fn<typeof fetch>(),
    });

    expect(typeof client.login).toBe('function');
    expect(supabase.rpc).toHaveBeenCalledWith('get_billcom_dev_key', { p_connection_id: 'conn-1' });
    expect(supabase.rpc).toHaveBeenCalledWith('get_billcom_password', { p_connection_id: 'conn-1' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd nexus && npx vitest run src/lib/billcom/connection.test.ts`
Expected: FAIL — `Failed to resolve import "./connection"`.

- [ ] **Step 3: Implement the factory**

Create `nexus/src/lib/billcom/connection.ts`:

```typescript
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createServiceClient } from '@/lib/supabase/server';
import type { BillcomConnection } from '@/types/billcom';
import { createBillcomClient, type BillcomClient } from './client';
import { BillcomConnectionDisabledError } from './errors';
import { createDbSessionStore } from './sessionStore';

export interface CreateBillcomClientOptions {
  supabase?: SupabaseClient;
  fetchImpl?: typeof fetch;
}

export async function loadBillcomConnection(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<BillcomConnection> {
  const { data, error } = await supabase
    .from('billcom_connections')
    .select('*')
    .eq('id', connectionId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load the Bill.com connection: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Bill.com connection ${connectionId} was not found.`);
  }
  return data as BillcomConnection;
}

export async function createBillcomClientForConnection(
  connectionId: string,
  options: CreateBillcomClientOptions = {},
): Promise<BillcomClient> {
  const supabase = options.supabase ?? createServiceClient();
  const connection = await loadBillcomConnection(supabase, connectionId);

  // Check the toggle before decrypting anything — a disabled connection must
  // make no network call and needs no credentials present.
  if (!connection.is_enabled) {
    throw new BillcomConnectionDisabledError(connectionId);
  }

  const { data: devKey, error: devKeyError } = await supabase.rpc('get_billcom_dev_key', {
    p_connection_id: connectionId,
  });
  if (devKeyError) {
    throw new Error(`Failed to read the Bill.com developer key: ${devKeyError.message}`);
  }

  const { data: password, error: passwordError } = await supabase.rpc('get_billcom_password', {
    p_connection_id: connectionId,
  });
  if (passwordError) {
    throw new Error(`Failed to read the Bill.com password: ${passwordError.message}`);
  }

  if (!devKey || !password) {
    throw new Error(
      'Bill.com credentials are not fully configured for this connection. Set the developer key and password in Admin.',
    );
  }

  return createBillcomClient({
    apiBaseUrl: connection.api_base_url,
    devKey: devKey as string,
    username: connection.username,
    password: password as string,
    billcomOrganizationId: connection.billcom_organization_id,
    sessionStore: createDbSessionStore(supabase, connectionId),
    fetchImpl: options.fetchImpl,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd nexus && npx vitest run src/lib/billcom/connection.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add nexus/src/lib/billcom/connection.ts nexus/src/lib/billcom/connection.test.ts
git commit -m "feat(billcom): add org-scoped client factory with disabled-connection guard"
```

---

### Task 6: Server actions

**Files:**
- Create: `nexus/src/app/actions/billcom.ts`

**Interfaces:**
- Consumes: `BillcomConnectionInput`, `BillcomConnection` (Task 1); `createBillcomClientForConnection` (Task 5).
- Produces: `listBillcomConnections()`, `saveBillcomConnection(input)`, `setBillcomConnectionEnabled(id, enabled)`, `deleteBillcomConnection(id)`, `testBillcomConnection(id)`.

- [ ] **Step 1: Write the actions**

Create `nexus/src/app/actions/billcom.ts`. Note the shape of `listBillcomConnections`: it never returns secret pointers or the session, so the client component cannot leak them.

```typescript
'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/app/actions/users';
import { createBillcomClientForConnection } from '@/lib/billcom/connection';
import { resolveUserAccess } from '@/lib/auth/permissions';
import { createServiceClient } from '@/lib/supabase/server';
import type {
  BillcomConnection,
  BillcomConnectionInput,
  BillcomConnectionSummary,
  BillcomTestResult,
} from '@/types/billcom';

/**
 * Everything here configures a financial integration — admin only.
 *
 * Deliberately does NOT use requireActiveBusinessCentralScope: Bill.com must be
 * configurable whether or not a Business Central environment exists. The two
 * integrations are independent, and coupling them here would make Bill.com
 * setup fail on an org that has not configured BC.
 */
async function requireAdmin(): Promise<{ orgId: string }> {
  const user = await getCurrentUser();
  const access = resolveUserAccess(user);

  if (!user || !access.isAdmin) {
    throw new Error('You do not have permission to manage Bill.com connections');
  }
  if (!user.organization_id) {
    throw new Error('Your user account is not assigned to an organization');
  }

  return { orgId: user.organization_id };
}

// NOTE: no interface or `export type` declarations in this file. A 'use server'
// module may only export async functions. BillcomConnectionSummary and
// BillcomTestResult live in @/types/billcom for that reason — see 93094f8.

export async function listBillcomConnections(): Promise<BillcomConnectionSummary[]> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('billcom_connections')
    .select('*')
    .eq('organization_id', orgId)
    .order('display_name', { ascending: true });
  if (error) throw error;

  return ((data ?? []) as BillcomConnection[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    environment: row.environment,
    apiBaseUrl: row.api_base_url,
    username: row.username,
    billcomOrganizationId: row.billcom_organization_id,
    isEnabled: row.is_enabled,
    isDefault: row.is_default,
    hasCredentials: Boolean(row.dev_key_secret_id && row.password_secret_id),
  }));
}

export async function saveBillcomConnection(input: BillcomConnectionInput): Promise<string> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  const row = {
    organization_id: orgId,
    display_name: input.displayName,
    environment: input.environment,
    api_base_url: input.apiBaseUrl,
    username: input.username,
    billcom_organization_id: input.billcomOrganizationId,
    is_default: input.isDefault,
    updated_at: new Date().toISOString(),
  };

  // Clear any other default first — the partial unique index allows only one.
  if (input.isDefault) {
    const { error } = await supabase
      .from('billcom_connections')
      .update({ is_default: false })
      .eq('organization_id', orgId)
      .neq('id', input.id ?? '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
  }

  let connectionId = input.id;

  if (connectionId) {
    const { error } = await supabase
      .from('billcom_connections')
      .update(row)
      .eq('id', connectionId)
      .eq('organization_id', orgId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from('billcom_connections')
      .insert(row)
      .select('id')
      .single();
    if (error) throw error;
    connectionId = (data as { id: string }).id;
  }

  // Secrets are write-only: a blank field on edit leaves the stored value alone.
  if (input.devKey) {
    const { error } = await supabase.rpc('set_billcom_dev_key', {
      p_connection_id: connectionId,
      p_secret: input.devKey,
    });
    if (error) throw error;
  }
  if (input.password) {
    const { error } = await supabase.rpc('set_billcom_password', {
      p_connection_id: connectionId,
      p_secret: input.password,
    });
    if (error) throw error;
  }

  revalidatePath('/admin');
  return connectionId;
}

export async function setBillcomConnectionEnabled(
  connectionId: string,
  enabled: boolean,
): Promise<void> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  // Disabling drops the cached session so a re-enable starts clean.
  const payload = enabled
    ? { is_enabled: true, updated_at: new Date().toISOString() }
    : {
        is_enabled: false,
        session_id: null,
        session_last_used_at: null,
        updated_at: new Date().toISOString(),
      };

  const { error } = await supabase
    .from('billcom_connections')
    .update(payload)
    .eq('id', connectionId)
    .eq('organization_id', orgId);
  if (error) throw error;

  revalidatePath('/admin');
}

export async function deleteBillcomConnection(connectionId: string): Promise<void> {
  const { orgId } = await requireAdmin();
  const supabase = createServiceClient();

  // Drop the Vault secrets first, while the pointers on the row are still
  // readable. Deleting the row first would orphan them permanently.
  const { error: secretsError } = await supabase.rpc('delete_billcom_secrets', {
    p_connection_id: connectionId,
  });
  if (secretsError) throw secretsError;

  const { error } = await supabase
    .from('billcom_connections')
    .delete()
    .eq('id', connectionId)
    .eq('organization_id', orgId);
  if (error) throw error;

  revalidatePath('/admin');
}

export async function testBillcomConnection(connectionId: string): Promise<BillcomTestResult> {
  await requireAdmin();

  try {
    const client = await createBillcomClientForConnection(connectionId);
    await client.login();
    return { ok: true, message: 'Connected to Bill.com and started a session.' };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error contacting Bill.com.',
    };
  }
}
```

- [ ] **Step 2: Verify it compiles and the suite still passes**

Run: `cd nexus && npx tsc --noEmit && npx vitest run src/lib/billcom`
Expected: no type errors; all Bill.com tests pass.

- [ ] **Step 3: Commit**

```bash
git add nexus/src/app/actions/billcom.ts
git commit -m "feat(billcom): add admin-gated server actions for connections"
```

---

### Task 7: Admin UI card

**Files:**
- Create: `nexus/src/components/billcom/BillcomConnectionsCard.tsx`
- Modify: `nexus/src/app/(protected)/admin/page.tsx`

**Interfaces:**
- Consumes: every action from Task 6.

- [ ] **Step 1: Build the card**

Create `nexus/src/components/billcom/BillcomConnectionsCard.tsx`. The structure and Tailwind classes below mirror `BcEnvironmentsCard` — read that file alongside this to match anything not shown here.

```tsx
'use client';

import { useEffect, useState } from 'react';

import {
  deleteBillcomConnection,
  listBillcomConnections,
  setBillcomConnectionEnabled,
  testBillcomConnection,
} from '@/app/actions/billcom';
// Types come from @/types/billcom, never from the 'use server' module.
import type { BillcomConnectionSummary } from '@/types/billcom';

export function BillcomConnectionsCard() {
  const [connections, setConnections] = useState<BillcomConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  async function reload() {
    try {
      setConnections(await listBillcomConnections());
    } catch (err) {
      console.error('Failed to load Bill.com connections:', err);
      setError('Failed to load connections');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function handleToggle(connection: BillcomConnectionSummary) {
    setBusyId(connection.id);
    try {
      await setBillcomConnectionEnabled(connection.id, !connection.isEnabled);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the connection');
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(connectionId: string) {
    setBusyId(connectionId);
    try {
      const result = await testBillcomConnection(connectionId);
      setResults((prev) => ({ ...prev, [connectionId]: result }));
    } catch (err) {
      // A THROWN error means the request never reached Bill.com — authorization,
      // or a connection that is not the caller's. Bill.com's own failures come
      // back as { ok: false } and belong in the per-row banner, so keep the two
      // cases visually distinct.
      setError(err instanceof Error ? err.message : 'Failed to test the connection');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(connection: BillcomConnectionSummary) {
    // deleteBillcomConnection calls delete_billcom_secrets, which permanently
    // removes the developer key and password from Vault. There is no undo.
    if (
      !confirm(
        `Delete "${connection.displayName}"? Its stored Bill.com credentials will be permanently deleted.`,
      )
    ) {
      return;
    }

    setBusyId(connection.id);
    try {
      await deleteBillcomConnection(connection.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete the connection');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm mt-6">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Bill.com Connections</h2>
          <p className="text-sm text-foreground-muted mt-0.5">
            Disabled by default. Nothing contacts Bill.com until a connection is enabled.
          </p>
        </div>
      </div>

      {error && (
        <div className="px-6 pt-4">
          <div className="p-3 bg-destructive-subtle border border-destructive/30 text-destructive rounded-md text-sm">
            {error}
          </div>
        </div>
      )}

      <div className="divide-y divide-border">
        {loading ? (
          <div className="px-6 py-8 text-center text-foreground-muted">Loading...</div>
        ) : connections.length === 0 ? (
          <div className="px-6 py-8 text-center text-foreground-muted">
            No Bill.com connections configured.
          </div>
        ) : (
          connections.map((connection) => {
            const result = results[connection.id];
            const canTest = connection.isEnabled && connection.hasCredentials;
            const testTitle = !connection.hasCredentials
              ? 'Set a developer key and password first'
              : !connection.isEnabled
                ? 'Enable the connection first'
                : 'Log in to Bill.com to verify this connection';

            return (
              <div key={connection.id} className="px-6 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{connection.displayName}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full border border-border text-foreground-muted">
                        {connection.environment}
                      </span>
                      {connection.isDefault && (
                        <span className="text-xs text-foreground-muted">Default</span>
                      )}
                    </div>
                    <p className="text-sm text-foreground-muted mt-0.5">
                      {connection.username} · {connection.billcomOrganizationId}
                      {!connection.hasCredentials && ' · credentials not set'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTest(connection.id)}
                      disabled={!canTest || busyId === connection.id}
                      title={testTitle}
                      className="px-3 py-1.5 text-sm border border-border rounded-md transition-colors disabled:opacity-50"
                    >
                      Test connection
                    </button>
                    <button
                      onClick={() => handleToggle(connection)}
                      disabled={busyId === connection.id}
                      className="px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors disabled:opacity-50"
                    >
                      {connection.isEnabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => handleDelete(connection)}
                      disabled={busyId === connection.id}
                      className="px-3 py-1.5 text-sm text-destructive rounded-md transition-colors disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {result && (
                  <div
                    className={`mt-3 p-3 rounded-md text-sm border ${
                      result.ok
                        ? 'bg-green-500/10 border-green-500/30 text-green-600'
                        : 'bg-destructive-subtle border-destructive/30 text-destructive'
                    }`}
                  >
                    {result.message}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 1b: Add the create/edit form**

Add a `BillcomConnectionForm` sub-component in the same file, shown when an "Add connection" button is clicked, calling `saveBillcomConnection`. Fields, in order:

| Field | Input | Notes |
|---|---|---|
| Display name | text | required |
| Environment | select | `sandbox` / `production`, required |
| API base URL | text | required; sandbox is `https://gateway.stage.bill.com/connect` |
| Username | text | required |
| Bill.com organization id | text | required; the `008…` value |
| Developer key | **`type="password"`** | required on create; blank on edit keeps stored value |
| Password | **`type="password"`** | required on create; blank on edit keeps stored value |
| Default | checkbox | |

**The two secret fields must never be pre-filled from server data** — no server action returns them, so there is nothing to pre-fill with. On edit, render them empty with placeholder `Leave blank to keep the stored value`.

- [ ] **Step 2: Mount it on the admin page**

Modify `nexus/src/app/(protected)/admin/page.tsx`. Add the import beside the existing BC cards:

```typescript
import { BillcomConnectionsCard } from '@/components/billcom/BillcomConnectionsCard';
```

Then add a section after the existing Business Central block:

```tsx
        <div className="mt-10">
          <h2 className="text-xl lg:text-2xl font-bold text-foreground">Bill.com</h2>
          <p className="text-foreground-muted mt-1">
            Accounts-receivable connections. Disabled by default; nothing syncs until enabled.
          </p>
          <BillcomConnectionsCard />
        </div>
```

- [ ] **Step 3: Verify the build**

Run: `cd nexus && npx tsc --noEmit && npm run lint && npm run build`
Expected: no type errors, no new lint errors, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add nexus/src/components/billcom/BillcomConnectionsCard.tsx "nexus/src/app/(protected)/admin/page.tsx"
git commit -m "feat(billcom): add Bill.com connections card to admin"
```

---

### Task 8: End-to-end verification against a real sandbox

**Prerequisite:** a Bill.com **sandbox** account must exist, with a developer key generated. Signup is self-service. This is a human step outside the codebase — the same class of prerequisite as publishing BC page 457, which blocked item-creation verification for three weeks.

**Files:** none — this task produces evidence, not code.

- [ ] **Step 1: Full local check**

Run: `cd nexus && npm test && npm run lint && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 2: Configure a connection**

Start the app (`cd nexus && npm run dev`), go to `/admin` → Bill.com → add a connection:

- Environment `sandbox`, API base URL `https://gateway.stage.bill.com/connect`
- Username, Bill.com organization id (the `008…` value), developer key, password

Leave it **disabled**.

- [ ] **Step 3: Verify the failure cases before the success case**

Test the guards first — a Test-connection button that always reports success would also pass the happy path.

- With the connection **disabled**, Test connection is unavailable. Enable it, then immediately disable it and confirm `session_id` was cleared:
  ```sql
  select is_enabled, session_id, session_last_used_at
  from billcom_connections where display_name = '<your name>';
  ```
  Expected: `is_enabled = false`, both session columns `null`.
- Enable it, edit the connection and save a **wrong** developer key, then Test connection. Expected: a red inline message, not a crash.

- [ ] **Step 4: Verify the success case**

Restore the correct developer key, Test connection. Expected: green "Connected to Bill.com and started a session."

Then confirm the session persisted:

```sql
select session_id is not null as session_stored, session_last_used_at
from billcom_connections where display_name = '<your name>';
```

Expected: `session_stored = true`, timestamp within the last minute.

- [ ] **Step 5: Verify session reuse**

Click Test connection twice more in quick succession, then check that `session_last_used_at` did **not** advance on the second click — the 5-minute throttle should suppress the write. Note that `testBillcomConnection` calls `login()` directly and so always creates a new session; reuse is exercised by `request()`, which this slice has no production caller for. Confirm reuse via the unit tests rather than the UI, and record that as the reason.

- [ ] **Step 6: Confirm the RLS lockdown**

From a normal (non-service-role) client session, confirm the table is unreadable:

```sql
set role authenticated;
select count(*) from public.billcom_connections;
reset role;
```

Expected: zero rows, since RLS is enabled with no policy. This is the property that keeps `session_id` out of reach.

- [ ] **Step 7: Record the evidence**

Add a Done entry to `BACKLOG.md` describing what was verified, following the format of the Task 8 entry for BC auto-numbering. Commit.

```bash
git add BACKLOG.md
git commit -m "docs: record Bill.com connector verification"
```

---

## Notes for the implementer

- **Do not add a `create policy` statement to either migration.** The RLS design depends on there being no policy, and adding one would also break re-runnability.
- **Do not return secrets or `session_id` from any server action.** `listBillcomConnections` projects to a safe summary type deliberately; keep it that way.
- The 3-concurrent-request limit is not addressed here and does not need to be — this slice makes one call at a time. It constrains piece E.
- `testBillcomConnection` swallows errors into a result object rather than throwing, because the UI renders the message inline. That is intentional and specific to this action; the client itself throws typed errors.
