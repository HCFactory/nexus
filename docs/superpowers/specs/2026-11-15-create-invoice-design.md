# Create Invoice from a Sales Order: Design

**Date:** 2026-11-15
**Status:** Draft for the user's approval
**Backlog:** #5 Order-to-cash in Nexus, project 2 of 4
**Builds on:** `2026-11-13-sales-orders-design.md`, `2026-11-13-sales-order-pricing-design.md`, `2026-11-14-sales-order-revisions-design.md` (branch `feat/sales-orders`, TEST only, kept as-is), and the Bill.com customer push (`2026-10-30-customers-billcom-design.md`).

## Intent

Today a rep builds a sales order in Nexus, and Nexus keeps it in step with Business Central (BC). The next step, invoicing, still happens outside Nexus: someone posts the order in BC, and Bill.com's own BC connector later copies the invoice into Bill.com.

This project adds a **Create invoice** button to the order. One click posts the order in BC (ship and invoice together), records the posted invoice in Nexus, and creates the matching invoice in Bill.com. Nexus becomes the place where an order turns into a bill. Projects 3 (Send invoice) and 4 (Payments) build on the Bill.com invoice this creates.

Posting in BC **cannot be undone**. Three systems are involved (Nexus, BC, Bill.com), so the design centres on never posting twice and never losing track of an invoice when something stops halfway.

## Goals

- **G1. Create invoice button.** A saved, unchanged order in status Final or Pulled shows **Create invoice** in the page header. It opens a confirm box, then runs the invoice process.
- **G2. Post in BC.** Set the order's document date and posting date to today (in the BC connection's time zone), then post ship and invoice. Read back the posted invoice's number, id, due date and totals.
- **G3. Create the Bill.com invoice.** For the order's customer, with the Invoice #, invoice date, due date and lines. The Customer PO goes along if Bill.com accepts it (see Open item O1). Bill.com does not email the customer (that's project 3).
- **G4. Tracked, resumable process.** The order records each step's result before starting the next. A stopped process resumes from the last finished step, and is never repeated in a way that posts twice or creates a second Bill.com invoice.
- **G5. Order outcome.** On success the order is **Invoiced** and locked, and shows **View invoice** and "In Bill.com". If the Bill.com step fails, the BC invoice stands, and the order shows "Not in Bill.com" with **Retry**.
- **G6. Block what can't finish.** Create invoice is disabled, with the reason shown, when the customer can't receive a Bill.com invoice (not linked, needs attention, or failed in the Bill.com customer push).

## Non-goals

- **Ship only, then invoice later.** BC's standard API has no ship-only action. A possible workaround (set "Qty. to Invoice" to 0, then post) is to be tested on TEST later, with the user's go-ahead, since posting can't be undone. It is a follow-up project.
- Sending the invoice email (project 3) and payments (project 4).
- Partial invoicing, credit memos, and un-posting.
- Invoicing orders that were created in BC rather than Nexus.
- A new invoice detail page. View invoice opens the existing Receivables invoices page (see Decisions).

## Anti-goals (a failure even if it technically works)

- **Posting an order twice**, or creating two Bill.com invoices for one BC invoice.
- A posted BC invoice that Nexus doesn't know about after a crash or timeout.
- Bill.com showing a different total from BC's posted invoice.
- A duplicate invoice in production Bill.com because Bill.com's own connector also copied it (see Go-live).

## Decisions made with the user

