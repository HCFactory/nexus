# Sales Order Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- Fix the false "Changed in BC" flag.
- Show live line amounts and totals while typing.
- Apply the user's 19 layout changes to the sales order form.

**Architecture:**
- **Conflict check:** compares a stored snapshot of the BC values of Nexus-managed fields instead of the header etag.
- **Live money numbers:** a pure module computes them from the effective price and discount plus the tax rate. The tax rate comes from the tax tables Nexus already copies from BC.
- **Notes:** move to their own table and server actions.
- **Layout:** reorganized in `SalesOrderForm.tsx`, with the billing, ship-to and notes cards as separate components.

**Tech Stack:** Next.js 16, React 19, Supabase, Vitest + jsdom. Branch `feat/sales-orders`.

**Spec:** `docs/superpowers/specs/2026-11-14-sales-order-revisions-design.md`

## Global Constraints

- TEST BC only. Nothing new is sent to BC except External_Document_No's auto value now including the Customer PO.
- Customer PO is still never sent to BC as its own field. It only appears inside the auto invoice # value.
- Migrations are re-runnable, with RLS select-by-org (the 053 pattern). The user applies 063 manually.
- Stage specific paths only. Never `git add -A`. Never stage `droid-telegram-bot`.
- Typecheck: `cd nexus && npx tsc --noEmit -p . 2>&1 | grep -v '^.next/'`.
- Tests: `cd nexus && npx vitest run <path>`. Full suite: `npx vitest run`.
- Copy, used verbatim:
  - "Set when sent to BC"
  - "You changed the invoice number from X to Y. Keep it?" with the buttons "Keep" and "Undo"
  - "Save the order to add notes."
  - The section titles "Order Items" and "Invoicing"
  - The field label "Delivery method"
- Every input, select and textarea on the form (line cells included) uses the customer picker's classes: `border-input bg-background`.

## Review Focus

1. **An order synced before 063** (null snapshots) with a local edit syncs without a false conflict. A BC-side line edit is still caught through the line etag.
2. **A real BC edit to a managed header field** (e.g. Payment_Terms_Code changed in BC) is still flagged "Changed in BC".
3. **A sync that fails halfway, then retries, isn't flagged.** Nexus's own partial writes must update the snapshot as they happen.
4. **Tax gaps don't crash or charge tax.** A tax area with no matching details, an item with no tax group, or `tax_liable` off each gives a 0% rate.
5. **The invoice # behaves at its edges:**
   - a PO long enough to push it past 35 characters is cut to 35
   - clearing a manual invoice # returns to auto
   - changing the PO updates the auto value shown

---

### Task 1: Migration 063 and types

**Files:**
- Create: `nexus/supabase/migrations/063_sales_order_snapshots_and_notes.sql`
- Modify: `nexus/src/types/salesOrders.ts`

**What it does:**
- Adds `sales_orders.bc_snapshot jsonb` and `sales_order_lines.bc_snapshot jsonb`, both nullable.
- Creates table `sales_order_notes`:
  - columns: `id uuid pk default gen_random_uuid()`, `organization_id` and `bc_connection_id` (FKs on delete cascade, as in 060), `sales_order_id uuid not null references sales_orders(id) on delete cascade`, `body text not null check (char_length(body) between 1 and 4000)`, `created_by uuid`, `created_at timestamptz not null default now()`, `updated_by uuid`, `updated_at timestamptz not null default now()`
  - index on `(organization_id, bc_connection_id, sales_order_id, created_at)`
  - RLS select-by-org
- Copies old notes in once:
  - `insert ... select` from `sales_orders` where `notes <> ''` and no note exists yet for that order
  - `created_by = sales_orders.created_by`, `created_at = sales_orders.updated_at`
- Types:
  - `SalesOrderRow.bc_snapshot: Record<string, unknown> | null`
  - `SalesOrderLineRow.bc_snapshot: Record<string, unknown> | null`
  - `SalesOrderNoteRow` (mirrors the table)
  - `SalesOrderNoteView = SalesOrderNoteRow & { author_name: string }`
