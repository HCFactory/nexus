# Customers → Bill.com Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every BC customer has exactly one linked Bill.com customer kept in step with BC (one-way), via a previewed initial push and queued, throttled pushes after each Nexus save or BC Sync.

**Architecture:** A link table records each BC customer's Bill.com id, push state and last-pushed values. A pure mapper turns a `business_central_customers` row into a Bill.com customer payload; a push engine (injectable Bill.com client) matches by Account number once, then creates/updates/deactivates by id, with ≤3 concurrent requests and a time budget. Server actions expose preview/confirm, a pending-queue runner, and per-customer push after saves.

**Tech Stack:** Next.js 16 App Router (server actions), Supabase, Vitest + Testing Library, Bill.com v3 API via `nexus/src/lib/billcom/` (`createBillcomClientForConnection`, `client.request()`, `BillcomApiError`/`BillcomRateLimitError`).

**Spec:** `docs/superpowers/specs/2026-10-30-customers-billcom-design.md`

## Global Constraints

- Branch `feature/customers-billcom` in a worktree; another session commits to `main` — **stage specific paths only, never `git add -A`**; recheck the migration number (055 latest on 2026-10-30; written below as `056`).
- One-way: Nexus/BC → Bill.com. Matching key: Bill.com **Account number** = BC customer number; after linking, the Bill.com id is authoritative.
- Pushed fields only: name, invoice email, invoice email CC (only if Bill.com has a field), phone, billing address (line 1, line 2, city, state, ZIP, country), account number, active flag. Shipping address untouched. **Blank BC values overwrite** Bill.com.
- **Blocked = Invoice or All → inactive**; blank or Ship → active. Blocked customers are created too (inactive). Deleted in Nexus → inactive.
- Initial push: **preview first, nothing written until Confirm**; re-runnable without duplicates.
- Push failure never fails a BC save; it marks the customer `failed` with Bill.com's message.
- ≤3 concurrent Bill.com requests; runs stop cleanly at a time budget and resume from the pending list.
- Bill.com **sandbox only**; ask the user before every sandbox write. Every query scoped by org + BC connection + Bill.com connection.
- Saves run under `canEditCustomers`; initial push, bulk run and retry-all are admin-only.
- Plain-language UI/errors. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Two Bill.com customers share an Account number → `needs_attention` naming both ids; never picks one. → Task 4 test `duplicate account numbers need attention`.
2. Bill.com rejects a create for a duplicate name → `needs_attention` with Bill.com's message, run continues. → Task 4 test `name clash needs attention and the run continues`.
3. Rate limit (`BillcomRateLimitError`) mid-run → stop, keep the rest `pending`, report "Bill.com is busy — run again in a minute". → Task 4 test `rate limit stops the run and leaves the rest pending`.
4. Inactive Bill.com customer holds the number → linked, reactivated if BC says active, not duplicated. → Task 4 test `inactive match is reused and reactivated`.
5. Customer saved in Nexus while Bill.com connection disabled → BC save succeeds, link stays `pending`, UI says Bill.com is off. → Task 5 test `disabled Bill.com keeps the save and leaves it pending`.

---

### Task 1: Bill.com sandbox probe (controller-run, needs user OK)

**Files:** Create `docs/superpowers/notes/2026-10-30-billcom-customers-discovery.md`

- [ ] Read-only: list customers (page size, paging), search/filter by account number (incl. inactive), the customer object's field names (name, email, CC/secondary email?, phone, billing vs shipping address shape, accountNumber, isActive), error array shape.
- [ ] With the user's OK: create `ZZNEXUS` customer, update one field, set blank to clear a field, deactivate/reactivate, duplicate-name create (record error code), then make it inactive (delete if Bill.com allows). Record request counts/limits observed.
- [ ] Write findings + decided endpoint/field names; commit. Controller carries them into Tasks 3–4 as rulings.

### Task 2: Migration 056 — link table

**Files:** Create `nexus/supabase/migrations/056_add_billcom_customer_links.sql`; Modify `nexus/src/types/database.ts`

- [ ] Table `billcom_customer_links`: `id`, `organization_id`, `bc_connection_id`, `billcom_connection_id` (FKs, cascade), `business_central_customer_id uuid` → `business_central_customers(id) on delete set null`, `bc_customer_number text not null`, `billcom_customer_id text`, `status text not null default 'pending' check (status in ('pending','synced','failed','needs_attention'))`, `last_pushed_hash text`, `last_pushed_at timestamptz`, `last_error text`, timestamps; unique `(organization_id, bc_connection_id, billcom_connection_id, bc_customer_number)`; index on status; RLS select for org members (053 style), re-runnable.
- [ ] Types; tsc clean; commit. Controller asks the user to apply and verifies.

