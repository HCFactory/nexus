# Customer Reference Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nexus manages payment terms, customer price groups and the full US tax chain (tax areas, tax area lines, tax jurisdictions, tax details) with two-way BC sync, and holds read-only copies of locations, customer posting groups and gen. bus. posting groups.

**Architecture:** One generic engine drives every list. A per-list *definition* says where the list lives in BC (standard API resource or published OData page), which fields it has, which are editable, and its key. A *transport* talks to BC for both kinds of source. Pure *merge* functions compute field-only patches and the Sync plan. A *service* layer combines them for save / delete / sync, and thin server actions expose it to a generic list page plus a tax-area detail page.

**Tech Stack:** Next.js (App Router, server actions), Supabase (Postgres + RLS), Vitest + Testing Library, BC API v2.0 + BC OData v4 web services.

**Spec:** `docs/superpowers/specs/2026-10-29-customer-reference-lists-design.md`

## Global Constraints

- Branch: `feature/customer-reference-lists`. Another session commits Friends & Family work to `main` in parallel — **stage specific paths only, never `git add -A`**, and re-check the highest migration number right before creating the migration (it was 052 on 2026-10-30; use the next free number, written below as `053`).
- Every list is scoped per BC environment: every table has `organization_id` + `bc_connection_id`; every query filters on both (`requireActiveBusinessCentralScope()` from `nexus/src/lib/businessCentral/environmentScope.ts`).
- **Admins only** (`access.isAdmin`) may create, edit, delete or Sync. Everyone in the org may view.
- A Nexus save writes to BC **first**; the Nexus row changes only after BC accepts. BC's error message is shown verbatim on failure.
- Saves send BC **only the fields the admin changed**. On HTTP 412, re-read from BC, re-apply only the changed fields, retry **once**.
- Codes are renamable from Nexus (BC cascades the rename). Composite-key child rows (tax area lines, tax details) are not renamed — change their key fields by deleting and re-adding (plan decision).
- Sync pull: BC wins on any difference; rows missing from BC are removed from Nexus.
- Delete: blocked when in use (message `Used by N customers` / `Used by N tax area lines and M tax details`); otherwise delete in BC first, then Nexus. **Price-group delete is disabled** with the note `Deleting price groups is available once customers sync from Nexus (customer sync project 3). Delete it in Business Central for now.`
- Missing published page → clear error naming the page number and the web-service name to publish (same style as `NoSeriesPageUnavailableError` in `nexus/src/lib/businessCentral/noSeriesClient.ts`).
- Migration must be re-runnable: `create table if not exists`, `drop policy if exists` before each `create policy`.
- Writes go through the service-role client in server actions; tables get a member-scoped SELECT policy only (pattern of `041_add_customer_ar_sync.sql`).
- Out of scope: Bill.com, customer templates, customers, scheduled sync, editing posting groups / locations.

## Review Focus

1. **A tax rate typed as `7` meaning 7% vs `0.07`.** BC stores percentages (7 = 7%). Admin expects what they type to be what BC shows → test in Task 5 that `7` round-trips as `7` and that values outside 0–100 are rejected before any BC call.
2. **Rename to a code that already exists in BC.** Admin expects BC's "already exists" message and nothing changed in Nexus → test in Task 6.
3. **Sync while BC returns more than one page of results** (`@odata.nextLink`). Expect every row, not the first page → test in Task 3.
4. **Codes with a quote or slash, e.g. `O'HARE` or `N/30`,** in OData key URLs. Expect correct escaping (`''` inside the key literal, then URL-encoding) → test in Task 3.
5. **Usage check against a stale customer mirror.** A customer assigned the term in BC since the last customer sync must still block the delete → Task 7 queries BC customers live for payment terms and tax areas; test that the live count is used, not the mirror.

---

## File Structure