1. **Ship and invoice together first.** It's the usual case. Ship-only comes later.
2. **Nexus creates the Bill.com invoice** (not Bill.com's connector). At production go-live, the connector's invoice copying is switched off.
3. **Block Create invoice until the customer is ready in Bill.com.** If the customer is missing a name or email in Bill.com (link status `needs_attention`), not pushed yet (`pending` or no link), or failed (`failed`), the button is disabled and says what to fix.
4. **Approach B: a tracked, step-by-step process** (below), not a single request and not a separate job queue.

## Approaches considered

- **A. One request does everything while the user waits.** Simplest. But if the request dies after BC posts and before Nexus records it, Nexus doesn't know the invoice exists, and someone has to reconcile by hand.
- **B. Tracked, resumable process (chosen).** The order stores its invoice state. Each step runs in the background (the same `after()` and lease pattern order saves use) and saves its result before the next. Anything that stops resumes from the last finished step. It costs one migration and a little more code, and it is what keeps an irreversible action safe.
- **C. A separate job queue on a timer.** The most robust against long outages, but Nexus has no queue today. More machinery than this needs.

## How it works

### When the button is available

Create invoice shows for users who can edit sales orders (decided, P1) when **all** of these hold:

- The order is saved and has a BC order number.
- Its sync state is **In BC** (`synced`), with no unsaved edits in the form.
- Its status is **Final** or **Pulled**.
- Its invoice state is `none` (no invoice process started).
- The customer's Bill.com link has status `synced` and a Bill.com customer id.

When the order qualifies but the customer doesn't, the button shows disabled with the reason, e.g. "Add an email to this customer in Customers before invoicing", or "This customer isn't in Bill.com yet. Push it from Customers first."

### Confirm box

```
Create invoice for W-100533?
  Food Pantry Eaton Square · $2.74
  Invoice # W-100533 / NX-TEST-7 · Invoice date today (Nov 15)
  This posts the order in BC. It can't be undone.
                                   [Cancel] [Create invoice]
```

The total is the order's current BC total. The Invoice # is what BC's External Document No. holds (manual or automatic, per the revisions design).

### The invoice states

New order fields record the process (migration 064):

| State | Meaning | Next |
|---|---|---|
| `none` | No invoice process started | `posting` on confirm |
| `posting` | Nexus is setting dates and posting in BC | `posted`, or `post_failed` |
| `post_failed` | Posting didn't happen (BC refused, e.g. a blocked item) | Retry → `posting` |
| `posted` | BC posted; Nexus holds the posted invoice's number, id, due date and totals | `billcom_sending` |
| `billcom_sending` | Creating the Bill.com invoice | `done`, or `billcom_failed` |
| `billcom_failed` | BC invoice stands; Bill.com invoice not created | Retry → `billcom_sending` |
| `done` | Invoiced in BC and in Bill.com | (final) |

The process holds the order's existing lease (`claimed_until`) for each step, so a double click, a second tab, or the list page's retry sweep can't run it twice at once.

### Step 1: posting (`posting`)

1. **Check first, never post twice.** Ask BC whether a posted sales invoice already exists for this order (by order number, and as a backstop by External Document No. and customer). If one exists, record it and skip to `posted`. This covers a crash after BC posted but before Nexus saved the result.
2. **Re-check for edits in BC.** Use the same value check as order saves (the stored copy of managed fields). If someone changed the order in BC, stop. The order shows "Changed in BC" and the invoice state goes back to `none`. Nothing is posted.
3. **Set the dates.** Document date and posting date = today in the BC connection's time zone. Nexus writes them through the same path order saves use.
4. **Post.** Call BC's ship-and-invoice action for the order.
5. **Read back the posted invoice** (as in item 1): number, BC id, invoice date, due date, total excluding tax, tax, total including tax.
6. If BC refuses to post (for example, a blocked item or a missing setup value), record BC's message and go to `post_failed`. The order stays in its status. The message shows on the order with Retry.

On reaching `posted`:
- the order's status becomes **Invoiced** (which locks it, per the existing rules)
- BC deletes a fully invoiced sales order, so Nexus stops all syncing of this order to BC from here on: no saves, sweeps or Overwrite

### Step 2: Bill.com (`billcom_sending`)

1. **Check first, never create twice.** Look in Bill.com for an invoice with this Invoice # for this customer. If one exists, record it and finish.
2. **Create the Bill.com invoice:**
   - **Customer:** the Bill.com customer id from the customer's link.
   - **Invoice number:** the BC External Document No. (the order's Invoice #).
   - **Invoice date and due date:** from the posted BC invoice.
   - **Lines:** from the **posted BC invoice's lines** (BC deletes the sales order on posting, and its posted amounts are the source of truth). One Bill.com line per posted line: item number and description, quantity, and unit price after discount. Read them from BC at this step; Nexus already reads posted invoice lines for Receivables (`salesInvoiceLineSync.ts`). *(Builder's call, confirmed in review.)*
   - **Tax:** BC's posted tax amount, as Bill.com's sales tax field if it has one, otherwise a "Sales tax" line.
   - **Customer PO:** if Bill.com accepts it (O1).
   - **Customer email:** not sent. Create with Bill.com's `sendEmail` flag off. O3 confirms in the sandbox that nothing goes to the customer, and that the invoice stays sendable later for project 3.
3. **Totals must match.** If the Bill.com total that would be created differs from BC's posted total including tax, record the difference as an error (`billcom_failed`) rather than creating a mismatched invoice. Where Bill.com recomputes a line as quantity × price and lands a cent off BC's line amount, send the line as quantity 1 at BC's line amount, keeping the quantity in the description.
4. Record the Bill.com invoice id and go to `done`.

If Bill.com refuses or is unreachable, record its message and go to `billcom_failed`. The BC invoice stands. The order shows "Not in Bill.com" with Retry. Bill.com's limit of 3 requests at a time applies; the process makes at most one request at a time.

### On the order page

- **Header:** Create invoice sits with Status, Save and Delete. While a step runs it shows "Invoicing…". After `posted`, Save and Delete go away (the order is locked and gone from BC).
- **Status line** (where "In BC" shows today): *Invoicing…*, *Invoiced · Not in Bill.com* (with Retry), *Couldn't post* (with BC's message and Retry), or *Invoiced · In Bill.com*.
- **View invoice:** opens Nexus's Receivables invoices page for this posted invoice. The BC invoice reaches that page through the existing Receivables sync. Until then, View invoice shows the posted invoice number, with a note that it appears after the next Receivables sync.
- **Sales orders list:** the Invoiced status and the new states show in the status and sync columns.

