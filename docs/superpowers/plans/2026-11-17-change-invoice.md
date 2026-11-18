# Change Invoice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reps can change the quantities, prices and lines of an unpaid invoice that Nexus created. Nexus cancels the old BC invoice, posts a corrected one with the same Invoice #, replaces the lines on the same Bill.com invoice, and logs who, when and why.

**Architecture:** A new `sales_invoice_changes` table holds one record per change, with its own state machine run under the order's lease, like Create invoice. BC work runs through the published Sales Invoice OData page (draft), the API v2 `post` and `cancel` bound actions, and API v2 reads. Bill.com work uses `PUT /v3/invoices/{id}`. The UI reuses the sales order's lines table in a "change mode", and the invoice page gains a history card.

**Tech Stack:** Next.js 16 App Router (server actions, `after()`), React 19, Supabase (service client, so every query is scoped by `organization_id` + `bc_connection_id`), Vitest + jsdom, BC OData + API v2, Bill.com v3.

**Spec:** `docs/superpowers/specs/2026-11-17-change-invoice-design.md`

## Global Constraints

- TEST BC and the Bill.com sandbox only. **BC `cancel` can't be undone: it's never run live without the user's explicit go-ahead in chat** (proposed target INV-100411).
- Stage specific paths only. Never `git add -A`, and never stage `droid-telegram-bot`. No push or merge without consent.
- Migration `nexus/supabase/migrations/066_sales_invoice_changes.sql`: the user applies it. Code must not depend on it until they say it's applied.
- Change is allowed only when `sales_orders.invoice_state = 'done'`, under the same permission as Create invoice (`editScope`).
- Unpaid only. Bill.com must read `OPEN` with `dueAmount === totalAmount`. The check is re-run on the server at submit. If Bill.com is off, the check is skipped.
- The corrected invoice keeps the **old invoice date and due date**, with no fallback to today. If BC refuses, the state is `post_failed` with BC's message.
- Lines that weren't touched keep their invoiced price and discount. A changed or added line must have a unit price.
- The order's lines are written from `lines_after` only at `done`. **Discard change** is allowed only in `pending` or `cancel_failed`.
- Reason: required, trimmed, 1–1000 characters.
- Copy (exact):
  - Change-mode bar: "Changing invoice {Invoice #} — edit lines, then Save changes to invoice."
  - Buttons: "Change invoice", "Cancel changes", "Save changes to invoice", "Discard change".
  - Popup warning: "BC will cancel {old BC No.} and post a corrected invoice. This can't be undone."
  - Popup note: "BC recalculates tax".
  - Status text: "Changing invoice…".
  - Disabled reasons:
    - "Paid or partly paid in Bill.com — can't change"
    - "Void in Bill.com"
    - "Couldn't reach Bill.com — try again"
    - "Not found in Bill.com — can't check payment"
  - Invoice page: card title "Changes"; cancelled banner "Cancelled — replaced by {new BC No.}".
- Next.js memoizes identical reads within one render, so a write returns its stored rows and is never read back in the same render.
- Tests: Vitest. Component tests need `import '@testing-library/jest-dom/vitest'` and `afterEach(cleanup)`.

## Review Focus

1. **Double submit** (double click, or two tabs) must give exactly one change; the second gets "This order is busy" or "A change is already open". Pinned by the Task 6 test `second start is refused`.
2. **Cancel times out but BC did cancel.** Retry must re-read the status and move on without a second cancel. Pinned by the Task 6 test `cancel outcome unknown, BC shows Canceled`.
3. **Crash after the post, before it's recorded.** Retry must find the posted replacement (not the old invoice, not cancelled) and never post twice. Pinned by the Task 6 test `posted replacement already in BC`.
4. **A new line with no price, quantity 0, or no real change** must be rejected with a clear message before anything reaches BC. Pinned by Task 3's `changeLinesFromDrafts` and `validateChange` tests.
5. **A change stuck mid-step after a server restart** must resume, either when the order page opens or from the list sweep. Pinned by Task 7's `resumeInvoiceChangeIfStuck` test.

---

### Task 1: Discovery in TEST BC and the Bill.com sandbox (controller task, nothing irreversible)

**Files:**
- Create: `docs/superpowers/notes/2026-11-17-change-invoice-discovery.md`
- Scratch scripts in the session scratchpad (not committed)

No BC cancel and no BC post in this task.