```
nexus/supabase/migrations/053_add_customer_reference_lists.sql   tables + RLS
nexus/src/lib/businessCentral/customerReferences/
  definitions.ts        one ListDefinition per list (source, fields, key, mode)
  definitions.test.ts
  transport.ts          list/get/create/patch/delete for API + OData sources
  transport.test.ts
  merge.ts              changedFields, buildPatch, planSyncPull (pure)
  merge.test.ts
  validation.ts         per-list input validation (pure)
  validation.test.ts
  service.ts            saveEntry / deleteEntry / syncList (DB + transport)
  service.test.ts
  usage.ts              countUsage per list
  usage.test.ts
  errors.ts             ReferencePageUnavailableError, BcConflictError, ReferenceInUseError
nexus/src/types/customerReferences.ts                         shared UI/server types
nexus/src/app/actions/customerReferenceLists.ts                server actions
nexus/src/app/actions/customerReferenceLists.test.ts
nexus/src/app/(protected)/customer-lists/page.tsx              hub
nexus/src/app/(protected)/customer-lists/[list]/page.tsx       generic list page
nexus/src/app/(protected)/customer-lists/tax-areas/[code]/page.tsx   tax area + its lines
nexus/src/components/customerReferences/ReferenceListClient.tsx
nexus/src/components/customerReferences/ReferenceListClient.test.tsx
nexus/src/components/customerReferences/ChangePreview.tsx      "what will change in BC" confirm
nexus/src/components/customerReferences/TaxAreaDetailClient.tsx
nexus/src/components/layout/AppNav.tsx                         nav link
docs/superpowers/notes/2026-10-30-bc-reference-pages-discovery.md   Task 1 findings
```

List keys used everywhere (the `ListKey` union): `paymentTerms`, `customerPriceGroups`, `taxAreas`, `taxAreaLines`, `taxJurisdictions`, `taxDetails`, `locations`, `customerPostingGroups`, `generalBusinessPostingGroups`.

---

### Task 1: Confirm BC pages and behaviour (discovery, with the user)

No product code. Everything later depends on names this task records.

**Files:**
- Create: `docs/superpowers/notes/2026-10-30-bc-reference-pages-discovery.md`

- [ ] **Step 1: Ask the user to publish these pages as web services in BC TEST** (Web Services page → New → Object Type `Page`). Suggested service names in brackets:
  - 7 Customer Price Groups (`CustomerPriceGroups`)
  - 110 Customer Posting Groups (`CustomerPostingGroups`)
  - 312 Gen. Business Posting Groups (`GenBusinessPostingGroups`)
  - 464 Tax Area (needed only if lines aren't reachable otherwise — skip unless Step 3 shows it's needed)
  - 465 Tax Area Line (`TaxAreaLines`) — confirm number in BC
  - 466 Tax Jurisdictions (`TaxJurisdictions`) — confirm number in BC
  - 468 Tax Details (`TaxDetails`) — confirm number in BC

  If a page number is wrong, the user searches the page name in BC's Web Services "Object ID" lookup and the note records the real one.

- [ ] **Step 2: Read-only probe of each service.** Throwaway script (scratchpad, not committed), same approach as the session probe: copy `client.ts` without its `server-only` line, build the client with `createBcClientForOrg(orgId, connectionId)`, GET `${apiBaseUrl}/v2.0/${environment}/ODataV4/Company('${companyName}')/${serviceName}?$top=3`. Record for each: HTTP status, every field name returned, and whether `SystemModifiedAt` / `SystemId` appear.

- [ ] **Step 3: Write-behaviour probe in BC TEST, after the user says yes.** On a throwaway payment term `ZZNEXUS` and a throwaway price group `ZZNEXUS`:
  - create → rename to `ZZNEXUS2` (API: `PATCH paymentTerms({id})` body `{"code":"ZZNEXUS2"}`; OData: `PATCH CustomerPriceGroups('ZZNEXUS')` body `{"Code":"ZZNEXUS2"}`) → record whether it succeeds and what the response key is;
  - PATCH with a stale etag → record status (expect 412) and body;
  - create `ZZNEXUS` twice → record the duplicate error status/code/message;
  - assign `ZZNEXUS2` payment term to no customer, then delete → record success;
  - delete both throwaways at the end, confirm they're gone.

