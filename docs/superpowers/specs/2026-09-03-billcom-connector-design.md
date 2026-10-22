# Bill.com Connector — Design

**Date:** 2026-09-03
**Status:** Approved design, ready for implementation planning.
**Scope:** The connection-plumbing slice of **piece D** in the six-piece decomposition recorded in
[`2026-07-24-billcom-ar-sync-feasibility-spike.md`](./2026-07-24-billcom-ar-sync-feasibility-spike.md).

## Summary

Establish an authenticated, toggleable connection between Nexus and Bill.com: credential storage,
per-environment connection records, an enable/disable switch, and a test-connection action that
proves a login succeeds.

Nothing in this slice writes business data to Bill.com and nothing reads from it beyond the login
handshake. The point is to solve Bill.com's unusual session-based authentication in isolation,
before any push logic depends on it.

## Goals

- Store Bill.com credentials with the same safety as Business Central's: secret values in Supabase
  Vault, never in an application-readable column.
- Support sandbox and production side by side, so development never risks touching live financial data.
- Make the connection independently enableable and disableable, as the spike confirmed is required.
- Solve session caching correctly for a serverless runtime, so the connector does not degrade under
  real traffic.
- Give an operator a way to verify a connection works before anything depends on it.

## Non-goals

- **Customer push.** Deferred to the remainder of piece D. It carries the unresolved
  customer-matching-key question, which should not land in the same branch as the auth work.
- **Invoice push and payment status pull.** Piece E.
- **Payment posting into Business Central.** Piece F.
- **Webhooks.** The spike's polling-first recommendation stands; the data model is identical either way.
- **Concurrency throttling.** Bill.com's 3-concurrent-requests-per-devKey limit does not bind on a
  slice that makes one call at a time. It constrains piece E's bulk push and is recorded below, not
  solved here.

## Decisions

Settled during design. Recorded so they are not relitigated.

