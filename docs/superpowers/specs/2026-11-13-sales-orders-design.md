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
- Line types other than Item, line discounts, invoice discounts, item variants and salesperson. None are used today; they can be added later.
- Partial quantities to ship. Not needed in project 1.

## Anti-goals: failures even if it "works"

- **Silently overwriting a change someone made in BC.** If the BC order changed since Nexus last synced it, Nexus must stop and flag it, never overwrite.
- **Duplicate BC orders.** A retried sync must never create a second BC order for the same Nexus order.
- **An order that looks fine in Nexus but isn't in BC,** or the reverse, with no visible sign.
- **Nexus calculating its own tax or totals** and showing numbers that differ from BC's.

## Constraints

- BC API v2.0 standard endpoints: `salesOrders` and `salesOrderLines`. The default BC environment is TEST for now. Clients are built from the database with `createBcClientForOrg`.
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

### Sync state: separate from the order's business status

Each order carries a **sync state**, separate from where it is in the order-to-cash flow:

| Sync state | Meaning | What the rep sees |
|---|---|---|
| `pending` | Nexus has changes BC doesn't have yet | "Sending to BC…" |
| `synced` | BC matches Nexus | BC order number and BC's totals |
| `failed` | BC rejected the change or didn't answer; it will be retried | The error, plus "Try again" |
| `conflict` | The BC order changed outside Nexus since the last sync | "Changed in BC. Nexus stopped to avoid overwriting." No automatic retry. An **"Overwrite BC with Nexus's version"** button, shown after the rep confirms (decided), re-reads the BC order's current etag and sends Nexus's header and lines. That includes deleting BC lines Nexus doesn't have. Then the order returns to `synced`. Nexus never pulls BC's version back. |

The business status in project 1 is just `open`. Project 2 adds statuses like shipped and invoiced.

### What triggers a sync (no cron)

My call:
1. **Right after save.** The save action schedules the sync to run after the response goes back, using Next.js `after()`, so the rep isn't kept waiting.
2. **When the Sales Orders list loads.** Any order still `pending` or `failed` whose lease has expired gets picked up again, in small batches. This catches syncs that died with the server.
3. **"Try again"** on a failed order runs it now.

Each sync claims the order with a lease, using the same pattern as `billcom_customer_links.claimed_until`. That way two triggers never sync the same order at once.

### How a sync talks to BC

- **First sync (create):** one `POST salesOrders` with the lines included, then store the BC order id, number, etag and the BC id of every line.
  - **No duplicates:** before creating, check whether a BC order already exists for this Nexus order and link it instead of making a second one. That covers the case where a create succeeded in BC but the response never reached Nexus.
  - **How to match:** the BC API v2.0 sales order has no free field for a Nexus id, so matching needs a marker. The builder picks the marker. One candidate is a fixed note on the order, if one is reachable; otherwise customer + PO number + order date + a recent creation time. The builder verifies against TEST and records the choice.
- **Later syncs (update):** compare the stored BC etag with the current one first. If they differ, mark `conflict` and stop. Otherwise:
  - `PATCH` the header
  - add, change or delete individual lines by their stored BC line id
  - refresh the etag and BC's computed values
  - A sync interrupted halfway must be safe to re-run: lines with a stored BC id are updated, lines without one are created.
- **After every successful sync,** read the order back and store what BC decided: number, unit prices, line amounts, tax, totals and status.
- **Delete:** deleting a Nexus order deletes the BC order, if it exists and is still open, then removes the Nexus row. If the BC delete fails, the Nexus order stays and is marked `failed`.

### Prices

My call: if the rep leaves a line's price blank, BC fills it in (customer price group, etc.). Nexus shows the item's `unit_price` as an estimate, marked as an estimate, until the sync brings BC's price back. If the rep types a price, it's sent to BC as an override and kept.

### The order page

```
Sales Orders › SO-10234                                   ● In BC
──────────────────────────────────────────────────────────────────
Customer      [ C00125 – Acme Foods          ▾]   Order date   [2026-11-13]
Customer PO   [ PO-88812     ]                    Requested    [2026-11-20]
Ship to       Acme Foods DC, 12 Main St, Toronto ON   (edit)
Payment terms [ Net 30 ▾]   Shipment method [ Ground ▾]   Dimension 2 [ ▾]

  Item                 Qty   UoM   Location   Unit price    Amount
  10023 Tomato Sauce    48   CS    MAIN       24.50          1,176.00
  10031 Pesto Jar       12   CS    MAIN       31.00 (est.)     372.00
  [+ Add line]
                                         Subtotal           1,548.00
                                         Tax (from BC)        201.24
                                         Total              1,749.24
                                        [Delete]  [Save]
```

- **Customer:** pick from synced BC customers, with blocked customers excluded. Picking one fills in ship-to address, payment terms and shipment method from the customer. All three can be changed.
- **Ship-to:** the customer's own address, which the rep can type over for a one-off. My call, from the data: 75 of 76 TEST orders ship to the customer's own address. Picking from BC's saved ship-to addresses ("Ship-to Codes") is out of scope. It would need a BC-published page, since the standard API doesn't expose them.
- **Shipment method and Dimension 2:** these dropdowns need two new synced reference lists, following migration 053's pattern. My call; Nexus doesn't sync either list yet.
- **Lines:** item (pick from synced, non-blocked BC items), quantity, unit of measure (defaults to the item's base unit), location (defaults to the org's usual location; my call is the most-used location from existing data or a setting, chosen by the builder) and an optional price override.
- **Totals and tax:** shown only from BC's last sync. While `pending`, they read "calculated when sent to BC".

The **Sales Orders list** shows: BC order number (or "Not yet in BC"), customer, customer PO, order date, total and sync state, with filters for "needs attention" (`failed` + `conflict`).

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

- Shipping and invoicing together is the usual path, and the user also needs **ship only, then invoice later**.
- BC API v2.0 offers `shipAndInvoice` on sales orders but **no ship-only action**. Ship-only will need a small BC extension or a published codeunit or page, a BC configuration task like publishing `CustomerTemplates` was. It must be sequenced before project 2 is built.

## Left to the builder

- How to mark a BC order so the "no duplicates" check can find it (see "How a sync talks to BC"), verified against TEST.
- Whether BC API v2.0 lets these be set on `salesOrders`, checked against TEST:
  - `shortcutDimension2Code`
  - `shipmentMethodId`
  - ship-to address fields
  - and `locationId` on `salesOrderLines`

  Anything that can't be set goes back to the user before being dropped.
- Batch size and lease length for the list-load sweep.
- How the default location is chosen.
- Table and column names.