- [ ] **Step 4: Write the findings note** with one table per service: page number, service name, key fields, field names, timestamp field (or none), rename supported (yes/no + how), 412 behaviour, duplicate-error shape. If rename via OData is **not** supported for a list, stop and tell the user before Task 4 — the spec's rename decision would need revisiting for that list.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-10-30-bc-reference-pages-discovery.md
git commit -m "docs: record BC reference page discovery for customer reference lists"
```

---

### Task 2: Database tables

**Files:**
- Create: `nexus/supabase/migrations/053_add_customer_reference_lists.sql` (re-check number first)
- Modify: `nexus/src/types/database.ts` (add row types + `Database` table entries next to `BusinessCentralCustomer`)

**Interfaces:**
- Produces tables, all with `id uuid pk`, `organization_id uuid not null → organizations on delete cascade`, `bc_connection_id uuid not null → business_central_connections on delete cascade`, `bc_id text` (nullable — OData lists may not have one), `bc_etag text`, `bc_last_modified_at timestamptz`, `last_synced_at timestamptz`, `created_at`, `updated_at`:

| Table | Extra columns | Unique |
|---|---|---|
| `business_central_payment_terms` | `code text not null`, `display_name text not null default ''`, `due_date_calculation text`, `discount_date_calculation text`, `discount_percent numeric not null default 0`, `calculate_discount_on_credit_memos boolean not null default false` | (org, conn, code) |
| `business_central_customer_price_groups` | `code`, `display_name`, `allow_invoice_disc boolean`, `allow_line_disc boolean`, `price_includes_vat boolean` | (org, conn, code) |
| `business_central_tax_areas` | `code`, `display_name`, `tax_type text` | (org, conn, code) |
| `business_central_tax_jurisdictions` | `code`, `display_name`, `report_to_jurisdiction text`, `tax_account_sales text`, `tax_account_purchases text` (+ any field Task 1 shows BC requires on insert) | (org, conn, code) |
| `business_central_tax_area_lines` | `tax_area_code text not null`, `tax_jurisdiction_code text not null`, `calculation_order integer not null default 0` | (org, conn, tax_area_code, tax_jurisdiction_code) |
| `business_central_tax_details` | `tax_jurisdiction_code text not null`, `tax_group_code text not null`, `tax_type text not null`, `effective_date date not null`, `maximum_amount_qty numeric not null default 0`, `tax_below_maximum numeric not null default 0`, `tax_above_maximum numeric not null default 0` | (org, conn, tax_jurisdiction_code, tax_group_code, tax_type, effective_date) |
| `business_central_locations` | `code`, `display_name`, `address_line_1`, `address_line_2`, `city`, `state`, `postal_code`, `country` | (org, conn, code) |
| `business_central_customer_posting_groups` | `code`, `display_name` | (org, conn, code) |
| `business_central_general_business_posting_groups` | `code`, `display_name`, `default_vat_business_posting_group text`, `auto_insert_default boolean` | (org, conn, code) |

Exact OData-backed column set follows Task 1's note; a field BC doesn't expose is dropped, not invented.

- [ ] **Step 1: Write the migration.** Header comment states purpose and that it is re-runnable. RLS enabled on every table; one SELECT policy each, `drop policy if exists <name> on <table>;` then `create policy <name> ... for select using (organization_id in (select organization_id from public.users where id = auth.uid()))`. No insert/update/delete policies. Index `(organization_id, bc_connection_id)` on each.

- [ ] **Step 2: Apply to the dev database twice** (second run proves re-runnability). Run it in the Supabase SQL editor, or with `psql "$DATABASE_URL" -f nexus/supabase/migrations/053_add_customer_reference_lists.sql` if that's how the user applies migrations.
Expected: both runs succeed, no `42710`.

- [ ] **Step 3: Add the row types to `database.ts`** — one interface per table (`BusinessCentralPaymentTerm`, `BusinessCentralCustomerPriceGroup`, `BusinessCentralTaxArea`, `BusinessCentralTaxJurisdiction`, `BusinessCentralTaxAreaLine`, `BusinessCentralTaxDetail`, `BusinessCentralLocation`, `BusinessCentralCustomerPostingGroup`, `BusinessCentralGeneralBusinessPostingGroup`) and the `Database` table entries in the existing style.

- [ ] **Step 4: Verify types** — Run: `cd nexus && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add nexus/supabase/migrations/053_add_customer_reference_lists.sql nexus/src/types/database.ts
git commit -m "feat(bc): tables for customer reference lists"
```

---

### Task 3: BC transport for API and OData sources

**Files:**
- Create: `nexus/src/lib/businessCentral/customerReferences/errors.ts`
- Create: `nexus/src/lib/businessCentral/customerReferences/transport.ts`
- Test: `nexus/src/lib/businessCentral/customerReferences/transport.test.ts`

**Interfaces:**
- Consumes: `BcClient` (`config`, `getAccessToken()`), `BcApiError` from `client.ts`.
- Produces:

```ts
export type ReferenceSource =
  | { kind: 'api'; resource: string }                                   // e.g. 'paymentTerms'
  | { kind: 'odata'; service: string; pageNumber: number; keyFields: string[] };

