# Change invoice — design

Status: draft for approval · 2026-11-17 · branch `feat/sales-orders`

## Intent

A rep finds a mistake on an invoice Nexus already created: a wrong quantity, a
wrong price, a missing line or a line that shouldn't be there. Today the only
way to fix it is by hand in BC and Bill.com. **Change invoice** lets the rep fix
the lines in Nexus and type why. Nexus then makes BC and Bill.com match, and
records who changed what, when, and why.

The rule from the sales order round (#9): invoices still post in BC when they're
created ("keep it how it is"). Changing one afterwards is a controlled process
with a change log.

## Goals

- Reps can change **quantities and unit prices, and add or remove lines** on an
  invoice Nexus created from a sales order.
- After a change: BC has a posted invoice with the corrected lines and the
  **same Invoice #** (External Document No.), and the old BC invoice is
  cancelled. The **same Bill.com invoice** shows the corrected lines and total.
- Every change is logged: user (id plus display name), time, a required reason,
  old and new total, and old and new BC Invoice No. The log shows on the
  invoice page.
- It's as crash-safe as Create invoice: a crash, a lost response or a double
  click can never cancel twice, post twice or leave a half-done state without a
  visible Retry.

## Non-goals

- Changing the customer, ship-to, dates, payment terms or currency.
- Changing invoices Nexus didn't create, such as ones posted directly in BC
  with no Nexus sales order.
- Changing paid, partly paid or void invoices. Refunds and credits belong to
  the Payments project.
- Sending the corrected invoice to the customer. That's backlog project 3 (Send
  invoice).
- Approvals or limits on who may change an invoice. The same permission as
  Create invoice applies.

## Anti-goals (a failure even if it "works")

- Two live posted BC invoices for one order, or an old invoice that is
  cancelled with no corrected one and nothing telling the rep.
- A Bill.com total that doesn't match BC by more than the known rounding cents.
- A change log entry that's missing, or that claims success for a change that
  didn't finish.

## Constraints and facts found

- **Posted BC invoices can't be edited.** API v2 has the bound action
  `salesInvoices({id})/Microsoft.NAV.cancel`. It posts a corrective credit
  memo, and the invoice's status becomes `Canceled`. BC refuses to cancel an
  invoice with a payment applied. **Cancelling can't be undone, and it has
  never been run against TEST BC. The first live run needs the user's
  go-ahead** (proposed: INV-100411).
- **Nexus posts through the BC sales order** (`salesOrders(id)/Microsoft.NAV.shipAndInvoice`,
  `bcInvoicing.ts`). BC deletes the sales order once it's fully invoiced, so the
  corrected invoice can't go through the order. It is a **standalone BC sales
  invoice**.
