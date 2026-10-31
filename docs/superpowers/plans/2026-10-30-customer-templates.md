# Customer Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins manage BC customer templates (13 fields) in Nexus with two-way BC sync, backed by a read-only copy of BC number series.

**Architecture:** Customer templates and number series become two more list definitions in the project #1 engine (`nexus/src/lib/businessCentral/customerReferences/`). The engine gains fixed-choice selects, a contains-filter for select options, create defaults, and list-hidden columns. The usage counter learns that templates use payment terms and tax areas; the server actions learn the new sync and rename follow-ups.

**Tech Stack:** Next.js 16 App Router (server actions; `params`/`searchParams` are Promises), Supabase (Postgres + RLS), Vitest + Testing Library, BC OData v4 web services.

**Spec:** `docs/superpowers/specs/2026-10-30-customer-templates-design.md` (and, for inherited behaviour, `docs/superpowers/specs/2026-10-29-customer-reference-lists-design.md`)

## Global Constraints

- Branch `feature/customer-templates` in a worktree. Another session commits to `main` in parallel — **stage specific paths only, never `git add -A`**; re-check the next free migration number right before creating it (053 is the latest on 2026-10-30; written below as `054`).
- Every table/query is scoped by `organization_id` + `bc_connection_id` (`requireActiveBusinessCentralScope()`).
- Admins only (`access.isAdmin`) add / edit / delete / Sync; everyone in the org can view.
- Saves write BC first, send only changed fields, show BC's message verbatim; stale etag → re-read, re-apply changed fields, retry once (existing engine).
- Nexus never sends a BC template field outside the 13 in the spec table.
- Never touch production BC. Ask the user before every write to BC TEST; throwaway codes start with `ZZNEXUS`.
- User is a beginner: plain-language UI text and errors.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A template whose current value isn't in the dropdown's options (series without `CUST`, stale/unknown code, blank, an enum value not in the fixed list) — shown and kept unchanged on save. → Task 4 test `keeps a current value that the options filter or fixed list would hide`.
2. Deleting a payment term or tax area used only by a template (no customers) — blocked, message names the template. → Task 5 test `blocks a payment term used only by a template`.
3. Template usage lookup fails (page unpublished, network) — delete is blocked, not allowed (fail closed). → Task 5 test `fails closed when templates cannot be read`.
4. Code with a quote or slash in a template-usage filter (e.g. `O'B/1`) — filter is escaped, no BC 400. → Task 5 test `escapes quotes in the template filter`.
5. Renaming a payment term / price group / tax area whose follow-up template sync fails — save still succeeds with a warning. → Task 6 test `rename follow-up failure on customerTemplates is a warning`.

---

### Task 1: BC TEST probe for CustomerTemplates (controller-run, needs user OK)

Not dispatched to a subagent: it writes to BC TEST and needs the user's approval first.

**Files:**
- Create: `docs/superpowers/notes/2026-10-30-bc-customer-templates-discovery.md`

- [ ] **Step 1:** Ask the user for OK to create/edit/rename/delete one throwaway template `ZZNEXUS-T` in BC TEST (and to rename one payment term `ZZNEXUS-P` created for the probe).
- [ ] **Step 2:** Read-only: `$metadata` for `CustomerTemplates` and `NoSeries` — record the exact string values for `Contact_Type`, `Tax_Identification_Type`, `Application_Method` (all members, exact spelling/spaces) and field max lengths.
- [ ] **Step 3:** Writes (with OK), recording status codes and BC messages:
  - POST `ZZNEXUS-T` with only the 13 spec fields; GET it back; record which non-spec fields got which values. **If the POST is refused, stop and report to the user** (spec decision 6).
  - PATCH one field with the current etag; PATCH again with the old etag (expect 409 `Request_EntityChanged`).
  - Rename `Code` via PATCH; confirm old key 404s and new key resolves.
  - Create payment term `ZZNEXUS-P`, set it on `ZZNEXUS-T`, rename the payment term to `ZZNEXUS-Q`; check whether the template's `Payment_Terms_Code` followed.
  - `$filter=Payment_Terms_Code eq 'ZZNEXUS-Q'` and `Tax_Area_Code eq '…'` on `CustomerTemplates` work.
  - DELETE `ZZNEXUS-T` and the payment term; confirm both gone.
- [ ] **Step 4:** Write findings and any consequence for later tasks in the notes file; commit it.

```bash
git add docs/superpowers/notes/2026-10-30-bc-customer-templates-discovery.md
git commit -m "docs: BC customer templates discovery notes"
```

If the probe contradicts any value below (enum spelling, max length, rename cascade), the controller rules on it and carries the ruling into the affected task's dispatch.