| Decision | Choice | Why |
|---|---|---|
| First slice | Connection plumbing only; no writes to Bill.com | Isolates the novel session-auth problem. Mirrors how the BC connection landed before any sync existed. |
| Environments | Sandbox and production together, from the start | Bill.com requires separate developer keys per environment, so the multi-environment case cannot be retrofitted cheaply. Costs nothing extra now. |
| Credential placement | On the connection row, not a shared per-org table | Diverges deliberately from `business_central_credentials`. BC can share one credential set across environments; Bill.com cannot, so the split would be empty structure. |
| Secret storage | Two Vault pointers per connection (devKey, password) | Matches the `set_bc_client_secret` precedent. Two pointers rather than one JSON blob because rotating a devKey and rotating a password are separate operational events. |
| Session cache | Persisted on the connection row, shared across instances | Module-level caching (the BC client's approach) does not survive serverless cold starts. At 200 logins/hour per devKey, per-instance login would degrade exactly when the app gets busy. |
| Row-level security | Enabled with **no select policy**; all access via service-role | Persisting the session makes the row hold a live bearer credential. The member-scoped select policy used elsewhere in the schema would expose it to every user in the organization. Nothing needs client-side reads, so deny-by-default costs nothing. |
| Login stampedes | Tolerated; last-writer-wins | Two instances can briefly both log in. At 200/hour that is affordable, and a distributed lock is disproportionate to the problem. |
| `last_used_at` writes | Throttled to ~5-minute granularity | Writing on every API call means a database write per API call, for a value that only needs to be accurate to within the 35-minute idle window. |

## Data model

### `billcom_connections`

One row per Bill.com environment per organization.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | primary key |
| `organization_id` | uuid | not null, references `organizations(id)` on delete cascade |
| `display_name` | text | not null; human label for the environment |
| `environment` | text | not null, `check (environment in ('sandbox','production'))` |
| `api_base_url` | text | not null; differs between sandbox and production |
| `username` | text | not null; Bill.com login user |
| `billcom_organization_id` | text | not null; Bill.com's own organization id (`008` prefix) |
| `dev_key_secret_id` | uuid | Vault pointer; never the value |
| `password_secret_id` | uuid | Vault pointer; never the value |
| `is_enabled` | boolean | not null, default **false** |
| `is_default` | boolean | not null, default false |
| `session_id` | text | cached Bill.com session; null when none held |
| `session_last_used_at` | timestamptz | drives idle-expiry calculation |
| `created_at` / `updated_at` | timestamptz | not null, default `now()` |

Indexes:

- `(organization_id)` for lookup.
- Partial unique on `(organization_id) where is_default` — at most one default per organization,
  mirroring `idx_bc_connections_one_default_per_org`.

Row-level security: enabled, with **no select policy at all**. This deliberately departs from
`business_central_items` and `item_templates`, which grant organization members read access.

The reason is `session_id`. It is a live bearer credential: anyone holding it can act as the
connection against Bill.com until it idles out. A member-scoped select policy would expose it through
PostgREST to every user in the organization. Business Central has no equivalent exposure because its
access token lives only in process memory and is never persisted.

Nothing needs client-side reads here — the admin UI is server-rendered and every access already goes
through a service-role server action, which bypasses RLS. Enabling RLS with no policy therefore makes
the table deny-by-default for clients while leaving the server path unchanged. The same reasoning
covers the Vault pointers, username and Bill.com organization id, which stay unreadable as a
consequence rather than needing separate protection.

Keeping the session on the connection row (rather than in a separate table) is safe under this
arrangement and avoids a join on every request.

### Credential accessors

Two `SECURITY DEFINER` function pairs, shaped exactly like `set_bc_client_secret` /
`get_bc_client_secret`, keyed by connection id rather than organization id:

- `set_billcom_dev_key(p_connection_id uuid, p_secret text) returns uuid`
- `get_billcom_dev_key(p_connection_id uuid) returns text`
- `set_billcom_password(p_connection_id uuid, p_secret text) returns uuid`
- `get_billcom_password(p_connection_id uuid) returns text`

Each setter follows the established three-branch logic: rotate the existing Vault secret when the
pointer is present; adopt and rotate an orphaned secret found under the canonical name; otherwise
create a new one. Canonical names are `billcom_dev_key_<connection_id>` and
`billcom_password_<connection_id>`.

## Session lifecycle

The mechanism this slice exists to get right.

1. Load the connection row. If `is_enabled` is false, make no network call and fail with a clear
   "connection disabled" error.
2. If `session_id` is present and `now() - session_last_used_at < 30 minutes`, reuse it. The
   five-minute margin under Bill.com's 35-minute idle expiry absorbs clock skew and in-flight latency.
3. Otherwise `POST /v3/login` with `username`, `password`, `organizationId` and `devKey`; store the
   returned `sessionId` and stamp `session_last_used_at`.
4. On a 401 or an explicit session-expired response from any call: clear the stored session,
   re-login **once**, and retry the original request. A second failure propagates.
5. After a successful call, refresh `session_last_used_at` only when the stored value is older than
   five minutes.

Sessions expire on **idle**, not on a fixed clock, so a busy connection can hold one session
indefinitely and an idle one re-logs in on next use. Login volume therefore scales with idle periods
rather than with request count, which is what keeps the 200/hour limit comfortable.

## Toggle semantics

`is_enabled` defaults to false, and an absent row means the organization has not configured Bill.com
at all. When disabled: no network calls are attempted, no credentials are required to be present, and
the UI hides Bill.com affordances.

The existing Business Central and AR code references Bill.com nowhere. That property holds today and
this slice preserves it — the AR read sync must remain fully functional with Bill.com absent.

## Components

### `nexus/src/lib/billcom/client.ts`

`createBillcomClient(config)` returning a small interface: `login()`, `request()`, `getSession()`.
Structure mirrors `nexus/src/lib/businessCentral/client.ts` — configurable timeout, bounded retry
delays, typed errors — so the two integrations read alike.

Typed errors, each mapping to an actionable message rather than a raw HTTP status:

- `BillcomAuthError` — bad credentials or a rejected login.
- `BillcomSessionExpiredError` — drives the re-login-and-retry path.
- `BillcomRateLimitError` — Bill.com's `BDC_1144`, returned when the hourly ceiling is exceeded.
- `BillcomConnectionDisabledError` — the toggle is off.

The client depends only on its config and an injectable `fetch`, so tests need no network.

### `nexus/src/app/actions/billcom.ts`

Server actions, all admin-gated and all using the service-role client for writes — the same
correction made for `item_templates` in `9aa292d`:

- `saveBillcomConnection` — create or update, routing secret values through the Vault setters and
  never returning them.
- `setBillcomConnectionEnabled` — the toggle.
- `deleteBillcomConnection` — removes the row and its Vault secrets.
- `testBillcomConnection` — performs a login and reports success or a specific failure.

### UI

A **Bill.com** card on `/admin`, beside BC Credentials and Environments: a list of configured
connections, an add/edit form, the enable toggle, and a **Test connection** button that surfaces the
result inline. Secret fields are write-only — entering a new value rotates it; the stored value is
never rendered back.

## Migrations

- `045_add_billcom_connections.sql` — table, indexes, and RLS enabled with no policy.
- `046_billcom_credential_functions.sql` — the four Vault accessor functions.

Because the RLS decision above removes the need for any `create policy` statement, **both migrations
are re-runnable**: `create table if not exists`, `create index if not exists`, `alter table … enable
row level security` and `create or replace function` are all idempotent.

This is worth stating explicitly, because it is the exception rather than the rule here. Migrations
039 and 041 both failed with `42710` on re-application on 2026-08-28, for exactly the reason these
avoid: `create policy` has no `IF NOT EXISTS` in Postgres, so it is the one statement that hard-fails
on an already-applied migration while every idempotent statement around it silently no-ops. Any
future migration that does add a policy should carry that warning in its header.

## Testing

Unit tests against an injected fake `fetch`, mirroring `businessCentral/client.test.ts`:

- A fresh connection logs in and stores the session.
- A connection with a recent session reuses it and does **not** log in again.
- A session past the idle window triggers a new login.
- A 401 mid-request clears the session, re-logs in once, and retries; a second 401 propagates.
- `session_last_used_at` is not rewritten inside the five-minute throttle window.
- A disabled connection makes no network call at all.
- `BDC_1144` maps to `BillcomRateLimitError`.

No test touches the live Bill.com API. End-to-end verification is the Test-connection button against
a real sandbox organization.

## Operational prerequisites

**A Bill.com sandbox account must exist before Test connection can pass.** Signup is self-service and
developer keys work across any test organization and test user, but it is a human step outside the
codebase — the same class of prerequisite as publishing BC page 457, which blocked item-creation
verification for three weeks. Worth starting before implementation, not after.

Production additionally requires an account signed up for Accounts Payable & Receivable, a linked
bank account, and a developer key generated under Settings → Sync & Integrations → Manage Developer
Keys. Sandbox credentials do not work against production.

## Deferred questions

Not open questions for this slice — decisions the later pieces must make, recorded so they are not lost:

- **Customer matching key between BC and Bill.com, and conflict behaviour** — the rest of piece D.
- **Polling versus webhooks for payment status** — piece E. Polling first; the data model is identical.
- **Serializing bulk operations against the 3-concurrent-request limit** — piece E, when a bulk push
  first exists to constrain.
