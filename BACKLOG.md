# Backlog

A running list of things to do. Reference items by number, e.g. "do #2" or "add X to the backlog".

## To do

1. **BC ↔ Bill.com customer sync — 4 projects, done one at a time.** Projects 1 and 2 are merged to `main` (not yet pushed to GitHub after project 2). **Next: project 3.**
   1. ✅ Customer reference lists — see Done.
   2. ✅ Customer templates — see Done.
   3. **Customers ↔ BC** (next, not designed yet). Includes the New customer form: pick a template, then type Name (required), Invoice email → BC E-Mail (required), Invoice email CC → BC "Email CC", Phone no. (required), Address. Payment terms and Tax area start from the template's value and are editable per customer (both required). Template-only (not on the form): No. series, Tax liable, Tax identification type, Customer price group, Application method, Location, posting groups, contact type. When customers sync, re-enable price-group delete (disabled until now).
   4. **Customers ↔ Bill.com**, matched on the BC customer number. Bill.com payment terms were dropped; piece E sends due dates calculated by BC.
   - **Before using production BC:** publish the same web services there as in TEST — pages 7 (`CustomerPriceGroups`), 110 (`CustomerPostingGroups`), 312 (`GenBusinessPostingGroups`), 465 (`TaxAreaLines`), 466 (`TaxJurisdictions`), 468 (`TaxDetails`), Customer Templ. Card (`CustomerTemplates`), No. Series (`NoSeries`). Without `CustomerTemplates`, Nexus refuses every payment-term and tax-area delete.
   - **Housekeeping:** old worktrees `../Artwork Review Tool-crl` and `../Artwork Review Tool-ct` (and their branches) are fully merged and can be deleted.
   - **Unchecked minor:** the templates list has 7 columns; phone width passed a quick manual check but wasn't looked at closely.

2. **Bill.com connector follow-ups** (non-blocking; from the whole-branch review).
   - **Partial delete is unrecoverable through the UI.** `deleteBillcomConnection` is not transactional: if the row delete fails after `delete_billcom_secrets` succeeds, the row survives with a dangling Vault pointer. `set_billcom_dev_key` then takes its "pointer is not null" branch and calls `vault.update_secret` on a deleted id, so **re-entering the key through Edit silently no-ops** while `hasCredentials` still renders true. The operator sees a connection that claims credentials, cannot fix it, and gets no error.
   - `saveBillcomConnection` clears other defaults before writing the row; a failed write leaves the org with no default and no explanation. Also non-transactional.
   - `request()` treats any 401 as session expiry before consulting `errorFor()`, and clears a valid `session_id` in the process — so a rate limit returned as 401 costs two logins, not one.
   - `BillcomConnectionDisabledError` extends `Error` while the other three extend `BillcomApiError`; a consumer catching `BillcomApiError` silently misses the disabled case.
   - `touch()` issues a read on every call even when it skips the write. Free today (nothing calls `request()` in production), real for piece E's bulk push.
   - `billcom_connections` is absent from `types/database.ts`; `is_default`, `client.getSession()` and `client.request()` have no production consumer yet.
   - The connection form `.trim()`s the password before saving, so a password with leading/trailing spaces is silently stored wrong and Bill.com rejects it as "User name and/or password do not match our records". Rare, but the fix is to stop trimming the password (keep the empty-means-unchanged check).
3. **Bill.com pieces C, E and F** — not yet designed. Decomposition in `docs/superpowers/specs/2026-07-24-billcom-ar-sync-feasibility-spike.md`. C: customer write-back to BC · E: invoice push + payment status pull · F: payment posting into BC — **high risk, writes to the general ledger**. Piece E must also address Bill.com's 3-concurrent-request limit, which this slice did not need.