- [ ] **Step 1: Find out whether BC page 43 (Sales Invoice) is published.** In TEST BC, GET `…/ODataV4/Company('…')/SalesInvoice?$top=1` and `SalesInvoiceSalesLines?$top=1`.
  Expected: 200 on both. On 404, ask the user to publish page 43 in BC Web Services as `SalesInvoice`, the way `SalesOrder` is published. The lines subpage then appears as `SalesInvoiceSalesLines`. Wait for them. **Production needs the same publish:** add it to the BACKLOG #1 go-live list.
- [ ] **Step 2: Create a draft and delete it.**
  1. Create a draft invoice through `SalesInvoice` for W-100528's customer.
  2. Patch it with the `toBcHeaderPatch` fields (from the Nexus order), plus `Posting_Date`, `Document_Date` and `Due_Date` = INV-100411's dates.
  3. Write the ship-to through `salesDocuments`.
  4. Add one line through `SalesInvoiceSalesLines` with `Unit_Price` and `Line_Discount_Percent`.
  5. Read it back through API v2 `salesInvoices?$filter=number eq '<draft No>'`, recording `id`, `status` and `totalAmountExcludingTax`.
  6. DELETE the draft.

  Record which fields page 43 refused, if any. A refused field goes through `salesDocuments` instead. Also record whether `Due_Date` sticks after `Document_Date` is patched (order matters).
  Expected: the draft is created, read and deleted. Leaving it behind is harmless, but delete it anyway.
- [ ] **Step 3: Replace an invoice in the Bill.com sandbox.**
  1. Create the test invoice `NX-CHG-1` (2 lines).
  2. `PUT /v3/invoices/{id}` with a body of 2 lines: one changed, one new, and the second original line left out.
  3. GET it back.

  Record: which fields PUT requires (whether `customer`, `invoiceNumber` and `invoiceDate` must be repeated), whether lines left out are removed, whether line `id`s are needed, and the response shape.
  Expected: Bill.com ends with exactly the PUT's lines and total.
- [ ] **Step 4: Write the notes file** with the measured calls, bodies and the Step 1 publish result. Include the exact constants Tasks 4 and 5 use: `SALES_INVOICE_SOURCE`, `SALES_INVOICE_LINE_SOURCE` and the PUT body.
- [ ] **Step 5: Commit.**
```bash
git add docs/superpowers/notes/2026-11-17-change-invoice-discovery.md BACKLOG.md
git commit -m "docs(invoicing): change-invoice discovery (BC draft invoice, Bill.com replace)"
```
If page 43 can't be published or refuses the tax, location or posting fields, stop and bring it to the user. The spec's fallback is API v2 `salesInvoices` with a header patch through `salesDocuments`.

### Task 2: Migration, types, and the `changing` order state

**Files:**
- Create: `nexus/supabase/migrations/066_sales_invoice_changes.sql`
- Create: `nexus/src/types/invoiceChanges.ts`
- Modify: `nexus/src/types/salesOrders.ts` (INVOICE_STATES)
- Modify: `nexus/src/lib/salesOrders/orderRules.ts` (`isPastPosting`)
- Modify: `nexus/src/components/salesOrders/InvoiceControls.tsx` (`invoiceStatusText`)
- Test: `nexus/src/lib/salesOrders/orderRules.test.ts`, `nexus/src/components/salesOrders/InvoiceControls.test.tsx`

**Interfaces:**
- Produces:
  - `CHANGE_STATES = ['pending','cancelling','cancel_failed','cancelled','posting','post_failed','posted','billcom_updating','billcom_failed','done','discarded'] as const`
  - `type ChangeState`
  - `RESUMABLE_CHANGE_STATES: readonly ChangeState[] = ['pending','cancelling','cancelled','posting','posted','billcom_updating']`
  - `DISCARDABLE_CHANGE_STATES = ['pending','cancel_failed']`
  - `interface ChangeLine { item_number: string; description: string; unit_of_measure_code: string; quantity: number; unit_price: number; discount_percent: number }`
  - `interface InvoiceChangeRow`, with the columns below (numerics as `number | null`, jsonb lines as `ChangeLine[]`)
  - `InvoiceState` gains `'changing'`

- [ ] **Step 1: Write the failing tests.**
  - `isPastPosting('changing') === true`, so the order stays locked and normal saves are refused through `invoiceLock`.
  - `invoiceStatusText('changing') === 'Changing invoice…'`.