- Fix the typecheck fallout (test fixtures get `bc_snapshot: null`).
- **Verify:** the typecheck is clean, and the full suite passes.
- **Commit:** `feat(sales-orders): migration 063 for BC value snapshots and note entries`.
- The controller asks the user to apply 063 and checks the new columns before Task 2.

### Task 2: Conflict check by managed-field values

**Files:**
- Modify:
  - `nexus/src/lib/salesOrders/bcOrderMapping.ts` (+ test)
  - `nexus/src/lib/salesOrders/orderSync.ts` (+ `orderSync.test.ts`)

**Interfaces (produced):**
- `HEADER_SNAPSHOT_FIELDS: readonly string[]`:
  - every key `toBcHeaderPatch` returns
  - `'Sell_to_Customer_No'`
  - `'Ship_to_Code', 'Ship_to_Name', 'Ship_to_Address', 'Ship_to_Address_2', 'Ship_to_City', 'Ship_to_County', 'Ship_to_Post_Code', 'Ship_to_Country_Region_Code', 'Ship_to_Contact'`
- `LINE_SNAPSHOT_FIELDS: readonly string[]` = `['Type', 'No', 'Quantity', 'Unit_of_Measure_Code', 'Unit_Price', 'Line_Discount_Percent', 'Location_Code']`
- `snapshotOf(rec: BcRecord, fields: readonly string[]): Record<string, unknown>`:
  - only the keys present in `rec.fields`
  - values copied as-is
- `bcChangedOutsideNexus(stored, current)`, with this stored shape:
  ```
  { bc_snapshot: Record<string, unknown> | null;
    lines: { bc_line_no: number | null; bc_etag: string | null; bc_snapshot: Record<string, unknown> | null }[] }
  ```
  - **Header:** with a snapshot, true when any snapshot key's current value differs. Compare numbers as `Number`, booleans strictly, everything else as `String(v ?? '')`. A null snapshot means the header check passes.
  - **Lines:** a line with a snapshot is compared by values the same way. A line without one is compared by etag, as today.
  - A BC line unknown to Nexus means true, as today.
  - The header etag is no longer compared.

**Sync changes (`orderSync.ts`):**
- The conflict check passes `order.bc_snapshot` and each line's `bc_snapshot`. Remove the `storedEtag` fallback.
- Every successful Nexus write stores the new snapshot right away, next to the etag it already stores:
  - `patchHeader`: `bc_snapshot: snapshotOf(returned, HEADER_SNAPSHOT_FIELDS)`
  - the ship-to `afterWrite` GET: same
  - line create and line patch: the line's `bc_snapshot` from the returned record
  - the post-header-patch line re-list: snapshot of each known line, alongside the etag refresh
- Step 6 read-back stores the header snapshot and each line's snapshot.

**Tests (failing first):**
- **mapping:** `snapshotOf` keeps only present keys.
- **mapping, `bcChangedOutsideNexus`:**
  - a header etag change with equal snapshot values → false
  - `Payment_Terms_Code` changed → true
  - a null header snapshot with a different etag → false
  - a line with a snapshot whose etag differs but values are equal → false
  - a line with a snapshot whose `Quantity` changed → true
  - a line with no snapshot and a different etag → true
  - a BC line unknown to Nexus → true
  - `Quantity` 2 vs `"2"` compares equal
- **orderSync:**
  - **Background re-save:** an order whose BC header etag changed but whose values match the snapshot syncs to `'synced'` and patches BC.
  - **Real BC edit:** a managed header field changed in BC → `'conflict'` with `sync_error` "Changed in BC", and no BC write.
  - **Retry after a partial failure:** the header patch succeeds, then a line create throws. On the second run, with BC returning the patched header, the result is not a conflict.
  - **Stored snapshots:** after a successful sync, `bc_snapshot` is stored on the order and on each line.
- Keep the existing tests passing. Update the fixtures that relied on header-etag conflicts to use snapshot differences.
- **Commit:** `fix(sales-orders): detect BC changes by managed field values, not header etag`.

### Task 3: Live amounts and effective price/discount in the fields

**Files:**
- Create: `nexus/src/lib/salesOrders/lineAmounts.ts` (+ test)
- Modify:
  - `nexus/src/app/actions/salesOrders.ts` (form context)
  - `nexus/src/components/salesOrders/SalesOrderLinesTable.tsx` (+ test)
  - `nexus/src/components/salesOrders/SalesOrderForm.tsx` (totals, + test)

