# Backlog

A running list of things to do. Reference items by number, e.g. "do #2" or "add X to the backlog".

## To do

1. **Ship `feature/billcom-connector`** — Bill.com connector, piece D's plumbing slice. Code complete: 7 tasks, 18 tests, tsc/lint/build clean, per-task reviews plus a whole-branch review (verdict: **merge with fixes**, all applied and re-reviewed clean). Nothing has ever run against a database or against Bill.com.
   - ~~**Apply migrations 045 and 046.**~~ — ✅ applied and verified 2026-09-05. Table present, RLS on with zero policies, all five functions exist, and `anon` cannot execute any of them.
   - ~~**Verify `delete_billcom_secrets`**~~ — ✅ round-tripped against the live database 2026-09-05, all six checks passing: both secrets set and read back, rotation takes effect and reuses the existing Vault pointer, and `delete_billcom_secrets` removes both. This also confirmed `service_role` *can* execute the functions, which the `anon`-lockout check alone would not have caught. Incidentally reproduced the dangling-pointer state behind the partial-delete follow-up below: after deletion the pointer column survives while the Vault row is gone.
   - **⚠️ A Bill.com sandbox account must exist** before anything can be verified. Self-service signup; this is the gating human step, the same class as publishing BC page 457 (which sat unnoticed for three weeks).
   - **Task 8's first check must be the error envelope.** The client assumes Bill.com signals failure through HTTP status codes. Bill.com **v2 returns HTTP 200 with an error envelope in the body**, and the spike never recorded whether v3 kept that convention. If it did: `response.ok` is true for every error, `errorFor()` never runs, the rate-limit class never fires, the 401 re-login-and-retry never triggers, and `request()` returns the error envelope cast to `T`. No test can catch this — every test builds its own `Response` with a status the author chose. Verify this before trusting any of the error handling.
   - ~~**Confirm the production hostname.**~~ — ✅ resolved 2026-09-05 against BILL's live docs. `gateway.prod.bill.com` was right, but **both base URLs were missing the `/connect` path segment** — the real login endpoint is `https://gateway.stage.bill.com/connect/v3/login`, so every login would have 404'd. Fixed in both the server allowlist and the UI.
   - **A sandbox account is a separate signup from your production BILL account** — confirmed in BILL's docs ("create a new account in the Production BILL web app"; sandbox credentials do not work in production). Your existing company account is the production one; sandbox cannot be enabled on it. Sandbox base URL `https://gateway.stage.bill.com/connect`, production `https://gateway.prod.bill.com/connect`.
   - Full plan: `docs/superpowers/plans/2026-09-04-billcom-connector.md` (Task 8 is the manual pass). Design: `docs/superpowers/specs/2026-09-03-billcom-connector-design.md`.
2. **Bill.com connector follow-ups** (non-blocking; from the whole-branch review).
   - **Partial delete is unrecoverable through the UI.** `deleteBillcomConnection` is not transactional: if the row delete fails after `delete_billcom_secrets` succeeds, the row survives with a dangling Vault pointer. `set_billcom_dev_key` then takes its "pointer is not null" branch and calls `vault.update_secret` on a deleted id, so **re-entering the key through Edit silently no-ops** while `hasCredentials` still renders true. The operator sees a connection that claims credentials, cannot fix it, and gets no error.
   - `saveBillcomConnection` clears other defaults before writing the row; a failed write leaves the org with no default and no explanation. Also non-transactional.
   - `request()` treats any 401 as session expiry before consulting `errorFor()`, and clears a valid `session_id` in the process — so a rate limit returned as 401 costs two logins, not one.
   - `BillcomConnectionDisabledError` extends `Error` while the other three extend `BillcomApiError`; a consumer catching `BillcomApiError` silently misses the disabled case.
   - `touch()` issues a read on every call even when it skips the write. Free today (nothing calls `request()` in production), real for piece E's bulk push.
   - `billcom_connections` is absent from `types/database.ts`; `is_default`, `client.getSession()` and `client.request()` have no production consumer yet.
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
