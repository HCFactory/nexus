# Create Invoice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Create invoice button on a sales order that posts it in BC (ship and invoice), records the posted invoice, and creates the matching Bill.com invoice, through a tracked process that can resume and never posts or bills twice.

**Architecture:** A new `invoice_state` on `sales_orders` drives a state machine (`invoiceProcess.ts`) that runs one step at a time under the order's existing lease (`withOrderClaim`), in the background via `after()`, like order saves. BC posting lives in `bcInvoicing.ts`, and the Bill.com invoice in `billcom/invoicePayload.ts` + `billcom/invoicePush.ts`. Server actions in `salesOrderInvoicing.ts` start and retry it. The order page shows the button, a confirm box and the states.

**Tech Stack:** Next.js 16 App Router (server actions, `after()`), React 19, Supabase (service client for writes, RLS select-by-org), Vitest + jsdom, BC API v2.0 + OData (`ReferenceTransport`), Bill.com v3 (`BillcomClient.request`).

**Spec:** `docs/superpowers/specs/2026-11-15-create-invoice-design.md`

## Global Constraints

- TEST BC and the Bill.com **sandbox** only. Never call production BC or production Bill.com.
- Posting in BC can't be undone. Only Task 1 (with the user's go-ahead) and Task 9 post on purpose, both on TEST test orders (W-1005xx).
- Stage specific paths only, never `git add -A`. Never stage `droid-telegram-bot`. Don't push or merge.
- Create invoice and Retry need `canEditSalesOrders` (decided, P1).
- Allowed from status **Final or Pulled** only, with sync state `synced`, no unsaved form edits, `invoice_state = 'none'`, and a Bill.com link with status `synced` plus a `billcom_customer_id`.
- Invoice date = posting date = today in the BC connection's time zone (`todayIn(timeZoneOf(scope))`).
- Bill.com invoice number = the order's Invoice # (`invoice_number ?? autoInvoiceNumber(bc_order_number, customer_po)`). Lines come from **Nexus's order lines**: unit price after discount = `effectivePrice × (1 − effectiveDiscount/100)`, line amount = round2(qty × that). Tax = BC's posted tax. The sum must equal BC's posted total incl. tax to the cent, else `billcom_failed` with the difference.
- Bill.com `sendEmail` is off: no email to the customer.
- Invoice states (exact strings): `none`, `posting`, `post_failed`, `posted`, `billcom_sending`, `billcom_failed`, `done`.
- Past posting = `posted`, `billcom_sending`, `billcom_failed`, `done`. These orders are never synced to BC again (no save, sweep, Try again, Overwrite or delete).
- Blocked-customer messages (exact copy):
  - no link or `pending`: `This customer isn't in Bill.com yet. Push it from Customers first.`
  - `needs_attention`: `Add a name and email to this customer in Customers before invoicing.`
  - `failed`: `This customer couldn't be sent to Bill.com. Retry it from Customers first.`
  - Bill.com connection off or missing: `Bill.com is turned off. Turn it on in Settings before invoicing.`
- Order status line copy: `Invoicing…`, `Couldn't post`, `Invoiced · Not in Bill.com`, `Invoiced · In Bill.com`.

## Review Focus

- **Double click, or two tabs press Create invoice:** exactly one process runs; the second click sees the lease and changes nothing. (Task 5 test)
- **Order changed in BC between the last save and the click:** nothing posts; the order shows Changed in BC and `invoice_state` returns to `none`. (Task 5 test)
- **Crash after BC posted, before Nexus saved:** the next run finds the posted invoice and goes to `posted` without posting again. (Task 5 test)
- **Customer link changes before the Bill.com step or its Retry** (now `needs_attention`): stays `billcom_failed` with the customer message; no Bill.com call. (Task 5 test)
- **Unsaved edits in the form when the button is clicked:** the button is disabled while the form differs from the saved order. (Task 8 test)

---

### Task 1: Discovery on TEST BC and the Bill.com sandbox (controller task, with the user)

Not delegated: it posts a test order in TEST BC (irreversible) and writes to the Bill.com sandbox. **Ask the user for a go-ahead before the posting step.**

**Files:**
- Create: `docs/superpowers/notes/2026-11-15-invoice-discovery.md`