- [ ] **Step 2: Run them and watch them fail.** Run `cd nexus && npx vitest run src/lib/salesOrders/orderRules.test.ts src/components/salesOrders/InvoiceControls.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement the types and rules. Write the migration:**
  - `sales_invoice_changes`:
    - Keys: `id uuid pk default gen_random_uuid()`; `organization_id`, `bc_connection_id` and `sales_order_id`, each a cascading FK, as on `sales_order_notes`.
    - `state text not null default 'pending'`, checked against CHANGE_STATES.
    - `error text`; `reason text not null check (char_length(btrim(reason)) between 1 and 1000)`.
    - `changed_by uuid`; `changed_by_name text not null default ''`.
    - `created_at timestamptz not null default now()`; `updated_at timestamptz not null default now()`; `finished_at timestamptz`.
    - Old invoice: `old_bc_invoice_id text not null`, `old_bc_invoice_number text not null`, `old_total numeric`.
    - BC work: `cancelled_at timestamptz`, `draft_bc_invoice_id text`.
    - New invoice: `new_bc_invoice_id text`, `new_bc_invoice_number text`, `new_total numeric`.
    - Lines: `lines_before jsonb not null`, `lines_after jsonb not null`.
  - Index on `(organization_id, bc_connection_id, sales_order_id, created_at)`.
  - Partial unique index on `(sales_order_id) where state not in ('done','discarded')`.
  - Index on `(organization_id, bc_connection_id, old_bc_invoice_id)`.
  - RLS: enable it, with a select policy matching `sales_order_notes`. Writes go through the service client.
  - `sales_orders_invoice_state_check`: drop it and re-add it with `'changing'` added.
- [ ] **Step 4: Run the tests and the type check.** Run `npx vitest run <same files> && npx tsc --noEmit`. Expected: PASS, with no type errors. Fix every switch or Record over `InvoiceState` that tsc flags, for example the `DOT`/`TEXT` maps: `changing` uses the sky dot and muted text.
- [ ] **Step 5: Ask the user to apply 066, then commit.**
```bash
git add nexus/supabase/migrations/066_sales_invoice_changes.sql nexus/src/types/invoiceChanges.ts nexus/src/types/salesOrders.ts nexus/src/lib/salesOrders/orderRules.ts nexus/src/lib/salesOrders/orderRules.test.ts nexus/src/components/salesOrders/InvoiceControls.tsx nexus/src/components/salesOrders/InvoiceControls.test.tsx
git commit -m "feat(invoicing): invoice change records and the changing order state"
```

### Task 3: Change lines: build, validate, compare (pure)

**Files:**
- Create: `nexus/src/lib/salesOrders/invoiceChangeLines.ts`
- Test: `nexus/src/lib/salesOrders/invoiceChangeLines.test.ts`

**Interfaces:**
- Consumes: `ChangeLine` (Task 2); `effectivePrice` and `effectiveDiscount` from `lineAmounts.ts`.
- Produces:
  - `toChangeLines(rows: SalesOrderLineRow[]): ChangeLine[]`: drops `removed`, sorts by `position`, and resolves price and discount through `effectivePrice` and `effectiveDiscount`. This is the invoiced price.
  - `changeLinesFromDrafts(drafts: LineDraft[], rows: SalesOrderLineRow[]): { ok: true; lines: ChangeLine[] } | { ok: false; error: string }`
  - `validateChange(before: ChangeLine[], after: ChangeLine[], reason: string): string | null`
  - `sameLines(a: ChangeLine[], b: ChangeLine[]): boolean`
  - `changeSubtotalCents(lines: ChangeLine[]): number`: the sum of `cents(round2(qty * price * (1 - disc/100)))`.
  - `toInvoiceSourceLines(lines: ChangeLine[]): InvoiceSourceLine[]`: `unit_price` and `discount_percent` set, BC fields null.

- [ ] **Step 1: Write the failing tests.**
  - `toChangeLines`:
    - Uses `bc_unit_price` 4.5 when `unit_price` is null.
    - Uses `bc_line_discount_percent` 10 when `discount_percent` is null.
    - Drops a `removed` row.
    - Orders by position.
  - `changeLinesFromDrafts`:
    - A draft whose `id` matches a row and whose `unit_price` is still null takes that row's invoiced price.
    - A draft with no `id` and a null `unit_price` gives `{ ok: false, error: 'Enter a unit price for ING-10.' }`.
    - Quantity 0 gives `'Quantity must be more than 0 for ING-10.'`.
    - A discount of 101 gives `'Discount must be between 0 and 100 for ING-10.'`.
  - `validateChange`:
    - A blank or whitespace reason gives `'Enter a reason for the change.'`.
    - A 1001-character reason gives `'Keep the reason under 1000 characters.'`.
    - `after` empty gives `'An invoice needs at least one line.'`.
    - `sameLines(before, after)` gives `'Nothing changed.'`.
    - Otherwise null.
  - `changeSubtotalCents([{qty 3, price 1.0925, disc 0}])` → 328.
  - `sameLines` ignores description whitespace but not price differences of 0.01.
- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run src/lib/salesOrders/invoiceChangeLines.test.ts`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement** `nexus/src/lib/salesOrders/invoiceChangeLines.ts`.
- [ ] **Step 4: Run the tests.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add nexus/src/lib/salesOrders/invoiceChangeLines.ts nexus/src/lib/salesOrders/invoiceChangeLines.test.ts
git commit -m "feat(invoicing): build and validate invoice change lines"
```

### Task 4: BC side: read, cancel, draft, post

**Files:**
- Create: `nexus/src/lib/salesOrders/bcInvoiceChange.ts`
- Test: `nexus/src/lib/salesOrders/bcInvoiceChange.test.ts`
- Modify: `nexus/src/lib/salesOrders/bcOrderMapping.ts`. Export the header-field part of `toBcHeaderPatch` as `toBcTaxAndAddressFields(order)` so the draft and the order share it. `toBcHeaderPatch` keeps its output byte-for-byte; its existing tests prove that.

**Interfaces:**
- Consumes:
  - `BcInvoicingDeps`, `PostedInvoice`, `BcPostRefusedError` and `BcPostOutcomeUnknownError` from `bcInvoicing.ts`
  - `SALES_DOCUMENT_SOURCE`, `toSalesDocShipToAddress`
  - `ChangeLine`; `changeSubtotalCents` (Task 3)
  - The constants recorded in Task 1's notes
- Produces:
  - `SALES_INVOICE_SOURCE` and `SALES_INVOICE_LINE_SOURCE`: the OData sources, values from Task 1.
  - `interface BcInvoiceState extends PostedInvoice { status: string }`: BC's `status` string, for example `'Open'`, `'Paid'` or `'Canceled'`.
  - `readBcInvoice(deps, id: string): Promise<BcInvoiceState | null>`: an API v2 `salesInvoices` filter `id eq <guid>`, unquoted.
  - `cancelBcInvoice(deps, id: string): Promise<void>`: invokes `/salesInvoices(<id>)/Microsoft.NAV.cancel`. Maps a 4xx to `BcPostRefusedError` and anything else to `BcPostOutcomeUnknownError`, the same mapping as `postShipAndInvoice`; extract the shared mapper.
  - `findReplacementInvoice(deps, q: { externalDocumentNumber: string; customerNumber: string; excludeId: string }): Promise<PostedInvoice | null>`: posted only, not `excludeId`, status not `Canceled`. An unposted draft never counts.
  - `interface DraftInvoice { no: string; id: string }`, where `id` is the API v2 / SystemId.
  - `findDraftInvoice(deps, q: { draftId: string | null; externalDocumentNumber: string; customerNumber: string }): Promise<DraftInvoice | null>`
  - `createDraftInvoice(deps, order: SalesOrderRow, old: PostedInvoice): Promise<DraftInvoice>`: create, then the ship-to through `salesDocuments`, then the header fields, then the dates (in the order Task 1 measured).
  - `setDraftLines(deps, draft: DraftInvoice, lines: ChangeLine[], locationCode: string): Promise<void>`: deletes the draft's existing lines first, so it's safe to re-run.
  - `checkDraft(deps, draft: DraftInvoice, lines: ChangeLine[]): Promise<string | null>`: returns a mismatch message or null. It compares the line count and `totalAmountExcludingTax` cents with `changeSubtotalCents`.
  - `postDraftInvoice(deps, draft: DraftInvoice): Promise<void>`: `/salesInvoices(<id>)/Microsoft.NAV.post`, with the same error mapping.

- [ ] **Step 1: Write the failing tests.** Use a fake `ReferenceTransport` plus an `invokeAction` spy, in the style of `bcInvoicing.test.ts`.
  - `readBcInvoice`: returns status and totals, or null when the list is empty.
  - `cancelBcInvoice`:
    - Calls exactly `/salesInvoices(143fbb46-e8e0-f111-84e4-7ced8d88ddac)/Microsoft.NAV.cancel`.
    - A 400 becomes `BcPostRefusedError` carrying BC's message.
    - A 504 becomes `BcPostOutcomeUnknownError`.
  - `findReplacementInvoice` ignores:
    - the excluded id,
    - a `Canceled` invoice,
    - a `Draft`.

    It returns the open one.
  - `findDraftInvoice`: prefers `draftId`, otherwise falls back to matching the Invoice # and customer among drafts.
  - `setDraftLines`: removes 2 existing lines, then creates the new ones with `Unit_Price`, `Line_Discount_Percent`, `Location_Code` and `Unit_of_Measure_Code` (when not blank).
  - `checkDraft`:
    - Returns null when it matches.
    - Returns `"BC's draft has 2 lines totalling $5.00, expected 3 lines totalling $6.28."` on a mismatch.
  - `createDraftInvoice`: sends `Posting_Date`, `Document_Date` and `Due_Date` = `old.invoiceDate` / `old.dueDate`, and the tax area and location from the order.
- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run src/lib/salesOrders/bcInvoiceChange.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Refactor `toBcHeaderPatch` to use `toBcTaxAndAddressFields`.
- [ ] **Step 4: Run the tests.** Run `npx vitest run src/lib/salesOrders/bcInvoiceChange.test.ts src/lib/salesOrders/bcOrderMapping.test.ts src/lib/salesOrders/bcInvoicing.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add nexus/src/lib/salesOrders/bcInvoiceChange.ts nexus/src/lib/salesOrders/bcInvoiceChange.test.ts nexus/src/lib/salesOrders/bcOrderMapping.ts nexus/src/lib/salesOrders/bcInvoicing.ts
git commit -m "feat(invoicing): BC cancel, draft and post for corrected invoices"
```

### Task 5: Bill.com: replace an invoice, shared find-or-create, change eligibility

**Files:**
- Modify: `nexus/src/lib/billcom/invoicePush.ts`, `nexus/src/lib/salesOrders/invoiceProcess.ts` (its billcom step uses the shared function)
- Create: `nexus/src/lib/billcom/invoiceChangeCheck.ts`
- Test: `nexus/src/lib/billcom/invoicePush.test.ts`, `nexus/src/lib/billcom/invoiceChangeCheck.test.ts`; the existing `invoiceProcess.test.ts` must stay green.

**Interfaces:**
- Produces:
  - `replaceBillcomInvoice(client, id: string, payload: Record<string, unknown>): Promise<BillcomInvoiceSummary>`: a `PUT /v3/invoices/<id>`, with the body shape from Task 1.
  - `findOrCreateBillcomInvoice(client, customerId: string, payload): Promise<BillcomInvoiceSummary>`: find by number, else create; on a duplicate, find again. This is the logic lifted out of `invoiceProcess.billcomStep`.
  - `changeBlockedReason(found: BillcomInvoiceStatus | 'ambiguous' | null | Error, ctx: { billcomOn: boolean; hasBillcomInvoice: boolean }): string | null`

- [ ] **Step 1: Write the failing tests.**
  - `replaceBillcomInvoice`: sends PUT with a JSON body to `/v3/invoices/00eX` and returns the summary (total and line count).
  - `findOrCreateBillcomInvoice`:
    - Returns the found invoice without a create.
    - Creates when none is found.
    - On `BillcomDuplicateInvoiceError`, finds again.
  - `changeBlockedReason`:
    - Bill.com off → null.
    - `{status:'OPEN', dueAmount:10, totalAmount:10}` → null.
    - `dueAmount` 4 of 10 → `"Paid or partly paid in Bill.com — can't change"`.
    - `PAID_IN_FULL` → the same message.
    - `VOID` → `'Void in Bill.com'`.
    - An Error → `"Couldn't reach Bill.com — try again"`.
    - null with `hasBillcomInvoice` true → `"Not found in Bill.com — can't check payment"`.
    - null with `hasBillcomInvoice` false → null (Bill.com is created during the change).
- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run src/lib/billcom/invoicePush.test.ts src/lib/billcom/invoiceChangeCheck.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Switch `invoiceProcess.billcomStep` to `findOrCreateBillcomInvoice`, keeping its behavior.
- [ ] **Step 4: Run the tests.** Run `npx vitest run src/lib/billcom src/lib/salesOrders/invoiceProcess.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add nexus/src/lib/billcom/invoicePush.ts nexus/src/lib/billcom/invoicePush.test.ts nexus/src/lib/billcom/invoiceChangeCheck.ts nexus/src/lib/billcom/invoiceChangeCheck.test.ts nexus/src/lib/salesOrders/invoiceProcess.ts
git commit -m "feat(billcom): replace an invoice; change eligibility from Bill.com status"
```

### Task 6: The change process (state machine)

**Files:**
- Create: `nexus/src/lib/salesOrders/invoiceChangeProcess.ts`
- Test: `nexus/src/lib/salesOrders/invoiceChangeProcess.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 2–5
  - `InvoiceDeps` (it has `transport`, `invokeAction`, `billcom`, `billcomConnectionId`, `supabase`, `orgId`, `connectionId`, `now`, `mirrorPostedInvoice`)
  - `withOrderLease` and `POST_LEASE_MS`, used exactly as `invoiceProcess.ts` uses them
  - `buildBillcomInvoice`, `billcomInvoiceMismatch`