export type BcKey = { bcId: string } | { values: Record<string, string> };  // api → bcId, odata → key field values

export interface BcRecord { key: BcKey; etag: string; fields: Record<string, unknown> }

export interface ReferenceTransport {
  list(source: ReferenceSource): Promise<BcRecord[]>;               // follows @odata.nextLink
  get(source: ReferenceSource, key: BcKey): Promise<BcRecord>;
  create(source: ReferenceSource, fields: Record<string, unknown>): Promise<BcRecord>;
  patch(source: ReferenceSource, key: BcKey, etag: string, fields: Record<string, unknown>): Promise<BcRecord>;
  remove(source: ReferenceSource, key: BcKey, etag: string): Promise<void>;
}
export function createReferenceTransport(bc: BcClient, companyName: string, fetchImpl?: typeof fetch): ReferenceTransport;
export async function createReferenceTransportForOrg(orgId: string, connectionId: string): Promise<ReferenceTransport>;
```

`errors.ts`:
```ts
export class ReferencePageUnavailableError extends Error { constructor(service: string, pageNumber: number, status: number) }
export class BcConflictError extends Error {}           // HTTP 412
export class BcReferenceError extends Error { readonly status: number; readonly bcMessage: string }  // any other non-OK; message = BC's message
export class ReferenceInUseError extends Error {}
```

API URL: `${apiRoot}/companies(${companyId})/${resource}` (same root `client.ts` uses). OData URL: same base as `noSeriesClient.ts` (`/v2.0/{env}/ODataV4/Company('{name}')/{service}`); single-record key `Service(Field1='v1',Field2='v2')`, single-field key `Service('v')`. Date-typed key fields (tax details `Effective_Date`) are written unquoted (`Effective_Date=2026-01-01`).

- [ ] **Step 1: Write failing tests** with a fake `fetchImpl` recording URL, method, headers, body:
  - `list follows nextLink across pages` — two pages of 2 rows → 4 records.
  - `odata key escapes quotes and encodes` — key `{ Code: "O'HARE/1" }` → URL contains `CustomerPriceGroups('O''HARE%2F1')`.
  - `odata composite key with date` — tax details key → `TaxDetails(Tax_Jurisdiction_Code='CA',Tax_Group_Code='TAXABLE',Tax_Type='Sales%20and%20Use%20Tax',Effective_Date=2026-01-01)`.
  - `patch sends If-Match and only given fields` — body equals exactly `{ "displayName": "Net 30" }`, header `If-Match` = etag.
  - `412 throws BcConflictError`.
  - `404 on odata throws ReferencePageUnavailableError naming page and service` — message contains `page 7` and `CustomerPriceGroups`.
  - `400 throws BcReferenceError carrying BC's message` — body `{"error":{"code":"Internal_EntityWithSameKeyExists","message":"The record already exists."}}` → `.message === 'The record already exists.'`.
  - `api record key uses id, etag from @odata.etag`.

- [ ] **Step 2: Run** `cd nexus && npx vitest run src/lib/businessCentral/customerReferences/transport.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `errors.ts` and `transport.ts`.** Use `bc.getAccessToken()` for the bearer header and `fetchImpl` directly (as `noSeriesClient.ts` does) so both source kinds share one code path. `createReferenceTransportForOrg` resolves `companyName` via `bc.getCompany(bc.config.companyId)` → `.name`, as `createNoSeriesClientForOrg` does.

- [ ] **Step 4: Run tests** → PASS.

- [ ] **Step 5: Commit**

```bash
git add nexus/src/lib/businessCentral/customerReferences/errors.ts nexus/src/lib/businessCentral/customerReferences/transport.ts nexus/src/lib/businessCentral/customerReferences/transport.test.ts
git commit -m "feat(bc): reference-list transport for API and OData sources"
```

---

### Task 4: List definitions

**Files:**
- Create: `nexus/src/types/customerReferences.ts`
- Create: `nexus/src/lib/businessCentral/customerReferences/definitions.ts`
- Test: `nexus/src/lib/businessCentral/customerReferences/definitions.test.ts`

**Interfaces:**
- Consumes: `ReferenceSource`, `BcRecord` (Task 3).
- Produces (in `types/customerReferences.ts`, importable by client components):

```ts
export type ListKey = 'paymentTerms' | 'customerPriceGroups' | 'taxAreas' | 'taxAreaLines'
  | 'taxJurisdictions' | 'taxDetails' | 'locations' | 'customerPostingGroups' | 'generalBusinessPostingGroups';