**Interfaces (produced):**
- Context additions:
  - `SalesOrderItemOption.tax_group_code: string | null`
  - `SalesOrderFormContext.taxAreaLines: { tax_area_code: string; tax_jurisdiction_code: string }[]`
  - `SalesOrderFormContext.taxDetails: { tax_jurisdiction_code: string; tax_group_code: string; tax_type: string; effective_date: string; tax_below_maximum: number }[]`
  - All are loaded for the org and connection (small tables).
- `taxRatePercent(q: { taxAreaCode: string; taxGroupCode: string; date: string; taxLiable: boolean }, areaLines, details): number`:
  - 0 when not tax liable
  - otherwise the sum, over the area's jurisdictions, of `tax_below_maximum` from the latest detail for (jurisdiction, `taxGroupCode`, `tax_type`) with `effective_date <= date`
  - no match adds 0
- `effectivePrice(l: LineDraft): number | null` = `unit_price ?? bc_unit_price ?? estimate_price`
- `effectiveDiscount(l: LineDraft): number` = `discount_percent ?? bc_line_discount_percent ?? estimate_discount_percent ?? 0`
- `lineAmounts(l: LineDraft, ratePercent: number): { excl: number; taxRaw: number; incl: number }`:
  - `excl = round2(qty × price × (1 − disc/100))`, with price null → 0
  - `taxRaw = excl × rate/100`
  - `incl = round2(excl + taxRaw)`
- `orderTotals(rows: { excl: number; taxRaw: number }[]): { subtotal: number; tax: number; total: number }`:
  - `subtotal = round2(Σexcl)`
  - `tax = round2(ΣtaxRaw)`
  - `total = round2(subtotal + tax)`

**Behavior:**
- **Lines table:**
  - When a row's item or quantity changes, the row's `bc_unit_price`, `bc_line_discount_percent` and `amount_incl_tax` are cleared, so the estimate takes over.
  - The Amount incl. tax cell shows `lineAmounts(...).incl`.
  - The Unit price and Disc % inputs show the effective value as their text, with no helper text under them.
  - While an input is focused it holds the raw text being typed. On blur, '' commits null and a number commits the typed value.
  - The input's `value` is the typed value if set, else the effective value formatted (price to 2 decimals, discount as a plain number, blank when 0).
- **Form totals:**
  - While the order is synced and the form is unchanged since load, show BC's `total_*` and line `amount_incl_tax`. "Unchanged" means the header and lines compare equal to the loaded values.
  - Otherwise show `orderTotals` of the live rows.
  - The Tax label reads "Tax (estimate)" when showing the live value, else "Tax".

**Tests (failing first):**
- **Rate, HI-HNL-WHSL:** area line → HI-HN-WHSL; details give TAXABLE 0.5 effective 2025-03-06; date 2026-11-14 → 0.5.
- **Rate, other cases:**
  - `taxLiable` false → 0
  - group '' with no detail → 0
  - a date before the detail's effective date → 0
  - two details for the same key → the latest effective one wins
- **Amounts:** P-1007 qty 1, effective price 2.73, rate 0.5 → incl 2.74. Totals → 2.73 / 0.01 / 2.74.
- **Discount:** qty 2, price 10, typed disc 5, rate 0 → excl 19.
- **Effective values:**
  - a typed price beats the BC price, which beats the estimate
  - a typed discount 0 beats a BC discount of 5
- **Table:**
  - Changing quantity updates the amount cell without a save.
  - Typing a price then blurring stores it.
  - Clearing it stores null and shows the effective value again.
  - A blank-price row shows the estimate in the input's value, not as text under it.
- **Form:**
  - Adding an item updates Subtotal, Tax and Total right away.
  - Changing customer (a new estimate) updates the amounts.
- **Commit:** `feat(sales-orders): live line amounts and totals; effective price and discount shown in the fields`.

### Task 4: Invoice # auto value and confirm