### Data (migration 064)

New columns on `sales_orders`:
- `invoice_state` (text, default `none`, with a check on the seven states)
- `invoice_error` (text)
- `bc_posted_invoice_id`, `bc_posted_invoice_number` (text)
- `posted_at` (timestamptz), `invoice_date`, `invoice_due_date` (date)
- `posted_total_excl_tax`, `posted_total_tax`, `posted_total_incl_tax` (numeric)
- `billcom_invoice_id` (text), `billcom_invoiced_at` (timestamptz)
- `invoice_started_by` (uuid)

Plus an index for the list sweep on `invoice_state`. RLS stays select-by-org; writes go through server code with the service client, as today.

### Resuming a stopped process

- **On the order page:** opening an order in `posting` or `billcom_sending` whose lease has expired resumes it, as order saves do today.
- **On the list page:** the existing sweep (which retries pending order saves) also picks up stuck invoice steps, a few at a time.
- **Retry button:** shown for `post_failed` and `billcom_failed`, to the same users who can create invoices.
- **Retry on `billcom_failed` re-reads the customer's Bill.com link.** If the link is no longer `synced` (for example, the customer now needs attention), Retry stays `billcom_failed` with the reason ("Add an email to this customer, then Retry"). Otherwise it uses the link's current Bill.com customer id. *(Builder's call.)*
- **Excluded from order syncing.** Once `invoice_state` is past `none` and `posting` has succeeded, the existing save sweep, Try again, Overwrite and the "Changed in BC" check all skip the order. `orderRules` currently says only BC sets Shipped/Invoiced; that rule becomes "only the invoice process sets them", and they still can't be picked by hand.

## Go-live (production)

Sales orders (project 1) and Create invoice go live together.

1. Apply migrations 060–064 in production.
2. In production Bill.com, **switch off the BC connector's invoice copying** before the first Nexus invoice. Otherwise invoices appear twice.
3. Switch Nexus to the production BC connection, then run Customer Sync and the Bill.com customer push so customers are linked.
4. Invoice one real order end to end and compare BC, Nexus and Bill.com.

## Open items (resolved during the build)

- **O1. Customer PO on Bill.com invoices.** Bill.com's v3 API may have no PO field. The first build step tests this in the Bill.com sandbox. If there's no field, **stop and ask the user** where the Customer PO should go (for example, the invoice description or a line note). Don't choose on their behalf.
- **O2. Exact BC calls.** Which entity and id the ship-and-invoice action needs, and how to find the posted invoice (by order number). Measure on TEST before building step 1. Posting on TEST creates real posted documents there; use the test orders (W-1005xx).
- **O3. Bill.com behaviour.** In the Bill.com **sandbox** (the one the customer push was live-tested against; production Bill.com is never used for tests): whether invoices have a sales-tax field; whether a duplicate invoice number is rejected; that creating with `sendEmail` off emails nobody; and which status the new invoice gets, so project 3 can send it later.

## Left to the builder

- Module split (likely `src/lib/salesOrders/invoiceProcess.ts` for the state machine, plus a Bill.com invoice payload module next to `customerPayload.ts`).
- The exact error wording, within the meanings above.
- How View invoice finds the invoice on the Receivables page (search by invoice number, or a filter in the URL).
- Test fakes for BC posting and Bill.com invoices, following the existing order sync and customer push tests.

## Calls I made (for the user to check)

- **P1. Permission — decided by the user (2026-11-15).** Create invoice and its Retry use the existing "Edit sales orders" permission. There is no separate "Create invoices" permission.
- **P2. Statuses.** Create invoice is allowed from **Final or Pulled**, not Draft.
- **P3. Dates.** Invoice date = posting date = today, with no date picker. This matches the sales-orders design note.
- **P4. Failure after posting.** The BC invoice always stands, and the order is Invoiced even if Bill.com fails. Bill.com is retried separately.