---

### Task 2: Migration and database types

**Files:**
- Create: `nexus/supabase/migrations/054_add_customer_templates.sql`
- Modify: `nexus/src/types/database.ts`

**Interfaces:**
- Produces tables `business_central_customer_templates` and `business_central_no_series`, plus row/insert types following the 053 pattern (`BusinessCentralReferenceInsert<T, D>`).

- [ ] **Step 1:** Write the migration in 053's style (re-runnable, `if not exists` guards, org + connection FKs with `on delete cascade`, `bc_id`, `bc_etag`, `bc_last_modified_at`, `last_synced_at`, timestamps, `unique (organization_id, bc_connection_id, code)`, an `(organization_id, bc_connection_id)` index, RLS enabled, a select policy for org members).
  - `business_central_customer_templates` columns: `code text not null`, `display_name text not null default ''`, `contact_type text not null default ''`, `no_series text not null default ''`, `customer_posting_group text not null default ''`, `gen_bus_posting_group text not null default ''`, `customer_price_group text not null default ''`, `payment_terms_code text not null default ''`, `tax_area_code text not null default ''`, `tax_liable boolean not null default false`, `tax_identification_type text not null default ''`, `application_method text not null default ''`, `location_code text not null default ''`.
  - `business_central_no_series` columns: `code text not null`, `display_name text not null default ''`.
- [ ] **Step 2:** Add row types and insert types to `database.ts` exactly like the 053 tables (`id: string`; defaulted columns optional on insert).
- [ ] **Step 3:** `cd nexus && npx tsc --noEmit -p .` → no errors.
- [ ] **Step 4:** Commit (migration + types). The controller asks the user to apply the migration in the Supabase SQL editor and verifies both tables exist with 0 rows.

---

### Task 3: Engine extensions and the two list definitions

**Files:**
- Modify: `nexus/src/types/customerReferences.ts`, `nexus/src/lib/businessCentral/customerReferences/definitions.ts`
- Test: `nexus/src/lib/businessCentral/customerReferences/definitions.test.ts`, `nexus/src/lib/businessCentral/customerReferences/mapping.test.ts`