**Files:**
- Modify:
  - `nexus/src/lib/salesOrders/orderRules.ts` (+ test)
  - `bcOrderMapping.ts` (+ test)
  - `SalesOrderForm.tsx` (+ test)
  - `SalesOrdersList.tsx`

**Interfaces (produced):**
- `autoInvoiceNumber(bcOrderNumber: string | null, customerPo: string): string`:
  - '' with no number
  - else `<no>`, or `<no> / <po.trim()>` when the trimmed PO isn't empty
  - cut to 35 characters
- `toBcHeaderPatch`: `External_Document_No: order.invoice_number ?? autoInvoiceNumber(bcNumber, order.customer_po)`
- List: the invoice column shows `o.invoice_number ?? autoInvoiceNumber(o.bc_order_number, o.customer_po) || '—'`.

**Form behavior:**
- **Display:** the input shows `invoiceNumber ?? autoInvoiceNumber(order?.bc_order_number ?? null, customerPo)`. The placeholder is "Set when sent to BC".
- **Typing:** sets the manual value. '' sets null, which means auto.
- **On blur:** if the manual value differs from the value at focus, a Dialog (not `window.confirm`) shows "You changed the invoice number from X to Y. Keep it?" with Keep and Undo. Undo restores the state at focus.

**Tests (failing first):**
- `autoInvoiceNumber`:
  - `('W-100531', '')` → `W-100531`
  - `('W-100531', ' PO-889 ')` → `W-100531 / PO-889`
  - `(null, 'X')` → `''`
  - a 40-character PO → length 35
- The mapping sends `W-100531 / PO-889` when `invoice_number` is null.
- **Form:**
  - Typing in Customer PO updates the shown invoice # while it's auto.
  - Typing a manual invoice # then blurring opens the dialog with both values.
  - Undo restores the auto value.
  - Clearing the field shows the auto value.
- **Commit:** `feat(sales-orders): invoice # defaults to order # / customer PO, with a confirm on manual change`.

### Task 5: Note entries

**Files:**
- Create:
  - `nexus/src/app/actions/salesOrderNotes.ts` (+ test)
  - `nexus/src/components/salesOrders/NotesPanel.tsx` (+ test)
- Modify:
  - `nexus/src/app/(protected)/sales-orders/[id]/page.tsx`: load the notes and pass them in
  - `SalesOrderForm.tsx`: replace the textarea with `<NotesPanel>`
  - `salesOrders.ts`: `saveSalesOrder` stops writing `notes`; remove `notes` from `SalesOrderInput`

**Interfaces (produced):**
- `listSalesOrderNotes(orderId: string): Promise<SalesOrderNoteView[]>`:
  - newest first
  - `author_name` from the users table, '' when unknown
- `addSalesOrderNote(orderId: string, body: string): Promise<{ ok: true; note: SalesOrderNoteView } | Fail>`
- `updateSalesOrderNote(noteId: string, body: string): Promise<{ ok: true; note: SalesOrderNoteView } | Fail>`
- `deleteSalesOrderNote(noteId: string): Promise<{ ok: true } | Fail>`
- The writes:
  - require the same edit scope as `saveSalesOrder` (`canEditSalesOrders`)
  - check that the order or note belongs to the scope's org and connection
  - trim the body, rejecting '' and anything over 4000 characters
  - are allowed in any order status
- `NotesPanel` props: `{ orderId: string | null; canEdit: boolean; initialNotes: SalesOrderNoteView[] }`

**Panel behavior:**
- Add box with an Add button.
- Each card shows the body, the author, and the time as `toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })`, plus "(edited)" when `updated_at > created_at`.
- Edit icon (pencil) → inline textarea with Save and Cancel.
- Delete icon (trash) → Dialog confirm, then delete.
- With a null `orderId`: "Save the order to add notes."
- Icon buttons have `aria-label`s "Edit note" and "Delete note".

**Tests (failing first):**
- **Actions:**
  - add, update and delete happy paths
  - an empty body is rejected
  - a note in another org is rejected
  - no edit permission is rejected
  - add works on a Final order
- **Panel:**
  - adding shows a new card at the top
  - edit then save updates the text
  - delete asks before deleting
  - no order id shows the hint
- **Commit:** `feat(sales-orders): timestamped note entries with edit and delete`.