- Produces:
  - `startInvoiceChange(deps: InvoiceDeps, input: { orderId: string; reason: string; lines: ChangeLine[]; userId: string; userName: string; blockedReason: string | null }): Promise<{ ok: true; changeId: string } | { ok: false; error: string }>`. The caller passes the Bill.com check result in `blockedReason`.
  - `runInvoiceChange(deps, changeId: string): Promise<ChangeState | null>`
  - `retryInvoiceChange(deps, changeId)` and `discardInvoiceChange(deps, changeId)`: both return `Promise<{ ok: true } | { ok: false; error: string }>`.
  - `sweepInvoiceChanges(deps, limit = SWEEP_BATCH): Promise<number>`
  - `loadOpenChange(deps, orderId): Promise<InvoiceChangeRow | null>`

Rules (from the spec):
- **Every write** is a compare-and-set on `state`, scoped by org and connection, and stamps `updated_at`.
- **start**, under the order lease:
  - The order must be `invoice_state='done'` with `bc_posted_invoice_id`, else "This invoice can't be changed right now.".
  - `blockedReason` non-null → return it.
  - `validateChange` must pass.
  - Then: insert `pending` with `lines_before = toChangeLines(loadLines)`, the old id, number and total, and `lines_after`.
  - CAS the order `done → changing`. If it fails, set the record to `discarded` and return busy.
  - A unique-index violation (23505) → "A change is already open for this invoice.".