**Interfaces:**
- Produces:
  - `ListKey` gains `'customerTemplates' | 'noSeries'`.
  - `FieldSpec` gains `options?: { value: string; label: string }[]` (fixed choices for `select`), `optionsMatch?: string` (case-insensitive substring an `optionsFrom` option's code must contain to be offered), `defaultValue?: unknown` (pre-filled on create only), `listHidden?: boolean` (not a column in the list table; still in the form).
  - `LIST_DEFINITIONS.customerTemplates` and `LIST_DEFINITIONS.noSeries`.

- [ ] **Step 1: Write failing tests** in `definitions.test.ts`: add both keys to `COLUMNS`/`TABLES`; length 11; and

```ts
it('customer templates manage exactly the 13 spec fields', () => {
  const t = LIST_DEFINITIONS.customerTemplates;
  expect(t.mode).toBe('managed');
  expect(t.source).toEqual({ kind: 'odata', service: 'CustomerTemplates', pageNumber: 1382, keyFields: ['Code'] });
  expect(t.fields.map((f) => f.bcName)).toEqual(['Code', 'Description', 'Contact_Type', 'No_Series',
    'Customer_Posting_Group', 'Gen_Bus_Posting_Group', 'Customer_Price_Group', 'Payment_Terms_Code',
    'Tax_Area_Code', 'Tax_Liable', 'Tax_Identification_Type', 'Application_Method', 'Location_Code']);
  const by = Object.fromEntries(t.fields.map((f) => [f.name, f]));
  expect(by.customer_price_group.required).toBeFalsy();
  for (const n of ['code', 'contact_type', 'no_series', 'customer_posting_group', 'gen_bus_posting_group',
    'payment_terms_code', 'tax_area_code', 'tax_identification_type', 'application_method', 'location_code'])
    expect(by[n].required).toBe(true);
  expect(by.no_series).toMatchObject({ optionsFrom: 'noSeries', optionsMatch: 'CUST' });
  expect(by.application_method.defaultValue).toBe('Manual');
  expect(by.contact_type.options?.map((o) => o.value)).toEqual(['Company', 'Person']);
  expect(by.tax_identification_type.options?.map((o) => o.value)).toEqual(['Legal Entity', 'Natural Person']);
  expect(by.application_method.options?.map((o) => o.value)).toEqual(['Manual', 'Apply to Oldest']);
});

it('number series is a read-only copy from the NoSeries page', () => {
  expect(LIST_DEFINITIONS.noSeries).toMatchObject({ mode: 'readOnly', table: 'business_central_no_series',
    source: { kind: 'odata', service: 'NoSeries', pageNumber: 456, keyFields: ['Code'] } });
});
```

In `mapping.test.ts`: `toBcFields(customerTemplates, { display_name: 'x' })` returns exactly `{ Description: 'x' }` (only given fields, never other template fields).

- [ ] **Step 2:** `cd nexus && npx vitest run src/lib/businessCentral/customerReferences` → the new tests FAIL.
- [ ] **Step 3: Implement.** Extend the types; add both definitions. Field specs (name / bcName / label / maxLength): `code`/`Code`/Code/20 (key, renamable), `display_name`/`Description`/Description/100, `contact_type`/`Contact_Type`/Contact type, `no_series`/`No_Series`/No. series/20 (`optionsFrom: 'noSeries'`, `optionsMatch: 'CUST'`), `customer_posting_group`/`Customer_Posting_Group`/Customer posting group (`optionsFrom: 'customerPostingGroups'`), `gen_bus_posting_group`/`Gen_Bus_Posting_Group`/Gen. bus. posting group (`optionsFrom: 'generalBusinessPostingGroups'`), `customer_price_group`/`Customer_Price_Group`/Customer price group (`optionsFrom: 'customerPriceGroups'`, not required), `payment_terms_code`/`Payment_Terms_Code`/Payment terms (starting value) (`optionsFrom: 'paymentTerms'`), `tax_area_code`/`Tax_Area_Code`/Tax area (starting value) (`optionsFrom: 'taxAreas'`), `tax_liable`/`Tax_Liable`/Tax liable (boolean), `tax_identification_type`/`Tax_Identification_Type`/Tax identification type, `application_method`/`Application_Method`/Application method (`defaultValue: 'Manual'`), `location_code`/`Location_Code`/Location (`optionsFrom: 'locations'`). Mark `listHidden: true` on: customer_posting_group, gen_bus_posting_group, tax_liable, tax_identification_type, application_method, location_code. `noSeries`: `readOnly`, fields `code`/`Code` (key, 20) and `display_name`/`Description` (100), `renameField: 'code'`.
- [ ] **Step 4:** Same vitest command → PASS; `npx tsc --noEmit -p .` clean (fix any exhaustive `Record<ListKey, …>` the new keys break, e.g. test fixtures).
- [ ] **Step 5:** Commit the four files.

---

### Task 4: Form and list UI for the new field options

**Files:**
- Modify: `nexus/src/components/customerReferences/ReferenceEntryForm.tsx`, `nexus/src/components/customerReferences/ReferenceListClient.tsx`
- Test: create `nexus/src/components/customerReferences/ReferenceEntryForm.test.tsx`; extend `ReferenceListClient.test.tsx`

**Interfaces:**
- Consumes: `FieldSpec.options`, `.optionsMatch`, `.defaultValue`, `.listHidden` (Task 3).

- [ ] **Step 1: Write failing tests** (render with inline `FieldSpec[]`, mock `saveReferenceEntry` as the existing tests do):
  - `offers fixed options for a select with options`: options `Company`, `Person` appear.
  - `filters optionsFrom options by optionsMatch, ignoring case`: options `CUST`, `fund-cust`, `ITEM` with `optionsMatch: 'CUST'` → `CUST` and `fund-cust` offered, `ITEM` not.
  - `keeps a current value that the options filter or fixed list would hide`: editing an entry whose `no_series` is `ITEM` and whose `contact_type` is `Other` shows both as selected options; saving an unrelated field sends neither in `edited` changes (unchanged).
  - `pre-fills defaultValue on create only`: create form shows `Manual`; edit form for an entry with `Apply to Oldest` shows `Apply to Oldest`.
  - In `ReferenceListClient.test.tsx`: `does not render listHidden fields as columns` (header lacks the label; the edit form still shows it).
- [ ] **Step 2:** `npx vitest run src/components/customerReferences` → new tests FAIL.
- [ ] **Step 3: Implement.** Option source for a select is `f.options` (value/label) when present, else `selectOptions[f.optionsFrom]` filtered by `optionsMatch` (case-insensitive `includes` on `code`). The existing "current value not in options" branch must use that same filtered list. Initial raw value on create: `fixedValues?.[name] ?? f.defaultValue`. List columns exclude `listHidden` fields (in addition to `hiddenFields`).
- [ ] **Step 4:** Same command → PASS; `npx eslint src/components/customerReferences` clean.
- [ ] **Step 5:** Commit.

---

### Task 5: Templates count as usage for payment terms and tax areas

**Files:**
- Modify: `nexus/src/lib/businessCentral/customerReferences/usage.ts`
- Test: `nexus/src/lib/businessCentral/customerReferences/usage.test.ts`

**Interfaces:**
- Consumes: `LIST_DEFINITIONS.customerTemplates.source`, `transport.list(source, { filter })`.
- Produces: same `createUsageCounter(bc, transport)` signature; `paymentTerms` and `taxAreas` messages now include templates.

(Posting groups and locations are read-only in Nexus and price-group delete is disabled, so only these two lists can be deleted while a template uses them.)

- [ ] **Step 1: Write failing tests:**
  - `blocks a payment term used only by a template`: no customers, `CustomerTemplates` filter `Payment_Terms_Code eq 'NET30'` returns `WHOLESALE` → message `Used by template WHOLESALE`.
  - `combines customers and templates`: 2 customers + templates `A`, `B` → `Used by 2 customers and templates A, B`.
  - tax area: filter on `Tax_Area_Code`.
  - `escapes quotes in the template filter`: code `O'B/1` → filter `Payment_Terms_Code eq 'O''B/1'`.
  - `fails closed when templates cannot be read`: transport.list rejects → countUsage rejects (delete never proceeds).
  - Unchanged: no customers + no templates → `null`.
- [ ] **Step 2:** `npx vitest run src/lib/businessCentral/customerReferences/usage.test.ts` → FAIL.
- [ ] **Step 3: Implement** a `templatesUsing(bcField, code)` helper (filter via the existing `odataString`), run it alongside the customer count with `Promise.all`, and compose: customers only → existing text; templates only → `Used by template X` / `Used by templates X, Y`; both → `Used by N customer(s) and template(s) …`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit.

---

### Task 6: Server actions and pages

**Files:**
- Modify: `nexus/src/app/actions/customerReferenceLists.ts`, `nexus/src/app/(protected)/customer-lists/page.tsx`, `nexus/src/app/(protected)/customer-lists/[list]/page.tsx`
- Test: `nexus/src/app/actions/customerReferenceLists.test.ts`

**Interfaces:**
- Consumes: Task 3 keys; existing `syncList`, `followUpLists`, `listsToSync`.

- [ ] **Step 1: Write failing tests:**
  - `syncing customer templates syncs number series first`: `syncReferenceList('customerTemplates')` calls `syncList` for `noSeries` then `customerTemplates`; counts summed.
  - `renaming a payment term / price group / tax area re-pulls customer templates`: for each of those keys a rename save triggers `syncList` on `customerTemplates` (tax areas still also re-pull `taxAreaLines`).
  - `rename follow-up failure on customerTemplates is a warning`: follow-up sync rejects → `{ ok: true, warning }` naming Customer templates.
  - Create on `customerTemplates` triggers no follow-up.
- [ ] **Step 2:** `npx vitest run src/app/actions` → FAIL.
- [ ] **Step 3: Implement.** `listsToSync('customerTemplates')` → `['noSeries', 'customerTemplates']`. In `followUpLists`, a rename on `paymentTerms`, `customerPriceGroups` or `taxAreas` appends `'customerTemplates'`. Overview page: add `customerTemplates` to `MANAGED` (first entry, it is the headline list). `[list]/page.tsx`: `noSeries` is `notFound()` like `taxAreaLines` (it is only a pick list).
- [ ] **Step 4:** `npx vitest run` (whole suite) → PASS; `npx tsc --noEmit -p .` and `npx eslint src` clean.
- [ ] **Step 5:** Commit.

---

### Task 7: Live verification in BC TEST (controller + user)

- [ ] **Step 1:** Start the worktree dev server on a free port; user logs in and presses **Sync with BC** on Customer templates. Verify DB: 4 templates with the values in the spec's table (501C-FUND, CUST-PERSON, FUNDRAISER-STD, WHOLESALE), and number series = BC's count (153 on 2026-10-30).
- [ ] **Step 2:** Open WHOLESALE: No. series offers only CUST-containing series and shows WHSL-CUST; CUST-PERSON shows an empty price group. Save without changes → no BC call.
- [ ] **Step 3 (writes, ask first):** Add `ZZNEXUS-T` (check Application method pre-filled Manual), edit it, rename it, Sync → 0 changes; verify in BC that a non-spec field (e.g. `Reserve`) kept BC's default.
- [ ] **Step 4 (writes, ask first):** Create payment term `ZZNEXUS-P`, set it on `ZZNEXUS-T`, try to delete the payment term → blocked naming `ZZNEXUS-T`. Rename the payment term → template shows the new code without a manual Sync.
- [ ] **Step 5:** Clean up: delete `ZZNEXUS-T` then the payment term from Nexus; verify both gone from BC TEST and Nexus.
- [ ] **Step 6:** Stop the dev server.