export type FieldType = 'text' | 'dateFormula' | 'percent' | 'number' | 'boolean' | 'date' | 'select';
export interface FieldSpec {
  name: string;            // Nexus/DB column, snake_case
  bcName: string;          // BC field name (API camelCase or OData Field_Name)
  label: string;
  type: FieldType;
  required?: boolean;
  isKey?: boolean;         // part of the BC key
  editable: boolean;       // false for read-only lists
  optionsFrom?: ListKey | 'taxGroups';  // for 'select'
}
export interface ReferenceEntry { id: string; values: Record<string, unknown>; bcLastModifiedAt: string | null; lastSyncedAt: string | null }
export interface ListPageData { key: ListKey; title: string; mode: 'managed' | 'readOnly'; fields: FieldSpec[]; entries: ReferenceEntry[]; canManage: boolean; deleteDisabledReason: string | null }
```

- Produces (in `definitions.ts`, server-only):

```ts
export interface ListDefinition {
  key: ListKey; title: string; table: string; mode: 'managed' | 'readOnly';
  source: ReferenceSource; fields: FieldSpec[];
  renameField: string | null;          // 'code' for code lists; null for lines/details
  parent?: { list: ListKey; field: string };   // taxAreaLines → taxAreas via tax_area_code
  deleteDisabledReason?: string;
}
export const LIST_DEFINITIONS: Record<ListKey, ListDefinition>;
export function toDbValues(def: ListDefinition, record: BcRecord): Record<string, unknown>;
export function toBcFields(def: ListDefinition, values: Record<string, unknown>): Record<string, unknown>;
```

Titles: Payment terms · Customer price groups · Tax areas · Tax area lines · Tax jurisdictions · Tax details · Locations · Customer posting groups · Gen. bus. posting groups. Sources: API for `paymentTerms`, `taxAreas`, `locations`; OData for the rest with service names, page numbers and field names from the Task 1 note. `taxDetails.tax_group_code` uses `optionsFrom: 'taxGroups'` (existing `business_central_tax_groups`). `customerPriceGroups.deleteDisabledReason` = the exact copy in Global Constraints.

- [ ] **Step 1: Failing tests:**
  - `every definition has exactly one renameField or key fields` — code lists: `renameField === 'code'`; `taxAreaLines`, `taxDetails`: `renameField === null` and ≥2 `isKey` fields.
  - `read-only lists have no editable fields`.
  - `toDbValues maps paymentTerms API record` — `{ code:'30 DAYS', displayName:'Net 30 days', dueDateCalculation:'30D', discountPercent:0 }` → `{ code:'30 DAYS', display_name:'Net 30 days', due_date_calculation:'30D', discount_percent:0, … }`.
  - `toBcFields round-trips toDbValues` for one API and one OData list.
  - `price groups carry the delete-disabled reason`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** (`types/customerReferences.ts`, `definitions.ts`, `definitions.test.ts`) — `feat(bc): customer reference list definitions`.

---

### Task 5: Merge and validation (pure)

**Files:**
- Create: `nexus/src/lib/businessCentral/customerReferences/merge.ts`, `merge.test.ts`
- Create: `nexus/src/lib/businessCentral/customerReferences/validation.ts`, `validation.test.ts`

**Interfaces:**
- Produces:

```ts
// merge.ts
export function changedFields(original: Record<string, unknown>, edited: Record<string, unknown>, fields: FieldSpec[]): string[];
export interface LocalRow { id: string; bcId: string | null; keyValues: Record<string, string>; values: Record<string, unknown>; etag: string | null }
export interface SyncPlan { inserts: BcRecord[]; updates: { id: string; record: BcRecord }[]; deletes: string[] }
export function planSyncPull(def: ListDefinition, local: LocalRow[], remote: BcRecord[]): SyncPlan;