### Task 6: Layout — header, Order block, Order Items, Invoicing

**Files:**
- Modify:
  - `SalesOrderForm.tsx` (+ test)
  - `StatusSelect.tsx`
  - `SalesOrderLinesTable.tsx` (input classes)

**Layout (spec G3):**
- **Header:** the Delete (Draft or Final only, as today) and Save buttons sit left of the StatusSelect. Save submits the form (`form` attribute) and the bottom button row is removed. The status pill gets smaller padding (about `px-2 py-0.5`).
- **Top row:** a two-column grid at `lg`. The Order block is narrower, about `minmax(0,1fr)` against the Notes panel at `minmax(18rem,24rem)`.
- **Order block:**
  - Title "Order W-100531", or "Order" before BC assigns a number.
  - The Order date input sits in the block's top-right corner, in the title row.
  - Fields in order: Customer, Customer PO (keep its "Nexus and Bill.com only, not sent to BC" hint), Invoice #, Delivery method (the `shipment_method_code` select, list `shipmentMethods`), Requested delivery date.
- **Order Items:** the lines section is renamed "Order Items" and sits below the top row.
- **Invoicing:** the section after Order Items holds Payment terms, Tax area and Tax liable.
- **Hidden:**
  - Gen. bus. posting group and Customer posting group are not rendered. Their values stay in state and are still saved.
  - Document date, Posting date and Due date are removed, along with the "Dates" section.
- **Inputs:** all inputs, selects and textareas, line cells included, use `border-input bg-background`.

**Tests:**
- The Save button sits in the header and saves.
- The title reads "Order W-100531".
- No "Due date", "Posting date", "Gen. bus. posting group" or "Customer posting group" text.
- "Delivery method" label present.
- The "Invoicing" and "Order Items" headings are present.
- Field order in the Order block: Customer PO comes before Invoice #, which comes before Delivery method, which comes before Requested delivery date (DOM order).
- **Commit:** `feat(sales-orders): reorganize the order form layout`.

### Task 7: Billing and Ship-to cards

**Files:**
- Create: `nexus/src/components/salesOrders/AddressCards.tsx` (+ test), which exports `BillingCard` and `ShipToCard`
- Modify: `SalesOrderForm.tsx`

**Interfaces (produced):**
- `BillingCard` props: `{ values: Pick<SalesOrderInput, bill fields>; editable: boolean; onChange(patch): void }`
  - Shows compact text: name, address lines, city/state/ZIP, phone, email (empty lines omitted).
  - A top-right pencil button (`aria-label` "Edit billing address") switches to the existing billing inputs. A "Done" button returns to text.
- `ShipToCard` props: everything the current `ShipToPicker` takes, plus `editable: boolean`.
  - Shows the chosen address as text (code in small muted type when set).
  - A pencil button (`aria-label` "Edit ship-to") reveals the `ShipToPicker`. "Done" hides it.
- Neither edit button renders when locked or busy.
- **Placement:** a side-by-side grid below Order Items and above Invoicing; they stack on small screens.

**Tests:**
- Text mode shows the address with no inputs.
- The pencil shows the inputs, and editing calls `onChange`.
- Locked → no pencil.
- The ship-to pencil reveals the picker, and choosing a one-off still works (reuse a `ShipToPicker` test case).
- **Commit:** `feat(sales-orders): compact billing and ship-to cards with edit buttons`.

### Task 8: Live check on TEST

- Run the full suite, lint and build. Then load the app (memory: build passing ≠ app runs).
- In Chrome on localhost:3000:
  - Open W-100531 and press Retry. Expect In BC, with BC on W00017 and 3 lines.
  - New order: W00376 + P-1007. Before saving, expect the price field to show 2.73, the amount 2.74, and totals 2.73 / 0.01 / 2.74.
  - Save it. Expect In BC, with External_Document_No = `W-1005xx / <PO>` when a PO is typed.
  - Add, edit and delete a note.
  - Check every changed section of the layout.
- Re-run the etag/snapshot diff script on the old orders. If a later diff shows which header field BC re-saves, record it in BACKLOG.md.
- Update the `BACKLOG.md` #5 project 1 notes (what changed, migration 063 added to #1's production go-live list).