- [ ] **Step 1:** With read-only scripts (scratchpad, like `snapcheck.mjs`), record:
  - how to find a sales order's API v2 `salesOrders` id by number
  - the bound action URL `…/salesOrders({id})/Microsoft.NAV.shipAndInvoice`
  - which `salesInvoices` fields hold the order number, External Document No., due date and totals (`orderNumber`, `externalDocumentNumber`, `dueDate`, `totalAmountExcludingTax`, `totalTaxAmount`, `totalAmountIncludingTax`)
  - that `Document_Date` and `Posting_Date` are writable on page 42 `SalesOrder`
- [ ] **Step 2 (user go-ahead):** On one test order, set the dates and post. Confirm that BC deletes the order, and that `salesInvoices?$filter=orderNumber eq '<no>'` finds the posted invoice.
- [ ] **Step 3:** In the Bill.com sandbox (O1, O3), record:
  - whether `POST /v3/invoices` accepts a PO field
  - whether it has a sales-tax field
  - whether a duplicate `invoiceNumber` is rejected
  - that `sendEmail: false` sends nothing
  - the new invoice's status
  - how to list invoices by customer and invoice number
- [ ] **Step 4:** If Bill.com has **no PO field, stop and ask the user** where the Customer PO goes. Record the answer.
- [ ] **Step 5:** Commit the notes (`git add docs/superpowers/notes/2026-11-15-invoice-discovery.md`). Tasks 3–4 use the field names recorded here.

### Task 2: Migration 064, types, and invoice rules

**Files:**
- Create: `nexus/supabase/migrations/064_sales_order_invoicing.sql`
- Modify: `nexus/src/types/salesOrders.ts`, `nexus/src/lib/salesOrders/orderRules.ts`
- Test: `nexus/src/lib/salesOrders/orderRules.test.ts`

**Interfaces:**
- Produces:
  - `type InvoiceState = 'none' | 'posting' | 'post_failed' | 'posted' | 'billcom_sending' | 'billcom_failed' | 'done'` and `INVOICE_STATES`
  - new `SalesOrderRow` fields: `invoice_state`, `invoice_error`, `bc_posted_invoice_id`, `bc_posted_invoice_number`, `posted_at`, `invoice_date`, `invoice_due_date`, `posted_total_excl_tax`, `posted_total_tax`, `posted_total_incl_tax`, `billcom_invoice_id`, `billcom_invoiced_at`, `invoice_started_by`
  - `isPastPosting(state: InvoiceState): boolean`
  - `canStartInvoice(o: Pick<SalesOrderRow,'status'|'sync_state'|'invoice_state'|'bc_order_number'>): boolean`
  - `invoiceBlockReason(link: { status: string; billcom_customer_id: string | null } | null, billcomOn: boolean): string | null` (null = ready; exact copy in Global Constraints)

- [ ] **Step 1:** Write the migration: the columns from spec "Data (migration 064)", `invoice_state text not null default 'none'` with a check on the seven states, and index `sales_orders_invoice_state_idx (organization_id, bc_connection_id, invoice_state)`. Make it re-runnable with `add column if not exists` and a guarded constraint. **The user applies it.**
- [ ] **Step 2: Write the failing tests:**
  - `isPastPosting` is true only for posted, billcom_sending, billcom_failed and done
  - `canStartInvoice` is true for final/pulled + synced + none + a number; false for draft, pending, conflict, a missing number, and any other invoice state
  - `invoiceBlockReason` returns each exact message (null link, pending, needs_attention, failed, Bill.com off) and returns null for synced with an id
  - `canChangeStatus('final','invoiced')` stays false (hand changes)
