# Customers ↔ BC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitted users create (from a template), edit and delete BC customers from Nexus's Customers page; BC changes come in on the existing sync.

**Architecture:** Customer writes go through the project #1 reference transport (`customerReferences/transport.ts`) against the BC source(s) Task 1 settles, with the same changed-fields-only / stale-etag-retry rules (`merge.changedFields`, `BcConflictError`). New columns on `business_central_customers` hold the extra fields; the existing AR customer sync fills them. A new `canEditCustomers` permission gates create/edit/delete. Price-group delete is re-enabled behind a live customer + template usage check.

**Tech Stack:** Next.js 16 App Router (server actions; `params`/`searchParams` are Promises), Supabase (Postgres + RLS), Vitest + Testing Library, BC API v2.0 + OData v4 (`Customer_Card_Excel`).

**Spec:** `docs/superpowers/specs/2026-10-30-customers-bc-design.md`

## Global Constraints

- Branch `feature/customers-bc` in a worktree. Another session commits to `main` — **stage specific paths only, never `git add -A`**; recheck the next free migration number right before creating it (054 latest on 2026-10-30; written below as `055`).
- Every query scoped by `organization_id` + `bc_connection_id` via `requireActiveBusinessCentralScope()`.
- `canEditCustomers` gates create, edit and delete; viewing needs `canViewCustomers`; the existing customer/AR sync and its permission are unchanged.
- Saves write BC first, send only changed fields, show BC's message verbatim; stale etag → re-read, re-apply changed fields, retry once.
- Create validates every field; edit validates only changed fields.
- Never touch production BC. Ask the user before every write to BC TEST; throwaway records start with `ZZNEXUS`.
- Plain-language UI text and errors (user is a beginner).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Editing an existing customer that lacks email/phone/payment terms — saving an unrelated field succeeds. → Task 5 test `edit validates only changed fields`.
2. Create succeeds in BC but a follow-up write fails — customer kept and stored, message says to open Edit; no delete. → Task 5 test `partial create keeps the customer and warns`.
3. Delete refused by BC (customer has entries) — BC's message shown plus the "set Blocked to All" hint; Nexus row kept. → Task 5 test `delete refused keeps the row and adds the Blocked hint`.
4. A user with `canViewCustomers` but not `canEditCustomers` — sees no New/Edit/Delete, and the server actions refuse. → Task 6 test `actions refuse without canEditCustomers`.
5. Deleting a price group used only by a customer (no template) — blocked naming the count. → Task 7 test `blocks a price group used by customers`.

---

### Task 1: BC TEST probe for customer writes (controller-run, needs user OK)

**Files:** Create `docs/superpowers/notes/2026-10-30-bc-customers-discovery.md`

- [ ] **Step 1:** Read-only: `$metadata` for `Customer_Card_Excel` — key field(s), whether a contact-type field exists under any name, `Blocked` option values, the `EMailCCHCABG` field, which of the spec's fields are writable (no `ReadOnly` annotations). Compare with API v2 `customers` (fields, `number`, etag).
- [ ] **Step 2:** Ask the user's OK, then with throwaway `ZZNEXUS` customers:
  - POST to `Customer_Card_Excel` with no `No` → which series numbered it.
  - POST with `No_Series` (if writable) or with an explicit next number from the template series (via existing `noSeriesClient`) → does BC accept it and advance the series?
  - Single POST carrying all spec fields → accepted? Fields that need a second PATCH?
  - PATCH one field with the current etag; with a stale etag (expect 409 `Request_EntityChanged`); does a write via one source stale the other's etag?
  - DELETE the throwaway customers; record the error code/message shape BC uses for "has ledger entries" from docs if not safely testable (never delete a real customer).
- [ ] **Step 3:** Record findings and the decided write source(s), numbering method and field list; **if no numbering method uses the template's series, stop and ask the user** (spec decision 2). Commit the notes.

The controller turns the findings into rulings carried into Tasks 2–7 (source, key, exact BC field names).

---

### Task 2: Migration 055 and types

**Files:** Create `nexus/supabase/migrations/055_add_customer_editing_fields.sql`; Modify `nexus/src/types/database.ts`

- [ ] **Step 1:** `alter table public.business_central_customers add column if not exists …` (re-runnable) for: `email_cc text not null default ''`, `address_line_1/address_line_2` only if not already present (check 041), `payment_terms_code text not null default ''`, `tax_area_code text not null default ''`, `tax_identification_type text not null default ''`, `customer_price_group text not null default ''`, `customer_posting_group text not null default ''`, `gen_bus_posting_group text not null default ''`, `application_method text not null default ''`, `location_code text not null default ''`, `contact_type text not null default ''` (omit if Task 1 drops it), `credit_limit numeric not null default 0`, `bc_card_etag text` (etag of the OData card record, if Task 1 makes it a separate source). Header comment: BC uses '' for "no value".
- [ ] **Step 2:** Extend the `BusinessCentralCustomer` row type; `npx tsc --noEmit -p .` clean.
- [ ] **Step 3:** Commit. Controller asks the user to apply it and verifies the columns exist.

---

### Task 3: `canEditCustomers` permission

**Files:** Modify `nexus/src/lib/auth/permissions.ts` (+ its test), the admin page's per-user permission list (find where existing `ACCESS_KEYS` get labels)

- [ ] **Step 1: Failing tests:** `canEditCustomers` is true for admins, false by default for others, true when the per-user override is set; it appears in `ACCESS_KEYS`.
- [ ] **Step 2:** Implement: add to `ResolvedUserAccess`, `ACCESS_KEYS`, default `isAdmin`; label **"Create and edit customers"** next to "View customers" on the admin page.
- [ ] **Step 3:** Tests + tsc green; commit.

