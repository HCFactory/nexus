# Sales Orders in Nexus — Design

**Date:** 2026-11-13
**Status:** Draft, awaiting approval
**Backlog:** #5, project 1 of 4

## Where this sits

Backlog #5 (Bill.com pieces E and F, plus the order-to-cash flow around them) splits into four projects, built in this order:

1. **Sales orders in Nexus** (this doc). Reps create and edit sales orders in Nexus, which sync to BC as BC sales orders.
2. **Create invoice from a sales order.** One click posts the order in BC and syncs the resulting invoice to Bill.com. It also adds a "View invoice" button. Ship-and-invoice is the default, with ship-only as an option (see "Notes for project 2").
3. **Send invoice button.** It triggers Bill.com's own invoice email, using Bill.com's template, and does nothing more.
4. **Payments.** Bill.com payments come into Nexus first and get reviewed there. A separate, explicit step then records them in BC.

Bill.com's native BC connector stays on in production until the Nexus sync fully replaces it. The TEST BC environment has no connector, so all four projects are built and tested against TEST.

**Project 1 stays on TEST until project 2 is done** (decided). Sales orders go live in production together with Create invoice. Because of that, project 1 never has to handle orders that were released, shipped or invoiced inside BC. That handling belongs to project 2. The switch to the production connection is part of project 2's go-live.

## Intent

Today, sales reps type sales orders straight into BC. The orders arrive by email, phone and EDI. The goal is to move order entry into Nexus, so the whole order → invoice → send → payment flow can run from one place. Projects 2–4 hang off the Nexus copy of the order, so project 1 is the foundation.

A Nexus sales order must **match a BC sales order**: same fields, same meaning. It becomes a real BC sales order that BC can post as usual.

## How orders look today (from TEST BC, 76 recent orders, May 2025 copy)

- About 2 lines per order on average, 11 at most. **Every line is an Item line**, with no G/L, resource or comment lines.
- Almost always filled: customer, customer PO number (`externalDocumentNumber`, 74/76), ship-to address, payment terms, location on every line, quantity, unit price.
- Sometimes filled: shipment method (33/76), requested delivery date (21/76), shortcut dimension 2 (5/76).
- Never used: salesperson, line or invoice discounts, item variants, description 2.
- Tax is calculated by BC on lines (`taxCode` on every line).
- No order was partly shipped or partly invoiced.

## Goals

- A **Sales Orders** page that lists orders, plus an order page with a header and a lines table, to create, edit and delete orders.
- Every saved order becomes a BC sales order in the org's default BC environment and stays in step with Nexus edits.
- Reps see where each order stands: waiting to send, in BC, or needs attention, and why.
- The Nexus copy holds what BC decided: the order number, unit prices it filled in, tax and totals. That way projects 2–4 have reliable data to build on.

## Non-goals