- **pending → cancelling → cancelled.**
  1. Read the old invoice. If it's `Canceled`, go to `cancelled`.
  2. If its status isn't `Open`, go to `cancel_failed` with "BC shows {old No.} as {status}; it can't be cancelled.".
  3. Otherwise call `cancelBcInvoice` under `POST_LEASE_MS`.
     - Refused → `cancel_failed` with BC's message.
     - Unknown → re-read. If it's `Canceled`, go to `cancelled`; else `cancel_failed` with "BC didn't confirm the cancel. Retry checks BC first, so it won't cancel twice.".
  4. Record `cancelled_at` and re-mirror the old invoice (best effort).
- **cancelled → posting → posted.**
  1. Call `findReplacementInvoice`. If found, record it and go to `posted`.
  2. Otherwise `findDraftInvoice`, or else `createDraftInvoice`, and save `draft_bc_invoice_id` straight away.
  3. Run `setDraftLines`, then `checkDraft`. A mismatch → `post_failed`.
  4. Run `postDraftInvoice`.
     - Refused → `post_failed` with BC's message.
     - Unknown → `findReplacementInvoice`. Found → record it; else `post_failed` with `POST_NOT_CONFIRMED`.
  5. Record `new_bc_invoice_id`, number and total, and mirror the new invoice (best effort).