---

### Task 4: Customer field definition and sync fill

**Files:** Create `nexus/src/lib/businessCentral/customers/customerFields.ts` (+ test); Modify the customer sync adapter (`nexus/src/lib/businessCentral/arSyncAdapters.ts` / `customerMapper.ts`) per Task 1's source ruling

**Interfaces — Produces:**
- `CUSTOMER_FIELDS: FieldSpec[]` (reusing `FieldSpec` from `@/types/customerReferences`) — names = Task 2 columns, BC names per Task 1, labels and rules from the spec table: required on create = name, email, phone, payment terms, tax area; selects with `optionsFrom` = paymentTerms, taxAreas, customerPriceGroups, customerPostingGroups, generalBusinessPostingGroups, locations; fixed `options` for contact type, tax identification type, application method (values from project #2 notes) and blocked (` `, `Ship`, `Invoice`, `All` — exact values from Task 1); `creationOnly` concept for No. series is **not** a field here (chosen via the template).
- `TEMPLATE_TO_CUSTOMER: Record<templateColumn, customerColumn>` mapping the 12 template fields (all but code/description/no_series) onto customer columns.
- [ ] **Step 1: Failing tests:** field list/required flags as above; `TEMPLATE_TO_CUSTOMER` covers exactly the 12 fields; the sync mapper fills every new column from a sample BC record (fixture from Task 1 notes) and leaves existing columns' behaviour unchanged (existing mapper tests still pass).
- [ ] **Step 2:** Implement; `npx vitest run src/lib/businessCentral` green; commit.

---

### Task 5: Customer service (create / edit / delete)

**Files:** Create `nexus/src/lib/businessCentral/customers/customerService.ts` (+ test)

**Interfaces:**
- Consumes: `ReferenceTransport`, `changedFields` (`customerReferences/merge.ts`), `validateEntry`, `CUSTOMER_FIELDS`, `TEMPLATE_TO_CUSTOMER`.
- Produces:
  - `createCustomer(deps, { templateCode: string; values: Record<string, unknown> }): Promise<{ id: string; number: string; warning?: string }>`
  - `updateCustomer(deps, { id: string; original: Record<string, unknown>; edited: Record<string, unknown> }): Promise<void>`
  - `deleteCustomer(deps, id: string): Promise<void>`
- [ ] **Step 1: Failing tests** (fake transport + fake supabase, as in `customerReferences/service.test.ts`):
  - `create applies every template field and the typed values` (BC receives template values; typed payment terms/tax area override the template's).
  - `create numbers from the template's series` (per Task 1 method).
  - `create validates every field` (missing name → no BC call, message `Name is required`).
  - `partial create keeps the customer and warns` (second write rejects → row stored, warning `Created, but some settings weren't applied — open Edit to fix.`, no delete call). Skip if Task 1 shows one call suffices; then assert a single create call instead.
  - `edit sends only changed fields`, `edit validates only changed fields`, `stale etag retries once`.
  - `delete refused keeps the row and adds the Blocked hint`: BC 400 → error = BC message + ` You can set Blocked to All instead.`; Nexus row still there.
  - `delete removes the Nexus row on success`.
- [ ] **Step 2:** Implement (after a create, read the record back for its etag, as project #1 does); green; commit.

---

### Task 6: Server actions and UI

**Files:** Create `nexus/src/app/actions/customerEditing.ts` (+ test), `nexus/src/components/customers/CustomerForm.tsx` (+ test); Modify `CustomersClient.tsx`, `CustomerDetail.tsx`, the customers pages as needed

- [ ] **Step 1: Failing tests:**
  - `actions refuse without canEditCustomers` (create/update/delete return `{ ok: false, error: 'You don't have permission to change customers' }`).
  - Actions call the Task 5 service with the active scope; revalidate `/customers`.
  - `CustomerForm` create mode: choosing a template pre-fills payment terms + tax area (editable) and hides template-only fields; edit mode shows every field; current values missing from options are kept (reuse the project #2 option rules).
  - `CustomersClient` shows **New customer** and per-customer **Edit** only with `canEditCustomers`; Delete asks "Delete this customer? This can't be undone." before calling the action.
- [ ] **Step 2:** Implement (reuse `ReferenceEntryForm` rendering patterns and `getSelectOptions` for dropdowns; templates list from `business_central_customer_templates`); full suite + tsc + eslint green; commit.

---

### Task 7: Re-enable price-group delete

**Files:** Modify `customerReferences/definitions.ts` (drop `deleteDisabledReason` on price groups), `customerReferences/usage.ts` (+ tests)

- [ ] **Step 1: Failing tests:** `blocks a price group used by customers` (BC customers filtered on the price-group field per Task 1 → `Used by 3 customers`); combined with templates as in project #2's message format; fails closed when BC can't be read; unused group → `null`.
- [ ] **Step 2:** Implement; green; commit.

---

### Task 8: Live verification in BC TEST (controller + user)

- [ ] Start the worktree dev server on a free port. With the user (ask before each write):
  1. Sync customers → new columns filled for existing customers (spot-check 3 against BC).
  2. As a non-admin with only "View customers": no New/Edit/Delete. Tick "Create and edit customers" → buttons appear.
  3. New customer `ZZNEXUS` from WHOLESALE → number from WHSL-CUST; every template field in BC; typed fields correct.
  4. Edit email CC, credit limit, blocked → in BC; Sync → 0 changes.
  5. Price group: delete a group used by the test customer → blocked.
  6. Delete the test customer → gone from BC and Nexus. Try deleting a customer with invoices only if the user picks one and agrees — expect BC's refusal + hint.
- [ ] Stop the dev server; record results.