- Reading orders automatically from EDI or email. Reps keep typing them in, just in Nexus.
- Editing sales orders in BC. After go-live, Nexus is the only place orders are created or edited (decided). Orders that already exist in BC are not imported.
- Two-way sync.
- Posting, shipping or invoicing (that's project 2).
- Friends & Family orders (the existing `friends_family_*` tables). They stay a separate internal feature and never go to BC.
- Line types other than Item, invoice discounts, item variants and salesperson. None are used today; they can be added later. (Line discount % **is** in scope.)
- Partial quantities to ship. Not needed in project 1.

## Anti-goals: failures even if it "works"

- **Silently overwriting a change someone made in BC.** If the BC order changed since Nexus last synced it, Nexus must stop and flag it, never overwrite.
- **Duplicate BC orders.** A retried sync must never create a second BC order for the same Nexus order.
- **An order that looks fine in Nexus but isn't in BC,** or the reverse, with no visible sign.
- **Nexus calculating its own tax or totals** and showing numbers that differ from BC's.

## Constraints

- **Writes go through BC's published Sales Order page, not API v2.0.** API v2.0 `salesOrders` lacks most of the required header fields: document date, due date, tax area, both posting groups, tax liable, contact no., mobile and Email CC. TEST BC already publishes Page 42 as the OData service **`SalesOrder`**, with lines as **`SalesOrderSalesLines`**.
  - Verified 2026-11-13: these carry every field this doc needs, including the Email CC extension field `EMailCCHCABG`.
  - This is the same pattern Nexus uses for customers with `Customer_Card_Excel`.
  - **Production BC must publish the same two services** before go-live. Add this to the backlog #1 go-live list.
  - The default BC environment is TEST for now. Clients are built from the database with `createBcClientForOrg`.
- Nexus has **no scheduled background jobs** (no cron). The Bill.com customer push runs only while its page is open, driven by the browser.
- Existing synced data the order screen picks from:
  - `business_central_customers`: address, `payment_terms_id`, `shipment_method_id`
  - `business_central_items`: `unit_price`, `blocked`, base unit of measure
  - `business_central_payment_terms` and `business_central_locations`
- The name "Orders" is taken: `/orders` is packaging **purchase** orders. The new page must be clearly named "Sales Orders".
- Follow the repo's existing patterns:
  - leases (`claimed_until`) for work that must not run twice at once
  - `fetchAll` for paged reads
  - SECURITY DEFINER functions with `search_path=''`, revoked from `public, anon, authenticated`
  - permission flags in `src/lib/auth/permissions.ts`

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | **BC-first save.** Save writes to BC in the same request, then stores BC's result in Nexus. This is how customer editing works today. | Immediate errors and a BC number from the first save. The rep waits on BC, and Save fails when BC is down. |
| **B** | **Save in Nexus, sync in the background.** *(Picked.)* | Save is instant and never blocked by BC. Errors, the BC number, prices and tax arrive a moment later, so the UI has to show sync state clearly. |
| C | No Nexus copy; read and write BC live. | Never out of sync, but every page load is slow, and projects 2–4 have nothing in Nexus to link to. |

The user picked **B**.

## Design

### Header fields (decided)

BC field names are from the `SalesOrder` page.

| Field | Rule |
|---|---|
| Order date (`Order_Date`) | Defaults to the day the order is created. |
| Document date, Posting date (`Document_Date`, `Posting_Date`) | Set to **today when Create invoice is clicked** (project 2). Until then, Nexus leaves them at BC's default. |
| Due date (`Due_Date`) | **Read-only, calculated by BC** from document date + payment terms. Nexus shows BC's value after each sync, so it updates when project 2 sets the invoice dates. |
| Requested delivery date | Blank by default; the rep can enter one. |
| Payment terms, Tax area code, Gen. bus. posting group, Customer posting group, Shipment method | **Dropdowns** of BC values synced into Nexus. Filled in from the customer profile when the customer is picked; the rep can change them for a one-off order. |
| Tax liable | **Switch.** Filled in from the customer profile, and can be changed for a one-off order. |
| Customer info: Address, Address 2, City, State, ZIP code, Country/Region, Contact no., Phone no., Mobile phone no., Email, Email CC | Filled in from the customer profile (BC's `Sell_to_*` fields and `EMailCCHCABG`). Each can be changed for a one-off order. Shown on the order, and carried onto the invoice. |
| Status | See "Status" below. |

**Dropdown lists:**
- Already synced from BC into Nexus (migration 053): payment terms, tax areas, customer posting groups, gen. business posting groups.
- Shipment methods: a new reference sync is needed, following migration 053's pattern.
- Customer fields (`tax_area_code`, `gen_bus_posting_group`, `customer_posting_group`, `payment_terms_code`, `email_cc`, `tax_liable`, phone, email) already exist on `business_central_customers`.
- Contact no. and mobile phone may need adding to the customer card fill. The builder checks.

### Status (decided)

A dropdown with colours: **Draft** (gray), **Final** (yellow), **Pulled** (orange), **Shipped** (blue), **Invoiced** (green).

- **Status is Nexus-only.** It never changes the BC order, which stays Open. Every status, including Draft, is synced to BC as a normal open order.
- Reps pick **Draft, Final and Pulled** by hand.
- **Shipped and Invoiced are set automatically** when project 2's Ship and Create invoice actions succeed in BC, and can't be picked by hand. In project 1 they show in the dropdown but are disabled.

### Order numbers, Customer PO and notes (decided)

- **External Document No. is the invoice number.** BC's `externalDocumentNumber` holds the number used as the invoice number in Nexus and in Bill.com (project 2 sends it as Bill.com's `invoiceNumber`).
  - It **defaults to the sales order number.** BC assigns that number on create, so the first sync creates the order and then sets `externalDocumentNumber` to the new number in the same run, unless the rep typed one.
  - The rep can change it.
  - This changes current practice: today reps put the customer's PO in this field (74/76 TEST orders).
- **Customer PO is a separate Nexus field.** It's stored in Nexus and **never sent to BC**. Project 2 sends it to Bill.com.
  - Bill.com's v3 invoice API documents no PO number field and no custom fields; the only free text is the per-line `description`.
  - Bill.com's own screens do show a PO number on invoices, so project 2 starts by testing in the Bill.com sandbox whether the API accepts one.
  - If it doesn't, **the user decides where the PO goes then.** The options already raised: the first line's description, or Bill.com's older API.
- **Notes:** a free-text field on the order, **stored in Nexus only** (my call). BC API v2.0 sales orders have no notes field and Bill.com invoices have no memo field.

### Sync state: separate from the order's business status

Each order carries a **sync state**, separate from where it is in the order-to-cash flow:

| Sync state | Meaning | What the rep sees |
|---|---|---|
| `pending` | Nexus has changes BC doesn't have yet | "Sending to BC…" |
| `synced` | BC matches Nexus | BC order number and BC's totals |
| `failed` | BC rejected the change or didn't answer; it will be retried | The error, plus "Try again" |
| `conflict` | The BC order changed outside Nexus since the last sync | "Changed in BC. Nexus stopped to avoid overwriting." No automatic retry. An **"Overwrite BC with Nexus's version"** button, shown after the rep confirms (decided), re-reads the BC order's current etag and sends Nexus's header and lines. That includes deleting BC lines Nexus doesn't have. Then the order returns to `synced`. Nexus never pulls BC's version back. |

The order's business status is the Draft → Invoiced dropdown above, and it is independent of sync state.

### What triggers a sync (no cron)

My call:
1. **Right after save.** The save action schedules the sync to run after the response goes back, using Next.js `after()`, so the rep isn't kept waiting.
2. **When the Sales Orders list loads.** Any order still `pending` or `failed` whose lease has expired gets picked up again, in small batches. This catches syncs that died with the server.
3. **"Try again"** on a failed order runs it now.

Each sync claims the order with a lease, using the same pattern as `billcom_customer_links.claimed_until`. That way two triggers never sync the same order at once.

### How a sync talks to BC

All calls go to the published `SalesOrder` and `SalesOrderSalesLines` OData pages. Orders are keyed by `Document_Type='Order'` + `No`; lines by `Document_Type` + `Document_No` + `Line_No`.

- **First sync (create):**
  - `POST SalesOrder` with the customer number and the header fields. BC assigns `No` and fills in the customer defaults.
  - Then `PATCH` the header with Nexus's values, so one-off overrides and External Document No. (the order number if the rep left it blank) win over BC's defaults.
  - Then `POST` each line.
  - Store the BC order number, the header etag and each line's `Line_No` and etag.
  - **No duplicates:** before creating, check whether a BC order already exists for this Nexus order and link it instead of making a second one. That covers the case where a create succeeded in BC but the response never reached Nexus. The builder picks the marker to match on, verified against TEST. One candidate is a page field Nexus can write and nobody else uses, such as `Posting_Description` if it isn't printed. Otherwise customer + order date + a recent creation time.
- **Later syncs (update):** compare the stored header etag with BC's current one first. If they differ, mark `conflict` and stop. Otherwise:
  - `PATCH` the header
  - add, change or delete individual lines by their stored `Line_No`
  - refresh the etags and BC's computed values
  - A sync interrupted halfway must be safe to re-run: lines with a stored `Line_No` are updated, lines without one are created.
- **After every successful sync,** read the order back and store what BC decided: number, due date, unit prices, line amounts, tax and totals.
- **Delete:** deleting a Nexus order deletes the BC order, if it exists and is still open, then removes the Nexus row. If the BC delete fails, the Nexus order stays and is marked `failed`.

### Prices

My call: if the rep leaves a line's price blank, BC fills it in (customer price group, etc.). Nexus shows the item's `unit_price` as an estimate, marked as an estimate, until the sync brings BC's price back. If the rep types a price, it's sent to BC as an override and kept.

### The order page

```
Sales Orders › SO-10234                         [ Final ▾ ] (yellow)   ● In BC
──────────────────────────────────────────────────────────────────────────────
Customer      [ C00125 – Acme Foods      ▾]   Invoice # (Ext. Doc No.) [ SO-10234 ]
Customer PO   [ PO-88812 ]  (Nexus + Bill.com only, not BC)

Customer info                                  Dates
  Address    [165 Kaiholu St      ]              Order date      [2026-11-13]
  Address 2  [                    ]              Requested deliv.[          ]
  City [Kailua] State [HI] ZIP [96734] [US ▾]    Document date   set at invoice
  Contact no.[CT101830] Phone [(808) 375-2976]   Posting date    set at invoice
  Mobile     [        ]                          Due date        2026-12-13 (BC)
  Email      [angela…@k12.hi.us]
  Email CC   [angela…@k12.hi.us]

Terms & posting
  Payment terms [Net 30 ▾]  Shipment method [Ground ▾]  Tax liable [on]
  Tax area [HI ▾]  Gen. bus. posting group [DOMESTIC ▾]  Customer posting group [DOMESTIC ▾]

  Item                          Qty    Unit price   Disc %   Amount incl. tax
  10023 – Tomato Sauce           48    24.50          5        1,250.77
  10031 – Pesto Jar              12    31.00 (est.)   0             —
  [ click to pick an item ▾ ]
                                              Subtotal             1,548.00
                                              Tax (from BC)          201.24
                                              Total                1,749.24
Notes
[ Customer called, wants delivery before 10am.                              ]
                                                         [Delete]  [Save]
```

- **Customer:** pick from synced BC customers, with blocked customers excluded. Picking one fills in the customer info, terms and posting fields from the customer profile (see "Header fields"). Re-picking a different customer refills them.
- **Ship-to (my call):** BC's ship-to fields are kept equal to the customer info. 75 of 76 TEST orders ship to the customer's own address, and the user's field list has no separate ship-to. A separate ship-to and BC's saved ship-to codes are out of scope.
- **Dimension 2 is dropped (my call).** It isn't in the user's field list and was used on only 5 of 76 orders. BC fills in any customer default dimension on its own.
- **Lines table (decided):** a table inside the order, built in the style of the purchase invoice items table (`InvoiceItemsTable` and `ItemPicker` in `src/components/invoices/InvoicesClient.tsx`).
  - **Columns:** Item, Qty, Unit price, Discount %, Amount incl. tax.
  - **Amount incl. tax is read-only.** It comes from BC's last sync and shows "—" until then.
  - **There is always one blank row at the bottom.** Clicking its Item field opens a searchable dropdown of synced, non-blocked BC items showing item number and name. Picking one turns it into a real line, and a new blank row appears.
  - Removing a line is a per-row delete.
  - The blank row is never saved or sent to BC.
- **Hidden line defaults (my call):** these aren't shown as columns but are still set on every BC line.
  - Unit of measure: the item's base unit.
  - Location: the org's usual location; the builder picks most-used-from-data or a setting.
- **Discount %** is sent to BC as the line's `Line_Discount_Percent`. Bill.com invoice lines have no discount field, so project 2 sends Bill.com the price after discount.
- **Totals and tax:** shown only from BC's last sync. While `pending`, they read "calculated when sent to BC".

The **Sales Orders list** shows: BC order number (or "Not yet in BC"), invoice # (External Document No.), customer, customer PO, order date, total and sync state, with filters for "needs attention" (`failed` + `conflict`).

### Permissions

My call: new flags `canViewSalesOrders` and `canEditSalesOrders`, which covers create, edit and delete. Admins get both by default; others get them per user, like the existing flags.

### Data

My call on shape; the builder finalizes names. Two new tables, one for order headers and one for order lines, each scoped by `organization_id` + `bc_connection_id`. They hold:
- the Nexus-entered fields above
- the BC ids (order id, line ids), BC number and etag
- BC's computed values
- sync state, last error, attempt count and `claimed_until`

RLS lets users read their own org's orders. All writes go through server actions using the service client.

## Notes for project 2 (not built here)

- Create invoice sets `Document_Date` and `Posting_Date` to today before posting, and reads BC's recalculated `Due_Date` back. On success it sets status to **Invoiced**; Ship sets **Shipped**.
- Shipping and invoicing together is the usual path, and the user also needs **ship only, then invoice later**.
- BC API v2.0 offers `shipAndInvoice` on sales orders but **no ship-only action**, and neither do the published OData pages. Ship-only will need a small BC extension or a published codeunit or page, a BC configuration task like publishing `CustomerTemplates` was. It must be sequenced before project 2 is built.

## Left to the builder

- How to mark a BC order so the "no duplicates" check can find it (see "How a sync talks to BC"), verified against TEST.
- Confirm against TEST that the `SalesOrder` and `SalesOrderSalesLines` pages accept insert, modify and delete over OData with the app's credentials. Also confirm that every field in "Header fields" is editable there. Anything that can't be set goes back to the user before being dropped.
- Batch size and lease length for the list-load sweep.
- How the default location is chosen.
- Table and column names.