### Task 3: Payload mapper

**Files:** Create `nexus/src/lib/billcom/customerPayload.ts` (+ test)

**Produces:** `toBillcomCustomer(row: BusinessCentralCustomer): BillcomCustomerPayload` and `payloadHash(p: BillcomCustomerPayload): string` (stable, key-sorted).

- [ ] Failing tests: field mapping per Task 1 names; blank BC → `''` sent (not omitted); `blocked` `Invoice`/`All` → inactive, `null`/`Ship` → active; address → billing only; CC included only if Task 1 found a field; hash ignores key order and changes when any pushed field changes.
- [ ] Implement; green; commit.

### Task 4: Push engine

**Files:** Create `nexus/src/lib/billcom/customerPush.ts` (+ test)

**Produces:**
- `planInitialPush(deps): Promise<PushPreview>` — `{ link: n, create: n, update: n, deactivate: n, needsAttention: Array<{ number, reason }>, sample: Array<{ number, changes: Record<string,[before,after]> }> }`; reads Bill.com customers (all pages, incl. inactive), writes nothing.
- `pushCustomers(deps, { numbers?: string[]; budgetMs: number }): Promise<PushResult>` — processes given numbers or all `pending`/`failed` links; ≤3 concurrent; per customer: find link → (no id) match by account number (0 → create, 1 → link, >1 → needs_attention) → update if hash differs → set status/hash/error; stops at budget or rate limit, leaving the rest pending. `PushResult = { created, updated, linked, unchanged, failed, needsAttention, remaining, stoppedReason?: 'budget'|'rate_limit' }`.
- `markPending(deps, numbers: string[]): Promise<void>` — upserts links to `pending`.
- [ ] Failing tests: the five Review Focus cases 1–4 above, plus `creates with account number = BC number`, `unchanged hash makes no call`, `budget stop leaves remaining pending`, `deleted customer is made inactive`, `preview writes nothing`.
- [ ] Implement (fake Bill.com client in tests); green; commit.

### Task 5: Wiring into saves and sync

**Files:** Modify `nexus/src/app/actions/customerEditing.ts`, `nexus/src/app/actions/businessCentralReceivables.ts` (+ tests); Create `nexus/src/app/actions/billcomCustomers.ts` (+ test)

- [ ] Failing tests: after create/update/delete success, the customer is `markPending`'d and `pushCustomers({ numbers:[no], budgetMs: 10000 })` runs; its failure/disabled connection never changes the save result (`disabled Bill.com keeps the save and leaves it pending`); customer sync marks every customer whose `payloadHash` differs from `last_pushed_hash` as pending (no Bill.com calls inside sync); `billcomCustomers.ts` exports admin-only `previewInitialPush()`, `confirmInitialPush()` (marks all pending then runs one budgeted batch), `runPendingPush()` (budget ~25 s), each refusing non-admins with `Only admins can push customers to Bill.com`.
- [ ] Implement; green; commit.

### Task 6: UI

**Files:** Modify `nexus/src/components/customers/CustomersClient.tsx`, `CustomerDetail.tsx`; Create `nexus/src/components/customers/BillcomPushPanel.tsx` (+ tests)

- [ ] Failing tests: admins see **Push to Bill.com** → preview (counts + sample changes + needs-attention list) → **Confirm**; afterwards a progress summary and, while `remaining > 0`, **Continue** (and automatic continuation while the page is open); after a customer Sync, a pending run starts automatically; customer list shows a Bill.com status badge (Synced / Pending / Failed / Needs attention); detail shows status, last error and **Retry** (permitted users).
- [ ] Implement; full suite + tsc + eslint green; commit.

### Task 7: Live verification (Bill.com sandbox + BC TEST; ask before writes)

- [ ] Preview → check counts look right against the sandbox; Confirm → spot-check 3 linked/updated and 3 created customers in the sandbox (account number, fields, inactive for blocked).
- [ ] Create a `ZZNEXUS` customer in Nexus → appears in Bill.com; edit email → updated; block Invoice → inactive; delete → inactive.
- [ ] Change a customer directly in BC, Sync → pushed.
- [ ] Clean up test records; stop the dev server.