// validation.ts
export function validateEntry(fields: FieldSpec[], values: Record<string, unknown>): string[];  // [] = valid; else user-facing messages
```

`merge.ts` and `validation.ts` must not import `server-only` or `definitions.ts` values — `validateEntry` and `changedFields` also run in the browser (Task 9); they take `FieldSpec[]` from `types/customerReferences.ts`. Only `planSyncPull` takes a `ListDefinition` (type-only import).

Matching in `planSyncPull`: by `bcId` when both sides have one, otherwise by key values (case-sensitive, BC codes are upper-case). A matched row is an update only if some field or the etag differs.

- [ ] **Step 1: Failing tests:**
  - `changedFields ignores untouched fields` — description changed only → `['display_name']`.
  - `changedFields treats '' and null as equal`.
  - `planSyncPull: new remote → insert; missing remote → delete; different → update; identical → nothing`.
  - `planSyncPull matches renamed API row by bcId` — local `{bcId:'A', code:'OLD'}`, remote `{bcId:'A', code:'NEW'}` → one update, no insert/delete.
  - `validateEntry: percent 7 is valid and stays 7`; `percent -1 and 100.01 → 'Discount % must be between 0 and 100'` (and `'Tax below maximum must be between 0 and 100'` for tax details).
  - `validateEntry: code required, max 10 chars, upper-cased check` → `'Code is required'`, `'Code can be at most 10 characters'` (BC code fields are Code[10]; confirm per list in Task 1, use 20 where BC uses Code[20]).
  - `validateEntry: date formula` — `30D`, `1M`, `CM`, `CM+1M`, `1M+5D` valid; `30 days`, `abc` → `'Use a BC date formula like 30D, 1M or CM'`.
  - `validateEntry: tax details effective date required and a real date`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** Date-formula check: regex over terms `^(CM|CQ|CY|CW|[+-]?\d+[DWMQY]|[+-]?C[DWMQY])([+-](\d+[DWMQY]|C[DWMQY]))*$` (case-insensitive). **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** — `feat(bc): field-level merge, sync planning and validation for reference lists`.

---

### Task 6: Save, delete and sync service

**Files:**
- Create: `nexus/src/lib/businessCentral/customerReferences/service.ts`
- Test: `nexus/src/lib/businessCentral/customerReferences/service.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5; `countUsage` from Task 7 (inject it — see signature).
- Produces:

```ts
export interface ServiceDeps { supabase: SupabaseClient; transport: ReferenceTransport; orgId: string; connectionId: string; now: () => string;
  countUsage: (def: ListDefinition, row: LocalRow) => Promise<string | null> }   // null = unused; else e.g. 'Used by 12 customers'
export async function saveEntry(deps: ServiceDeps, def: ListDefinition, input: { id: string | null; original: Record<string, unknown> | null; edited: Record<string, unknown> }): Promise<ReferenceEntry>;
export async function deleteEntry(deps: ServiceDeps, def: ListDefinition, id: string): Promise<void>;
export async function syncList(deps: ServiceDeps, def: ListDefinition): Promise<{ inserted: number; updated: number; deleted: number }>;
```

Behaviour:
- `saveEntry` create (`id === null`): validate → `transport.create` → insert row from the returned record.
- `saveEntry` edit: validate → `changedFields` → if none, return unchanged → `transport.patch(key, storedEtag, toBcFields(changed only))`; on `BcConflictError`: `transport.get` → patch again with fresh etag and the same changed fields; a second `BcConflictError` → throw `Error('This entry changed in Business Central again while saving. Try again.')`. On success, update the row from BC's returned record (this also applies a rename: for OData lists, the row's key values change in place).
- `deleteEntry`: throw `def.deleteDisabledReason` if set → `countUsage` non-null → throw `ReferenceInUseError(message)` → `transport.remove` → delete row. For `taxAreas`, also delete the area's Nexus `tax_area_lines` rows after BC confirms (BC cascades lines).
- `syncList`: `transport.list` → `planSyncPull` → apply inserts/updates/deletes; set `last_synced_at = now()` on every touched row. Read-only lists use the same path.
- BC errors propagate unchanged; the Nexus row is never touched before BC succeeds.