4. **Ship `feature/bc-customer-ar-sync`** — BC customer + AR read sync (pieces A+B). **Code complete and verified against the live BC TEST environment.** 188 tests, lint/tsc/build clean, full per-task + whole-branch review, all 14 tasks done.
   - Verified in TEST: ~1,975 customers, ~412 posted sales invoices, 1,507 ledger entries, 1,806+ invoice lines. Aging buckets render, three customers reconcile against BC's own aged-AR report, and dates match BC.
   - Merge path is settled: `main` now carries item-creation and the categories page (PRs #2 and #3), so this branch targets `main` directly. Migration 040's `time_zone` column — its one dependency — is already in.
   - **On deploy: apply migrations 041, 042, 043.** 042 requires **Postgres 15+** (`security_invoker`) — it fails loudly, not silently, if older. **041 is not re-runnable:** `create policy` has no `IF NOT EXISTS`, so a partial apply then retry errors with `42710`. (This exact failure hit migration 039 on 2026-08-28; the recovery is to check whether the objects already exist rather than re-running blind.)
2. **BC AR sync follow-ups** (non-blocking; from the whole-branch review). Full findings ledger: `.superpowers/sdd/progress.md`.
   - **Shared validation helper across all four AR mappers** — none validate required BC id fields or numerics at runtime. A malformed payload yields `undefined` for a NOT NULL column and fails with a raw DB constraint error rather than a clear one. Fails loud, isolated to one entity. The ledger mapper also lacks `numberOrNull`, so `Number(row.Entry_No)` can be `NaN` and an empty `Amount` becomes `0`.
   - **AR sync events are never written.** Migration 041 added `entity_type`/`entity_id` to `business_central_item_sync_events` precisely so all four AR entities could log there, but no AR code writes one — dead schema and a missing audit trail.
   - **Normalize `customer_no` on ingest.** `customerMapper` trims `bc_customer_number`; the ledger mapper stores `customerNo` raw. The read sites are guarded, but `AgingDashboard`'s customer links are a second consumer that would miss on a padded value.
   - **Invoice lines are not posted-filtered** — draft-invoice lines get mirrored with no parent row. Harmless today (nothing reads lines) but piece E inherits the orphans.
   - **Derive `overdue_amount` from our own ledger entries.** BC rejects `$expand=customerFinancialDetails` on `customer`, so that column can never populate from BC and the Overdue UI was removed. We have the ledger data to compute it ourselves, which would also restore the independent cross-check on our aging arithmetic that the spec wanted.
   - **Invoice lines have their own sync path** (`salesInvoiceLineSync.ts`), outside the shared runner, because BC cannot query `salesInvoiceLines` as a flat collection. If more nested BC data is ever synced, teaching the shared runner one-to-many properly would be the better design.
   - Minor: `nullif(trim(time_zone),'')` hardening in view 042; delete unused `todayInTimeZone`; paginate the customers list; `days_overdue ?? 0` renders a missing due date as "0" (reads as not-overdue).
3. **BC item-creation follow-ups** (feature shipped — see Done).
   - **Verify `defaultIsDuplicate` against the real BC sandbox** — confirm the exact duplicate-number error (status/code/message) BC returns on item insert and tighten the heuristic (`nexus/src/app/actions/businessCentralItems.ts`, add a `details.code` check). Safe direction is contained; this is about not mis-handling a real duplicate.
   - **Optional:** scope `resolveSeriesCodeForCategory` by `bc_connection_id` too (currently org-only; low risk since categories are env-scoped).
   - **Observability:** a post-create commit failure leaves a real BC item with no Nexus row + advanced counter; self-heals on next sync — consider logging a reconciliation warning.
   - Full per-task findings ledger: `.superpowers/sdd/progress.md`.
4. **Phase 4: proper BC item-editing permissions** — replace the temporary admin gates with the dedicated item-manager permission.
   - `nexus/src/components/items/ItemsClient.tsx:137` → use `canEditBusinessCentralItemBcFields` instead of `access.isAdmin`
   - `nexus/src/app/actions/businessCentralItemsSpike.ts:37` → use the dedicated item-manager permission instead of `canManageCatalog`
5. **Phase 5: BC edit-conflict handling** — handle the case where Business Central is updated while an item has unsaved local edits, to prevent silent overwrites. See `nexus/src/components/items/ItemsClient.tsx:1383`.
6. **Item categories follow-ups** (non-blocking; feature shipped — see Done).
   - **Dead write path:** `bcNoSeriesCode` on `createCategory`/`updateCategory` is unreachable — the page writes via `saveCategoryNumbering` instead. Two write paths for one column, one unwired. Remove it, or wire `CategoryForm` to use it.
   - No nav link to `/item-categories` — access is the items-page button by design. Revisit if that proves hard to find.
7. **Bill.com integration — pieces C through F**, not yet designed. Decomposition and API research in `docs/superpowers/specs/2026-07-24-billcom-ar-sync-feasibility-spike.md`. Each piece warrants its own spec → plan → implementation cycle, and none should start until the AR sync branch lands.
   - C: customer write-back to BC · D: Bill.com connector (session auth, credential storage, toggle) · E: invoice push + payment status pull · F: payment posting into BC — **high risk, writes to the general ledger**.
8. **The database cannot be rebuilt from migrations** — confirmed 2026-09-03, not yet fixed. A disaster-recovery hole, not a today-problem: every existing environment was built by applying migrations as they landed, so the live databases are fine. But nobody can stand up a new one from scratch.
   - **Proven break:** `001_initial_schema.sql` creates **`packaging_items`**, and migrations 002–011 reference it. No migration ever renames it. Then `015_add_business_central_item_sync.sql:236` does `ALTER TABLE items` — so on an empty database the chain dies there with `relation "items" does not exist`. `027_scope_workspace_to_bc_environments.sql:11` and `036_add_bc_purchases_linking.sql:27` would fail the same way. The rename was done by hand against the live DB somewhere between 011 and 015 and never committed.
   - **Proposed fix** (safe, and a no-op against every existing database because `items` already exists there). File it as `014a_rename_packaging_items_to_items.sql` so it sorts after 014 and before 015:
     ```sql
     DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='packaging_items')
          AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                          WHERE table_schema='public' AND table_name='items') THEN
         ALTER TABLE packaging_items RENAME TO items;
       END IF;
     END $$;
     ```
   - ⚠️ **That fixes only the one break that has been proven.** Whether 001→044 then runs clean on an empty database is unknown — this is untracked schema drift, and there is no reason to assume it happened exactly once. The only way to close the item honestly is to run the full chain against a scratch Supabase project and fix whatever else it hits.
   - **Related, benign:** migration **034 is missing** from the sequence (001–044 is otherwise contiguous, no duplicates). It never existed in git — it was applied live and never committed — and `035_revert_po_items_catalog.sql` undoes it with `IF EXISTS` on every statement, so it is a no-op on a fresh database. Same root cause as above; no fix needed, worth a comment in 035 so the gap doesn't get re-investigated.

## Done

- **Customer templates (customer sync project 2)** — merged to `main` 2026-10-30 (`255acfe`). Migration **054** applied. Admins manage BC customer templates (13 fields) in Nexus with two-way sync; read-only copy of BC number series (No. series dropdown offers codes containing "CUST" — today CUST, CUSTCONTR, FUND-CUST, WHSL-CUST). Templates count as usage, so a payment term or tax area used by a template can't be deleted; renames of payment terms, price groups or tax areas re-pull templates. Sync now inserts in one batch and shows "Syncing…". Live-tested in BC TEST (create/edit/rename/delete, usage block, rename cascade, cleanup). 375 tests. Spec `docs/superpowers/specs/2026-10-30-customer-templates-design.md`, BC notes `docs/superpowers/notes/2026-10-30-bc-customer-templates-discovery.md`.
- **Customer reference lists (customer sync project 1)** — merged and pushed to `main` 2026-10-30 (`379b9e6`). Migration **053** applied. Payment terms, price groups, tax areas/lines/jurisdictions/details managed in Nexus with BC sync; locations and posting groups read-only copies. Live-tested in BC TEST; live fixes: re-read etag after create, scrolling pages with fixed table headers. Spec `docs/superpowers/specs/2026-10-29-customer-reference-lists-design.md`, BC notes `docs/superpowers/notes/2026-10-30-bc-reference-pages-discovery.md`.

- **Ship and verify the Bill.com connector (piece D plumbing slice)** — merged to `main` as **PR #6**; migrations 045 and 046 applied and verified 2026-09-05. End-to-end verification against a real Bill.com **sandbox** passed 2026-10-29:
  - **Error envelope question answered — v3 does *not* use v2's HTTP-200-with-error-body convention.** Probing `/connect/v3/login` returned real statuses (400 for a bad developer key, 401 for bad username/password). The status-based error handling stands.
  - **But the error body shape was wrong.** v3 returns an array `[{ timestamp, code, severity, category, message }]`, not `{ error_code, error_message }`. The parser found nothing, so every failure showed only "401 Unauthorized" and `BDC_1144` rate limits could never be detected. Fixed on `fix/billcom-error-body` (`5b3f520`), test fixtures moved to the real shape, plus a test asserting the message surfaces.
  - **Failure case first:** wrong credentials produced a red inline message ("User name and/or password do not match our records."), no crash. The cause was a sandbox account with a different password than expected; a reset fixed it. Sandbox username is the sign-in email.
  - **Success case:** "Connected to Bill.com and started a session." The `billcom_connections` row had `session_id` stored and `session_last_used_at` about 20 seconds old.
  - **Disable clears the session:** after toggling off, `is_enabled = false`, `session_id` and `session_last_used_at` both `null`. Re-enabling and testing again produced a fresh session.
  - **Lockdown:** the anon key gets `permission denied for table billcom_connections`. The `set role authenticated` check from the plan was not run separately.
  - **Session reuse** (Task 8 Step 5) is covered by unit tests only, as the plan anticipated, because `request()` has no production caller yet.
  - Full suite at verification: 217 tests passing, tsc clean, lint 0 errors (4 warnings, all in unrelated files). The production build was not re-run.
- **Ship BC item creation + the Item Categories page** — merged to `main` 2026-08-28 as **PR #2** (`e2a549f`, 19 commits) and **PR #3** (`4729919`, 20 commits). Shipped together because item-creation cannot be *configured* without the categories page's editor for `categories.bc_no_series_code`. Migrations **038, 039, 040, 044** confirmed applied. Post-merge `main`: 112 tests passing, `next build` clean, `/item-categories` in the route manifest.
  - Note for future stacked PRs: GitHub only auto-retargets a stacked PR when its base branch is *deleted*, and this repo has auto-delete off — #3 had to be retargeted to `main` by hand after #2 merged, or it would have merged into a stale branch.
  - Migrations 041–043 (AR) and 044 (categories) turned out to be fully independent — 044 creates one index on `item_templates`; 041–043 create the `business_central_*` AR tables and view, and reference `item_templates` only in a comment. No renumbering was needed.
- **Merge the multi-BC-environment PR** — PR #1 merged to `main` 2026-07-28. Migrations 027–037 apply on deploy.
- **End-to-end verification of BC auto-numbering (Task 8)** — passed 2026-08-27 against the live TEST environment, after publishing page 457 as OData service `NoSeriesLines` in both environments. Evidence:
  - **Failure cases first** (deliberately, before the happy path): `CHOC-BARKK` → `SeriesNotFoundError`; `J-PL` → `SeriesNotNormalError` ("Allow Gaps must be off"). The second one proves the OData read genuinely reached BC — the Allow-Gaps state can only come from page 457.
  - **Success case:** item **B-2007** ("Haupia Pie Bark - Bag") created in BC from a template. `business_central_items` row has a real `bc_item_id`/`bc_etag`, `sync_status: synced`, `sync_error: null`; sync event `direction: create, status: success`. Template fields landed in BC: `BAG`, `CHOCOLATE-FG`, `CHOC-FG`, `TAXABLE`, `Inventory`. No orphan — the feared "BC item with no Nexus row + advanced counter" did not occur.
  - **Counter advanced correctly:** `Last_No_Used` = `B-2007`, `Last_Date_Used` = the Hawaii date (row written 07:29 UTC on the 28th, so this confirms the per-environment `Pacific/Honolulu` stamping).
  - **Manual override:** typed number used, counter did **not** advance.
- **Replicate BC item creation in Nexus (templates + number series)** — built on branch `feature/bc-item-creation` (stacked on `feature/multi-bc-environments`). 11 commits `8e8679e..5e51db4`; 102/102 tests, lint+tsc clean; full subagent review (per-task + whole-branch). Item-creation templates + per-category auto-numbering that drives BC's real No. Series counter via the published Page 457 OData service ("A+", create-then-advance, Normal-only, advance-only/range/ETag guards, per-environment time-zone date stamp). Spec: `docs/superpowers/specs/2026-06-26-...-design.md`; plan: `docs/superpowers/plans/2026-06-26-...md`. Remaining items moved to To-do #3.