- **Orders are written through OData pages, not API v2**
  (`bcOrderMapping.ts`: `SalesOrder` 42, `SalesOrderSalesLines` 46,
  `salesDocuments` for the ship-to). Those set `Tax_Area_Code`, `Tax_Liable`,
  `Location_Code` (header and lines), `Shipment_Method_Code`,
  `Payment_Terms_Code`, the posting groups, `Ship_to_Code`,
  `Unit_of_Measure_Code` and `EMailCCHCABG`. API v2 `salesInvoices` can't set
  several of these, so tax, location or posting could differ from the original.
  **Decision (Claude's call):** create the corrected invoice through BC's
  **Sales Invoice OData page (43) and its lines page (47)**, reusing the
  order mapping, with the header values taken **from the Nexus order**
  (which matched BC when it was invoiced). Plan Task 1 confirms in TEST BC
  that the invoice pages accept the same fields. If a field is missing, it's
  set through `salesDocuments` as the ship-to is today. Then post with the
  API v2 bound action `salesInvoices({id})/Microsoft.NAV.post` (the OData
  record's `SystemId` is the API id).
- **Invoice date (user's decision): keep the original invoice date and due
  date** on the corrected invoice, so the customer's payment terms don't
  restart. If BC refuses because the date is in a closed period or outside
  the allowed posting dates, the step stops as `post_failed` with BC's message;
  there's no automatic fall back to today.
- **Tax** is BC's. The corrected invoice's totals come from BC after posting,
  as they do for Create invoice.
- **Bill.com v3:** `PUT /v3/invoices/{id}` ("Replace an invoice") replaces the
  invoice, including adding and removing line items. `PATCH` only edits
  existing lines. The exact PUT body must be confirmed in the **sandbox** (Task
  1 of the plan); the sandbox is allowed. The rounding rule is the same as
  Create invoice: unit price ceiled to the cent, real quantity.
- **"Paid" today:** Nexus only knows payment state from Bill.com.
  `readBillcomInvoiceStatus` (`status`, `dueAmount`, `totalAmount`) is used
  only by the invoice page today; the change check calls it on the order page
  and again on the server (new code). BC's own refusal to cancel is the
  backstop.
- **`findPostedInvoice` searches by `orderNumber` first**, and a cancelled
  invoice keeps its order number. Create invoice's Retry and the background
  sweep must never run on an order with an open change (`invoice_state =
  'changing'` isn't resumable), and the change's post step uses its own search.
- The Next.js memoization rule from the invoice page still applies: write
  functions return stored rows, and a read-back is never trusted.
- TEST BC and the Bill.com sandbox only. Stage specific paths. No push or merge
  without consent.

## Approaches

Where reps edit the lines:

- **A. On the sales order — chosen by the user.** Change invoice unlocks the
  order's existing lines table. **Save changes to invoice** asks for a reason
  and runs the process. The order always matches the current invoice, and no
  second line editor is needed.
- **B. On the invoice page.** A separate editable lines table. It duplicates
  item search, price, discount and tax display, and the order drifts unless
  it's kept in sync. Rejected.

How BC is corrected (Claude's call, stated to the user):

- **Cancel and post a standalone corrected invoice — chosen.** One BC action
  reverses the old invoice, and the new one is a normal posted invoice with the
  same Invoice #.
- `makeCorrectiveCreditMemo` with a manual credit memo — rejected. It needs
  more steps, and the rep or Nexus would have to post the credit memo
  separately.
- Credit memo for just the difference — rejected. It leaves the original
  invoice with wrong lines, and Bill.com wouldn't match one BC invoice.

## Design

### Who and when

- Shown on a sales order whose `invoice_state = 'done'`, to users with the
  sales-order edit permission (`editScope`, the same as Create invoice).
- **Allowed only if** the Bill.com invoice reads `OPEN` with
  `dueAmount === totalAmount` (no payment). Otherwise the button is disabled
  with the reason: "Paid or partly paid in Bill.com — can't change",
  "Void in Bill.com", or "Couldn't reach Bill.com — try again". If Bill.com is
  off for the org, the check is skipped and BC's refusal is the guard. The
  check runs **again on the server** when the change is submitted, not only
  when the page loads.

### Rep flow (on the sales order)

1. **Change invoice** (next to View invoice) switches the order into change
   mode. A bar reads "Changing invoice W-100532 — edit lines, then Save
   changes to invoice." Only the lines table unlocks: qty, unit price,
   discount %, and add or remove line. Header fields stay locked. Cancel
   changes discards the edits.
2. **Save changes to invoice** is disabled until a line actually differs. It
   opens a popup:
   - It shows the old total and the new subtotal before tax ("BC recalculates
     tax").
   - It has a required **Reason** text box (1–1000 characters).
   - It warns: "BC will cancel INV-100411 and post a corrected invoice. This
     can't be undone."
   - Buttons: Confirm / Back.
3. On Confirm: the server re-checks Bill.com, then writes the change record
   with `lines_before` (the order's current lines) and `lines_after` (the
   edits). **The order's lines aren't touched yet** (Claude's call). It sets
   the order to `changing` and starts the process in the background
   (`after()`), like Create invoice. The order shows **Changing invoice…** with
   the edited lines from `lines_after`, and polls.
4. When it finishes, `lines_after` is written to the order's lines (Nexus only;
   there's no BC order to sync), the order is locked again, View invoice opens
   the **new** BC invoice, and the invoice page shows the change in its
   history.
5. On failure, the order shows the step that failed with **Retry**, as Create
   invoice does. **Discard change** is offered only while the old invoice is
   still live (`pending` or `cancel_failed`, for example when BC refuses the
   cancel because of a payment). It closes the record as `discarded` and
   returns the order to `done`, unchanged. Once BC has cancelled the old
   invoice, only Retry is offered, so an order is never left with no live
   invoice and no explanation.

**Prices in change mode (Claude's call):** lines the rep didn't touch keep
the exact unit price and discount they were invoiced at (from the posted BC
lines), so a price-list change since then can't re-price them. Every changed
or added line must have a unit price; a blank price, which on orders means
"let BC price it", isn't allowed in change mode.

### Process (state machine on the change record)

New table `sales_invoice_changes`, one row per change. Its `state` moves
through:

```
pending -> cancelling -> cancelled -> posting -> posted -> billcom_updating -> done
   |          |                          |                       |
   |    cancel_failed               post_failed            billcom_failed   (Retry resumes the step)
   |          |
   +----------+--> discarded   (Discard change: only before BC cancelled the old invoice)
```

- The steps follow the Create invoice safety rules: the order lease
  (`withOrderLease`), compare-and-set on the expected state, and an extended
  lease across BC actions.
- The order gets `invoice_state = 'changing'` while a change is open; a new
  value is added to the check constraint. It returns to `done` when the change
  finishes. It never goes back to `done` while BC has no live invoice. Create
  invoice, Retry and edits refuse to run while it's `changing`.
- **cancel step:** first read the old invoice from BC. If its status is already
  `Canceled`, record that and move on. Otherwise call `cancel`. If the outcome
  is unknown (timeout), re-read the status before any retry. Never call
  cancel on an invoice that isn't `Open`. BC's refusal message is saved as
  `cancel_failed` (for example, it has a payment).
- **post step:** look first for a posted invoice with the same
  `externalDocumentNumber` and customer that is **not** the old id and **not**
  `Canceled`. If one exists, record it (crash recovery). Then look for a
  **draft** to reuse rather than creating a second one: the
  `draft_bc_invoice_id` saved on the record, or else an unposted BC sales
  invoice with the same Invoice # and customer (this covers a crash between
  creating the draft and saving its id; Claude's call). Then create the draft
  if there's none, set its lines from `lines_after` (replacing any lines it
  has), post, and record `new_bc_invoice_id` and number. Mirror it into
  Receivables, and re-mirror the old invoice so its status shows `Canceled`.
- **Before posting, a safety check:** the draft's line count and its totals
  before tax match the edited Nexus lines (cents). A mismatch stops the step as
  `post_failed` with a clear message, and the draft is left for inspection.
- **billcom step:** build the payload from the edited lines and the new posted
  totals (the same `buildBillcomInvoice` rules). `PUT` the existing Bill.com
  invoice (`sales_orders.billcom_invoice_id`). Read it back and reuse
  `billcomInvoiceMismatch`. A mismatch is `billcom_failed`. If Bill.com is off,
  skip to `done`. If Bill.com is on but the order has no `billcom_invoice_id`
  (Bill.com was off when the invoice was created), use Create invoice's
  existing find-or-create step instead of PUT (Claude's call).
- **done:** write `lines_after` to the order's lines, set the order's
  `bc_posted_invoice_id` and number to the new invoice, `invoice_state =
  'done'`, and the record's `finished_at`.

### Data

`supabase/migrations/066_sales_invoice_changes.sql` (the user applies it):

- `sales_invoice_changes`: id, organization_id, bc_connection_id,
  sales_order_id (FK), state (checked list above), error text, reason text
  (1–1000), changed_by uuid, changed_by_name text (copied at the time, so the
  log survives user renames), created_at, finished_at, old_bc_invoice_id,
  old_bc_invoice_number, old_total numeric, draft_bc_invoice_id,
  new_bc_invoice_id, new_bc_invoice_number, new_total numeric, lines_before
  jsonb, lines_after jsonb (item, description, qty, unit price, disc % — so the
  history can show what changed). RLS policy as `sales_order_notes`. Index on
  (organization_id, bc_connection_id, sales_order_id, created_at).
- At most one open change per order: a partial unique index on
  `sales_order_id where state not in ('done','discarded')`.
- `sales_orders.invoice_state` check: add `'changing'`.

### Invoice page

- **History card** ("Changes"): every change for the order the invoice belongs
  to, newest first. Each shows: date and time, name, reason, old total → new
  total, old BC No. → new BC No., and a "Show lines" toggle with a before/after
  table. An open or failed change shows its state.
- **On a cancelled invoice page:** a banner "Cancelled — replaced by
  INV-100415" (link). Lookup is by `old_bc_invoice_id` in the change table.
- The invoice page finds the order through either the order's current
  `bc_posted_invoice_id` or a change record's `old_bc_invoice_id`.

### Receivables list

Cancelled BC invoices stay in the list with BC status `Canceled` (that's BC's
truth), so the list won't double-count by mistake. *(Builder's call: they could
be hidden by a filter later; not in scope.)*

## Testing

- Unit tests with fakes for every state step, including the crash-recovery
  branches: cancel already done, a posted replacement already present, a draft
  already created (saved id or found by search), an unknown cancel outcome, a
  Bill.com mismatch, Discard allowed before the cancel and refused after it,
  and Create invoice's Retry or sweep skipping a `changing` order.
- Component tests: the reason popup's required text, the disabled reasons, and
  the change-mode lines unlock.
- **Live, TEST BC + sandbox, only with the user's go-ahead:** change
  INV-100411 (cancel plus repost), then check BC (credit memo, new invoice with
  the same Invoice #), Bill.com (same invoice, new lines and total), the order
  and the invoice page history.

## Left to the builder

- Exact component split in `SalesOrderForm` and `InvoiceControls` for change
  mode.
- Exact PUT body for Bill.com (confirm in the sandbox first).
- Exact field list on Sales Invoice pages 43/47 (confirm in TEST BC first;
  creating an unposted draft there is safe and can be deleted).
- Polling and refresh mechanics (reuse Create invoice's).
- Message wording beyond what's fixed above.