- [ ] **Step 1: Failing tests** with an in-memory fake transport and a fake Supabase (follow the mock style of `nexus/src/app/actions/businessCentralConnections.test.ts`):
  - `edit sends only changed fields` — fake transport sees `{ displayName: 'Net 30' }` only.
  - `412 then success re-reads and re-applies only changed fields` — BC changed `discountPercent` meanwhile; final BC state keeps BC's discount and Nexus's description.
  - `two 412s throw the try-again message and leave the row unchanged`.
  - `rename to existing code surfaces BC message and leaves Nexus row unchanged` (Review Focus 2).
  - `create failure leaves no Nexus row`.
  - `delete blocked when countUsage returns a message`; `price group delete throws the disabled reason without calling BC`.
  - `delete tax area removes its Nexus lines after BC confirms`.
  - `syncList applies plan and reports counts`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** — `feat(bc): save, delete and sync service for reference lists`.

---

### Task 7: Usage checks

**Files:**
- Create: `nexus/src/lib/businessCentral/customerReferences/usage.ts`, `usage.test.ts`

**Interfaces:**
- Produces: `export function createUsageCounter(bc: BcClient, supabase: SupabaseClient, orgId: string, connectionId: string): ServiceDeps['countUsage']`

Rules:
- `paymentTerms`, `taxAreas`: count **live** from BC — `bc.listResourcePage('customers', { filter: "paymentTermsId eq <bcId>", top: 1000 })` / `taxAreaId eq <bcId>` — not the mirror (Review Focus 5). Message: `Used by N customer(s)`.
- `taxJurisdictions`: count rows in Nexus `business_central_tax_area_lines` and `business_central_tax_details` with that `tax_jurisdiction_code` for the connection. Message: `Used by N tax area lines and M tax details`.
- `taxAreaLines`, `taxDetails`: always `null` (children may be deleted freely).
- `customerPriceGroups`: never reached (disabled earlier).

- [ ] **Step 1: Failing tests:** `payment term in use by 3 BC customers → 'Used by 3 customers'`; `uses live BC count even when mirror says 0`; `unused → null`; `jurisdiction used by 2 lines and 1 detail → message`; `1 customer → 'Used by 1 customer'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(bc): usage checks before deleting reference entries`.

---

### Task 8: Server actions

**Files:**
- Create: `nexus/src/app/actions/customerReferenceLists.ts`
- Test: `nexus/src/app/actions/customerReferenceLists.test.ts`

**Interfaces:**
- Produces (`'use server'`):

```ts
export async function getReferenceListPage(key: ListKey, filter?: { parentCode?: string }): Promise<ListPageData>;
export async function saveReferenceEntry(key: ListKey, input: { id: string | null; original: Record<string, unknown> | null; edited: Record<string, unknown> }): Promise<{ ok: true; entry: ReferenceEntry } | { ok: false; error: string }>;
export async function deleteReferenceEntry(key: ListKey, id: string): Promise<{ ok: true } | { ok: false; error: string }>;
export async function syncReferenceList(key: ListKey): Promise<{ ok: true; inserted: number; updated: number; deleted: number } | { ok: false; error: string }>;
export async function getSelectOptions(source: ListKey | 'taxGroups'): Promise<{ code: string; label: string }[]>;
```