- [ ] **Step 3:** Run `npx vitest run src/lib/salesOrders/orderRules.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement in `orderRules.ts` and the types. Change the `canChangeStatus` doc comment to "shipped/invoiced are set by the invoice process only".
- [ ] **Step 5:** Run the test. Expected: PASS. Run `npx tsc --noEmit -p .`. Expected: clean.
- [ ] **Step 6:** Commit the three source files, the test and the migration.

### Task 3: BC posting adapter

**Files:**
- Modify: `nexus/src/lib/businessCentral/client.ts` (add `invokeAction`)
- Create: `nexus/src/lib/salesOrders/bcInvoicing.ts`
- Test: `nexus/src/lib/salesOrders/bcInvoicing.test.ts`, `nexus/src/lib/businessCentral/client.test.ts`

**Interfaces:**
- Consumes: `OrderSyncDeps` (`transport`), the Task 1 notes.
- Produces:
  - `BcClient.invokeAction(path: string): Promise<void>` (POST, no body, 204 expected; errors as the client's existing BC errors)
  - `interface PostedInvoice { id: string; number: string; invoiceDate: string; dueDate: string | null; totalExclTax: number; totalTax: number; totalInclTax: number }`
  - `interface BcInvoicingDeps extends OrderSyncDeps { invokeAction(path: string): Promise<void> }`
  - `findPostedInvoice(deps, q: { orderNumber: string; externalDocumentNumber: string; customerNumber: string }): Promise<PostedInvoice | null>`: by order number first, then by External Document No. + customer
  - `setInvoiceDates(deps, bcOrderNumber: string, today: string): Promise<void>`: fresh GET for the etag, then PATCH `Document_Date` and `Posting_Date`
  - `postShipAndInvoice(deps, bcOrderNumber: string): Promise<void>`: resolve the `salesOrders` id, then invoke the action

- [ ] **Step 1: Write the failing tests** against a fake transport:
  - `findPostedInvoice` returns the mapped invoice from the order-number filter; falls back to External Document No. + customer; returns null when neither matches
  - `setInvoiceDates` PATCHes both dates with the etag from a fresh GET
  - `postShipAndInvoice` calls `invokeAction` with `/salesOrders(<id>)/Microsoft.NAV.shipAndInvoice` for the id looked up by number
  - BC errors propagate
- [ ] **Step 2:** Run `npx vitest run src/lib/salesOrders/bcInvoicing.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `invokeAction` in `client.ts` (company-scoped path, reusing `request`) and `bcInvoicing.ts`. Use the field names from the Task 1 notes, and quote OData strings with the existing `quote` helper style.
- [ ] **Step 4:** Run the tests and `tsc`. Expected: PASS, clean.
- [ ] **Step 5:** Commit.

### Task 4: Bill.com invoice payload and push

**Files:**
- Create: `nexus/src/lib/billcom/invoicePayload.ts`, `nexus/src/lib/billcom/invoicePush.ts`
- Test: `nexus/src/lib/billcom/invoicePayload.test.ts`, `nexus/src/lib/billcom/invoicePush.test.ts`

**Interfaces:**
- Consumes: `effectivePrice`, `effectiveDiscount` (`lineAmounts.ts`), `PostedInvoice` (Task 3), the Task 1 notes (PO and tax fields).
- Produces:
  - `buildBillcomInvoice(input: { billcomCustomerId: string; invoiceNumber: string; customerPo: string; posted: PostedInvoice; lines: LineDraft[] }): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string }`: error text `Bill.com total $X doesn't match BC's posted total $Y.` when they differ. `lines` are the stored `sales_order_lines` mapped to `LineDraft` the way the form maps them, so `effectivePrice` and `effectiveDiscount` apply.
  - `findBillcomInvoice(client: BillcomClient, customerId: string, invoiceNumber: string): Promise<string | null>` (Bill.com invoice id)
  - `createBillcomInvoice(client: BillcomClient, payload: Record<string, unknown>): Promise<string>`

- [ ] **Step 1: Write the failing tests:**
  - lines use price after discount (10 × 12.50 at 10% → unit 11.25, amount 112.50)
  - tax goes in the sales-tax field or a `Sales tax` line, per the notes
  - `sendEmail` is false
  - invoiceDate and dueDate come from `posted`
  - PO is placed per the notes
  - totals mismatch → `ok: false` with the exact message
  - matching totals at cent level → `ok: true`
  - `findBillcomInvoice` returns the id when one exists, else null
  - `createBillcomInvoice` POSTs `/v3/invoices` and returns the id
  - a Bill.com error propagates
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, following `customerPayload.ts` / `customerPush.ts` style.
- [ ] **Step 4:** Run the tests and `tsc`. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 5: Invoice process state machine