- **posted → billcom_updating → done.**
  1. If Bill.com is off, go to `done`.
  2. Build with `buildBillcomInvoice({ billcomCustomerId, invoiceNumber: order.invoice_number, posted: newPosted, lines: toInvoiceSourceLines(after) })`.
  3. If the order has `billcom_invoice_id`, call `replaceBillcomInvoice`; else `findOrCreateBillcomInvoice`, and save the id on the order.
  4. A `billcomInvoiceMismatch` → `billcom_failed`.
- **done:**
  1. Replace the order's lines with `lines_after`, keeping row ids where `item_number` and `position` match; new rows for the rest; others are marked removed. The order never syncs to BC again, since its BC order is gone.
  2. Set the order's `bc_posted_invoice_id` and number to the new invoice, `invoice_state='done'`, the order `total_incl_tax` to the new total, and `invoice_error` null.
  3. Set the record's `finished_at`.
- **discard:** only in `DISCARDABLE_CHANGE_STATES`. Record → `discarded`, order `changing → done`. Anything else → "BC already cancelled {old No.}; Retry to finish the change.".

- [ ] **Step 1: Write the failing tests.** Use fakes for the Supabase table ops (stub objects, as in `invoiceProcess.test.ts`), the BC functions (`vi.mock('./bcInvoiceChange')`) and the Bill.com functions. Named tests:
  - `happy path: pending → done, BC cancel then post, Bill.com PUT, order points at the new invoice`
  - `second start is refused` (unique violation, and busy lease)
  - `blocked reason is returned and nothing is written`
  - `old invoice already Canceled skips the cancel call`
  - `cancel refused → cancel_failed with BC's message; discard returns the order to done unchanged`
  - `cancel outcome unknown, BC shows Canceled → continues to post without a second cancel`
  - `cancel outcome unknown, BC still Open → cancel_failed with the not-confirmed message`
  - `posted replacement already in BC → recorded, no draft, no post`
  - `draft saved earlier is reused, not created again`
  - `draft totals mismatch → post_failed, nothing posted`
  - `post refused (closed period) → post_failed with BC's message; discard refused after cancel`
  - `post outcome unknown and replacement found → posted`
  - `Bill.com mismatch after PUT → billcom_failed; retry re-runs only the Bill.com step`
  - `Bill.com on but no billcom_invoice_id → find-or-create, id saved on the order`
  - `Bill.com off → done without Bill.com`
  - `lost lease mid-step → stops without writing`
  - `sweepInvoiceChanges resumes resumable states whose lease is free, max SWEEP_BATCH`
- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run src/lib/salesOrders/invoiceChangeProcess.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `nexus/src/lib/salesOrders/invoiceChangeProcess.ts`.
- [ ] **Step 4: Run the tests and the whole suite.** Run `npx vitest run src/lib/salesOrders && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add nexus/src/lib/salesOrders/invoiceChangeProcess.ts nexus/src/lib/salesOrders/invoiceChangeProcess.test.ts
git commit -m "feat(invoicing): change invoice process (cancel, repost, Bill.com replace)"
```

### Task 7: Server actions, resume and sweep wiring

**Files:**
- Create: `nexus/src/app/actions/salesInvoiceChanges.ts`
- Modify:
  - `nexus/src/app/actions/salesOrders.ts`: the list sweep also calls `sweepInvoiceChanges` when any order is `changing`.
  - `nexus/src/app/(protected)/sales-orders/[id]/page.tsx`: loads the open change and its eligibility, and resumes a stuck change.
- Test: `nexus/src/app/actions/salesInvoiceChanges.test.ts`

**Interfaces:**
- Produces (`'use server'`, so no exported types; types live in `types/invoiceChanges.ts`):
  - `getInvoiceChangeState(orderId: string): Promise<{ change: InvoiceChangeRow | null; blockedReason: string | null }>`. `blockedReason` comes from the Bill.com read and `changeBlockedReason`; it's checked only when the order is `done` and no change is open.
  - `startChangeInvoice(orderId: string, drafts: LineDraft[], reason: string): Promise<{ ok: true } | Fail>`. It:
    - checks `editScope`;
    - re-reads Bill.com and builds `blockedReason` on the server;
    - runs `changeLinesFromDrafts`;
    - takes the user name from `users.display_name`;
    - calls `startInvoiceChange`, then `after()` → `runInvoiceChange`, then `revalidatePath('/sales-orders','layout')` and `revalidatePath('/receivables/invoices','layout')`.
  - `retryChangeInvoice(orderId)` and `discardChangeInvoice(orderId)`: both find the open change by order.
  - `resumeInvoiceChangeIfStuck(orderId): Promise<void>`: resumes when the open change is in a resumable state and the order lease is free. Mirrors `resumeInvoiceIfStuck`.
- [ ] **Step 1: Write the failing tests,** mocking the process module and scope as `salesOrderInvoicing.test.ts` does:
  - No permission gives `NO_PERMISSION`.
  - A server-side blocked reason is returned, and the process isn't started.
  - A draft line error is returned.
  - On success, the run is scheduled via `after`.
  - `resumeInvoiceChangeIfStuck` schedules a run only for a resumable state with an expired lease.
- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run src/app/actions/salesInvoiceChanges.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement and wire it into the order page and the list sweep.**
- [ ] **Step 4: Run the tests.** Run `npx vitest run src/app/actions && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** the three files plus the test.

### Task 8: Sales order UI: Change invoice, change mode, reason popup, Retry and Discard

**Files:**
- Create: `nexus/src/components/salesOrders/ChangeInvoiceDialog.tsx` (+ `.test.tsx`)
- Modify:
  - `nexus/src/components/salesOrders/InvoiceControls.tsx`: the Change invoice button (disabled, with the reason as a title and visible small text) next to View invoice; the status line for an open change, with Retry and Discard.
  - `nexus/src/components/salesOrders/SalesOrderForm.tsx`: a `changeMode` state.
  - The order page passes `change` and `changeBlockedReason`.
- Test: `nexus/src/components/salesOrders/ChangeInvoiceDialog.test.tsx`, `nexus/src/components/salesOrders/InvoiceControls.test.tsx`, `nexus/src/components/salesOrders/SalesOrderForm.test.tsx`

**Interfaces:**
- Consumes: Task 7 actions; `changeSubtotalCents`; `changeLinesFromDrafts` (client-side preview of errors).
- Produces:
  - `ChangeInvoiceDialog({ open, oldTotal, newSubtotal, oldBcNumber, onConfirm(reason): Promise<string | null>, onClose })`: `onConfirm` returns an error message or null.

Behavior:
- **Change mode** unlocks only the lines table: `locked={locked && !changeMode}`. Header fields stay locked. It shows the bar copy, "Cancel changes" (resets the lines) and "Save changes to invoice" (disabled while `sameLines(before, after)`).
- **While a change is open,** the lines table shows `change.lines_after`, locked, and the status line shows "Changing invoice…" or the failed step's error with Retry. Discard appears only in a discardable state.
- **The popup** has:
  - old total → new subtotal, plus the "BC recalculates tax" note;
  - the reason textarea (required, 1000-character max with a counter);
  - the warning copy;
  - Confirm (disabled until there's a reason) and Back.

  A server error shows inside the popup.
- [ ] **Step 1: Write the failing tests.**
  - Dialog:
    - Confirm stays disabled with an empty or whitespace reason.
    - The warning text names `INV-100411`.
    - An error from `onConfirm` is shown, and the dialog stays open.
  - InvoiceControls:
    - Change invoice shows only when the state is `done` and `canEdit` is true.
    - It's disabled with "Paid or partly paid in Bill.com — can't change".
    - Discard shows for `cancel_failed` and not for `post_failed`.
  - SalesOrderForm, in change mode:
    - The qty input is enabled and the customer select stays disabled.
    - Save changes to invoice is disabled until a quantity changes.
- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run src/components/salesOrders`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and lint.** Run `npx vitest run src/components/salesOrders && npx tsc --noEmit && npm run lint`. Expected: PASS and clean.
- [ ] **Step 5: Commit** these files.

### Task 9: Invoice page: Changes card and cancelled banner

**Files:**
- Modify:
  - `nexus/src/lib/receivables/salesInvoicePage.ts`: `readOrder` falls back to the change record's `old_bc_invoice_id`. Add `changes: InvoiceChangeRow[]` and `replacedBy: { id: string; number: string } | null` to `SalesInvoicePageData`.
  - `nexus/src/components/receivables/SalesInvoiceDetail.tsx`
  - `nexus/src/app/(protected)/receivables/invoices/[bcInvoiceId]/page.tsx`
- Create: `nexus/src/components/receivables/InvoiceChangesCard.tsx` (+ `.test.tsx`)
- Test: `nexus/src/lib/receivables/salesInvoicePage.test.ts`

Behavior:
- Changes for the order are listed newest first. Each shows:
  - `formatDate` + time and `changed_by_name`;
  - the reason;
  - old total → new total;
  - old BC No. → new BC No. (links to `/receivables/invoices/<id>`);
  - "Show lines", which toggles a before/after table.

  A record not `done` or `discarded` shows its state; a discarded one is labelled "Discarded".
- On an invoice that a `done` change replaced: a banner reading "Cancelled — replaced by INV-…", linking to the new invoice.
- [ ] **Step 1: Write the failing tests.**
  - The page data:
    - Finds the order by the old id.
    - Returns `replacedBy` for the old id and null for the new one.
    - Returns `changes` sorted newest first.
  - The card renders the reason, the name, `$24.62 → $30.10`, `INV-100411 → INV-100415`, and the lines toggle.
  - The detail shows the banner text exactly.
- [ ] **Step 2: Run them and watch them fail.** Run `npx vitest run src/lib/receivables src/components/receivables`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and the whole suite.** Run `npx vitest run && npx tsc --noEmit && npm run lint`. Expected: all green.
- [ ] **Step 5: Commit** these files.

### Task 10: Live test (controller task; the cancel needs the user's go-ahead)

- [ ] **Step 1: Ask the user in chat:** "OK to change INV-100411 in TEST? BC will cancel it (credit memo) and post a corrected invoice; this can't be undone." Wait for a clear yes.
- [ ] **Step 2: Run the change in the app.** On W-100528's order: Change invoice → qty +1 on one line, add one line, reason "Live test of Change invoice" → Confirm.
- [ ] **Step 3: Verify.**
  - BC: INV-100411 shows `Canceled` with a credit memo, and a new posted invoice has the same Invoice # and dates.
  - Bill.com: the same invoice id, the new lines, and a total within the rounding rule.
  - Nexus: the order shows View invoice pointing at the new invoice; the invoice page shows the Changes card; the old invoice page shows the banner.

  Record it all in the discovery notes.
- [ ] **Step 4: Commit the notes.**