Each mutating action: `requireActiveBusinessCentralScope()` → reject non-admins with `'Only admins can change customer reference lists'` → reject `readOnly` lists for save/delete with `'This list is managed in Business Central'` → build deps (`createServiceClient()`, `createReferenceTransportForOrg`, `createUsageCounter`) → call the service → `revalidatePath('/customer-lists')`. Errors are returned as `{ ok:false, error }` with the thrown message (so BC's reason reaches the user). `getReferenceListPage` uses the user's client (RLS select) and sets `canManage = access.isAdmin`.

- [ ] **Step 1: Failing tests** (mock `environmentScope`, supabase server, transport factory): `non-admin save → ok:false with admin message, BC not called`; `save on locations → read-only message`; `BC error message is returned verbatim`; `page data canManage reflects isAdmin`; `taxAreaLines page filtered by parentCode`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(bc): server actions for customer reference lists`.

---

### Task 9: List pages and navigation

**Files:**
- Create: `nexus/src/app/(protected)/customer-lists/page.tsx` — hub: two groups ("Managed in Nexus" / "Copied from Business Central") linking to each list except `taxAreaLines` (reached from a tax area).
- Create: `nexus/src/app/(protected)/customer-lists/[list]/page.tsx` — validates `list` against `ListKey` (else `notFound()`), loads `getReferenceListPage`.
- Create: `nexus/src/components/customerReferences/ReferenceListClient.tsx`, `ChangePreview.tsx`
- Test: `nexus/src/components/customerReferences/ReferenceListClient.test.tsx`
- Modify: `nexus/src/components/layout/AppNav.tsx` — add `{ label: 'Customer lists', href: '/customer-lists', icon: ListChecks }` to the **Receivables** group, after `Customers`.

**Interfaces:**
- Consumes: Task 8 actions, `ListPageData`, `FieldSpec`.
- `ReferenceListClient` props: `{ data: ListPageData; selectOptions: Record<string, { code: string; label: string }[]> }`.
- `ChangePreview` props: `{ fields: FieldSpec[]; original: Record<string, unknown> | null; edited: Record<string, unknown>; onConfirm(): void; onCancel(): void }` — lists each changed field as `Label: old → new` (create shows all values), with the heading `These changes will be saved to Business Central`.

Behaviour: table of entries; admins see **Sync with BC**, **Add**, row **Edit** / **Delete**; non-admins see the table only. Form → client-side `validateEntry` messages → `ChangePreview` → action. Delete shows a confirm, then the action's error (e.g. `Used by 12 customers`) inline. A disabled delete shows `deleteDisabledReason` as its tooltip/text. Read-only lists show only **Sync with BC** and a line `Managed in Business Central — copied here to pick from.` Tax areas rows link to `/customer-lists/tax-areas/[code]`. Follow the look of `nexus/src/components/itemCategories/ItemCategoriesClient.tsx`.

- [ ] **Step 1: Failing component tests:** `non-admin sees no Add/Edit/Delete/Sync`; `edit shows ChangePreview with only the changed field`; `action error is shown inline`; `price group delete is disabled with the reason`; `read-only list shows only Sync and the managed-in-BC line`; `invalid percent shows validation message and does not call the action`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(ui): customer reference list pages`.

---

### Task 10: Tax area detail page

**Files:**
- Create: `nexus/src/app/(protected)/customer-lists/tax-areas/[code]/page.tsx`
- Create: `nexus/src/components/customerReferences/TaxAreaDetailClient.tsx`

**Interfaces:**
- Consumes: `getReferenceListPage('taxAreas')` (find by code), `getReferenceListPage('taxAreaLines', { parentCode })`, `ReferenceListClient` for the lines table with `tax_area_code` fixed to the area's code and hidden.

Shows the area's fields (editable for admins, same form + `ChangePreview`), then its jurisdiction lines (add / edit calculation order / delete), and per line a link to `/customer-lists/taxDetails?jurisdiction=<code>`. The `[list]` page honours `?jurisdiction=` for `taxDetails` by filtering on `tax_jurisdiction_code`. An area with zero lines shows a warning: `This tax area has no jurisdictions, so it calculates no tax.`

- [ ] **Step 1: Failing test** in `ReferenceListClient.test.tsx` or a new `TaxAreaDetailClient.test.tsx`: `zero lines shows the no-jurisdictions warning`; `adding a line pre-fills tax_area_code`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(ui): tax area detail with jurisdiction lines`.

---

### Task 11: Whole-feature verification in the running app

No new code unless something fails.

- [ ] **Step 1: Static checks** — Run: `cd nexus && npm test && npx tsc --noEmit && npm run lint && npm run build` → all pass.
- [ ] **Step 2: Load the app** (`npm run dev`, a build passing does not prove it runs) signed in as an admin on BC TEST and, for each list, press **Sync with BC** → row counts match BC (payment terms: 16).
- [ ] **Step 3: Round trips on throwaway entries in BC TEST** (user OK first): create payment term `ZZNEXUS` → visible in BC; edit description in BC, edit discount % in Nexus → both changes present in BC; rename to `ZZNEXUS2` → BC shows the new code; delete → gone from both. Repeat create/rename/delete for a price group (delete expected disabled — remove it in BC, then Sync removes it from Nexus). Create a tax jurisdiction, a tax detail at 7%, a tax area with that line → all visible in BC with 7%; delete the jurisdiction → blocked with the usage message; delete detail, line, area, then jurisdiction → all gone.
- [ ] **Step 4: Non-admin check** — as a non-admin, every list is viewable and shows no edit controls.
- [ ] **Step 5: Record results** in `BACKLOG.md` under Done (what was verified, migration number to apply on deploy, BC pages to publish in production), and commit `BACKLOG.md` alone.