**Files:**
- Create: `nexus/src/lib/salesOrders/invoiceProcess.ts`
- Test: `nexus/src/lib/salesOrders/invoiceProcess.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4; `withOrderClaim` (`orderClaim.ts`); `bcChangedOutsideNexus` + `snapshotOf` (`bcOrderMapping.ts`); `todayIn`.
- Produces:
  - `interface InvoiceDeps extends BcInvoicingDeps { billcom: BillcomClient | null; timeZone: string | null; userId?: string }` (`billcom` null = Bill.com off)
  - `startInvoiceProcess(deps, orderId): Promise<{ ok: true } | { ok: false; error: string }>`: under the lease, checks `canStartInvoice` and the customer link, then sets `posting` + `invoice_started_by`
  - `runInvoiceProcess(deps, orderId): Promise<InvoiceState | null>`: claims the lease (null if held), then runs steps until `post_failed`, `billcom_failed`, `done`, or `none` (a conflict)
  - `retryInvoiceProcess(deps, orderId)`: `post_failed` → `posting`, `billcom_failed` → `billcom_sending`, then run

Step semantics are in the spec ("Step 1: posting", "Step 2: Bill.com"). On reaching `posted`, set `status = 'invoiced'` together with the posted fields in one update. In `billcom_sending`, re-read the customer link first, and if it isn't ready, set `billcom_failed` with the `invoiceBlockReason` text.

- [ ] **Step 1: Write the failing tests** with fake deps, one per transition:
  - happy path `none` → `done`, with dates set, posted once, the Bill.com invoice created once, status invoiced, and the posted fields stored
  - posted invoice already exists → skips posting
  - BC conflict → `none`, sync_state conflict, `Changed in BC`, no post
  - post refused → `post_failed` with BC's message, status unchanged
  - Bill.com down → `billcom_failed`, status invoiced
  - Bill.com invoice already exists → `done` without create
  - link now `needs_attention` → `billcom_failed` with the exact message, no Bill.com call
  - totals mismatch → `billcom_failed` with the mismatch message
  - lease held → `runInvoiceProcess` returns null and changes nothing; a second `startInvoiceProcess` while `posting` returns an error
  - retry from each failed state resumes the right step
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `tsc`. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 6: Keep invoiced orders out of order sync; sweep resumes stuck steps

**Files:**
- Modify: `nexus/src/lib/salesOrders/orderSync.ts`, `nexus/src/lib/salesOrders/orderClaim.ts`, `nexus/src/app/actions/salesOrders.ts`
- Test: `nexus/src/lib/salesOrders/orderClaim.test.ts`, `nexus/src/lib/salesOrders/orderSync.test.ts`, `nexus/src/app/actions/salesOrders.test.ts`

**Interfaces:**
- Consumes: `isPastPosting`, `runInvoiceProcess`.
- Produces: `sweepInvoiceSteps(deps: InvoiceDeps, limit = SWEEP_BATCH): Promise<number>`. It picks orders in `posting` or `billcom_sending` whose lease is free, and runs each.

- [ ] **Step 1: Write the failing tests:**
  - `syncSalesOrder` on a past-posting order makes no BC call
  - `sweepPendingOrders` skips `invoice_state` other than none
  - `saveSalesOrder`, `retrySalesOrderSync`, `overwriteBcWithNexus` and `deleteSalesOrder` refuse a past-posting order with `This order is invoiced and can't be changed.`
  - `sweepInvoiceSteps` resumes a stuck `billcom_sending`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the exclusions and `sweepInvoiceSteps`. Call it from the same place the list page triggers `sweepPendingOrders`.
- [ ] **Step 4:** Run the sales-order tests. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 7: Server actions and readiness

**Files:**
- Create: `nexus/src/app/actions/salesOrderInvoicing.ts`
- Modify: `nexus/src/app/(protected)/sales-orders/[id]/page.tsx`
- Test: `nexus/src/app/actions/salesOrderInvoicing.test.ts`

**Interfaces:**
- Consumes: `startInvoiceProcess`, `runInvoiceProcess`, `retryInvoiceProcess`, `resolveBillcomConnection`, `createBillcomClientForConnection`, `editScope`, `buildDeps`-style setup.
- Produces:
  - `createInvoice(orderId: string): Promise<{ ok: true } | Fail>`: start, then run in `after()`
  - `retryInvoice(orderId: string): Promise<{ ok: true } | Fail>`
  - `resumeInvoiceIfStuck(orderId: string): Promise<void>` (no-op unless `posting`/`billcom_sending` with a free lease)
  - `getInvoiceReadiness(customerNumber: string): Promise<{ blockedReason: string | null }>`
  - each calls `revalidatePath('/sales-orders','layout')` after the step, as order saves do

- [ ] **Step 1: Write the failing tests:**
  - without permission → `NO_PERMISSION`
  - a blocked customer → the exact reason, and nothing starts
  - ok → `startInvoiceProcess` called and the run scheduled in `after()`
  - retry routes to `retryInvoiceProcess`
  - readiness reflects link status and Bill.com off
  - **resume on open:** loading an order in `posting` or `billcom_sending` with a free lease schedules `runInvoiceProcess` in `after()` (spec: "Resuming a stopped process")
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `resumeInvoiceIfStuck(orderId)`, called from the order page load. Pass `getInvoiceReadiness(order.customer_number)` from the page to the form as `invoiceBlockedReason`.
- [ ] **Step 4:** Run the tests and `tsc`. Expected: PASS.
- [ ] **Step 5:** Commit.

### Task 8: Order page and list UI

**Files:**
- Create: `nexus/src/components/salesOrders/InvoiceControls.tsx`
- Modify: `nexus/src/components/salesOrders/SalesOrderForm.tsx`, `nexus/src/components/salesOrders/SyncBadge.tsx`, `nexus/src/components/salesOrders/SalesOrdersList.tsx`
- Test: `nexus/src/components/salesOrders/InvoiceControls.test.tsx`, `nexus/src/components/salesOrders/SalesOrderForm.test.tsx`, `nexus/src/components/salesOrders/SalesOrdersList.test.tsx`

**Interfaces:**
- Consumes: `createInvoice`, `retryInvoice`, `canStartInvoice`, `isPastPosting`, the `invoiceBlockedReason` prop, `GlassButton`.

- [ ] **Step 1: Write the failing tests:**
  - **The button:**
    - Create invoice (a `blue-glass` GlassButton) shows for final/pulled, synced, none
    - it's disabled with the reason as its title and a visible hint when `invoiceBlockedReason` is set
    - it's disabled while the form has unsaved edits
    - it's hidden for draft and without permission
  - **The confirm box:**
    - text is `Create invoice for <no>?` with the customer, total, Invoice # and `Invoice date today (<Mon D>)`, plus `This posts the order in BC. It can't be undone.`
    - Cancel calls nothing; Create invoice calls `createInvoice(order.id)`
  - **The status line:**
    - shows the four copy strings for posting/billcom_sending, post_failed (with BC's message and Retry), billcom_failed (Retry), and done
    - past posting hides Save and Delete
    - View invoice links to `/receivables/invoices?q=<bc_posted_invoice_number>`
  - **The list:** shows Invoiced status and the state text
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Make the Receivables invoices page read `?q=` into its existing search box. Match the header layout (status line above the buttons; same header height).
- [ ] **Step 4:** Run all tests, `tsc`, lint and `npm run build`. Expected: all pass. Load `/sales-orders/<id>` against the dev server (memory: build passing ≠ app runs).
- [ ] **Step 5:** Commit.

### Task 9: Live check on TEST and the Bill.com sandbox, and the backlog (controller task)

- [ ] **Step 1:** With the user's go-ahead, invoice one test order end to end from the browser. Compare:
  - BC (posted invoice, dates, totals)
  - Nexus (state `done`, Invoiced, View invoice)
  - Bill.com sandbox (number, lines, tax, total, PO, no email sent)
- [ ] **Step 2:** Force a Bill.com failure (turn the sandbox connection off) on a second test order. Confirm `Invoiced · Not in Bill.com`, then Retry after turning it back on.
- [ ] **Step 3:** Update `BACKLOG.md` #5 project 2: what was built, migration 064 in the go-live list, the go-live steps from the spec, and leftovers. Commit `BACKLOG.md`.
