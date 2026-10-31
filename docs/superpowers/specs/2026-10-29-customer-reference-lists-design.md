# Customer Reference Lists — Design

**Date:** 2026-10-29
**Status:** Draft, awaiting approval
**Project:** 1 of 4 in the customer-sync work (see "Where this fits")

## Intent

The user wants customers to be created in Nexus and then appear in Business Central and Bill.com
with the same details, with edits in any system syncing back (most recent change wins). A BC
customer can't be created properly without the lists its fields point at: payment terms, tax areas,
price groups, posting groups and locations. This project makes those lists available in Nexus so
the later projects have something to pick from. It is also the lowest-risk place to prove two-way
Nexus ↔ BC syncing before real customers depend on it.

## Where this fits

The customer-sync work was split into four projects, built in order, each with its own
design → plan → build:

1. **Customer reference lists** — this document.
2. Customer templates — managed in Nexus, synced to BC's template list.
3. Customers ↔ Business Central — create/edit in Nexus, number from template or number series, full
   field set written to BC, BC edits pulled back.
4. Customers ↔ Bill.com — matched on the BC customer number (Bill.com account number), one-time
   load of ~1,975 customers, billing + shipping addresses, Bill.com edits pulled back by polling.

Decisions already made for later projects are recorded in [Decisions for later projects](#decisions-for-later-projects).

## Goals

Two groups of lists, all scoped per BC environment (TEST and production keep separate lists, like
item categories today).

**Managed in Nexus, synced both ways with BC:**

| List | BC source | Reachable today? |
|---|---|---|
| Payment terms | standard API v2.0 `paymentTerms` | Yes — verified |
| Tax areas | standard API v2.0 `taxAreas` | Yes — verified |
| Customer price groups | published page **7** | No — user publishes |
| Tax area lines (jurisdictions in an area) | published page — number to confirm | No — user publishes |
| Tax jurisdictions | published page — number to confirm | No — user publishes |
| Tax details (rates per jurisdiction + tax group) | published page — number to confirm | No — user publishes |

**Tax areas are managed fully (user decision, after review).** In US BC a tax area calculates
nothing on its own: it lists tax jurisdictions (Tax Area Lines), and the rates live in Tax Details
per jurisdiction and tax group. A Nexus-created area with only code and description would calculate
no tax, so Nexus manages the whole chain: tax areas, their jurisdiction lines, tax jurisdictions,
and tax details. The standard API exposes only `taxAreas`; the other three need published pages,
whose numbers the builder confirms. Tax groups are already copied read-only from BC
(`business_central_tax_groups`) and are reused as the pick list for tax details.

This is the riskiest part of the project: a wrong rate miscalculates tax on real invoices. The
builder should treat tax details with the same care as anything that touches money — validate rates
and effective dates, and show the user what will change in BC before writing.

**Read-only copies pulled from BC, to pick from:**

| List | BC source | Reachable today? |
|---|---|---|
| Locations | standard API v2.0 `locations` | Yes — verified |
| Customer posting groups | published page **110** | No — user publishes |
| Gen. bus. posting groups | published page **312** | No — user publishes |

"Verified" means a read-only call against the BC TEST environment on 2026-10-29 returned rows.
Fields returned:

- `paymentTerms`: `id, code, displayName, dueDateCalculation, discountDateCalculation, discountPercent, calculateDiscountOnCreditMemos, lastModifiedDateTime`
- `taxAreas`: `id, code, displayName, taxType, lastModifiedDateTime`
- `locations`: `id, code, displayName, contact, addressLine1, addressLine2, city, state, country, postalCode, phoneNumber, email, website, lastModifiedDateTime`

`customerPriceGroups`, `customerPostingGroups` and `generalBusinessPostingGroups` returned
"No HTTP resource was found" from the standard API, confirming they need published pages.
The page numbers 7, 110 and 312 are believed correct and must be confirmed once published.

## Behaviour

### Pages

Each list gets its own simple page in Nexus (list + create/edit form for the managed lists; list
only for the read-only ones), each with a **Sync with BC** button.

### Who can change things

**Admins only** can create, edit or delete entries in the managed lists, and can press Sync. A
wrong change goes straight into BC and affects every customer that uses it. Non-admins may view.

### Saving in Nexus → BC

A create or edit in Nexus is written to BC **immediately**, as part of the save. If BC rejects it,
the save fails with BC's reason and Nexus is left unchanged — Nexus never holds a managed entry BC
doesn't have.

### Deleting

The user's intent: never delete something that's still in use. The builder check found BC most
likely does **not** protect these lists — deleting a payment term, tax area or price group in BC
succeeds even when customers use it, leaving dangling references. So Nexus checks usage itself.

**Decision (user): check usage first.**

1. Before deleting, Nexus checks whether anything uses the entry and, if so, blocks the delete and
   says how many and what (e.g. "Used by 12 customers").
   - Payment terms and tax areas: checked against the BC customers Nexus already mirrors
     (`payment_terms_id`, `tax_area_id` on the customer table from migration 041). The check should
     run against fresh data — the builder decides whether that means pulling customers first or
     querying BC directly.
   - Tax jurisdictions: blocked while any tax area line or tax detail uses them. Tax details and
     tax area lines are children and may be deleted freely by an admin.
   - Customer templates (project 2) count as users too once they exist.
2. If nothing uses it, Nexus deletes in BC. If BC still refuses, Nexus refuses and shows BC's reason.
3. Only after BC confirms is the Nexus row removed.

**Claude's call:** price groups are not in the mirrored customer data today, so **deleting a price
group is disabled** until project 3 brings that field into Nexus, with a note saying so. Delete it in
BC meanwhile if needed.

### Pulling BC → Nexus

**Manual for now.** The Sync button pulls the list from BC. Nothing runs on a schedule (matching
every other BC sync in Nexus today).

- New in BC → added to Nexus.
- Changed in BC → updated in Nexus, subject to the conflict rule below.
- Deleted in BC → removed from Nexus.

### Conflicts: most recent change wins

Applied field by field, in both directions:

- **Nexus save after a BC edit:** only the fields the admin changed are sent, so they win; BC's edits
  to other fields are kept. Details in [Decisions from design review](#decisions-from-design-review).
- **BC edit after a Nexus save:** picked up on the next Sync; BC's newer value wins.

### Read-only lists

Pulled on Sync, replaced to match BC. Never written to BC.

## Non-goals

- **Payment terms in Bill.com.** Dropped from this project — see below.
- Customer templates, customers, and anything Bill.com (projects 2–4).
- Scheduled / automatic syncing.
- Creating or editing posting groups or locations in Nexus. Posting groups route real general
  ledger entries; a mistake there is not self-healing. The user chose read-only copies.

## Anti-goals

- A managed entry existing in Nexus but not in BC (or vice versa after a successful sync).
- Nexus deleting something BC would have refused to delete.
- Silently losing an edit made in BC to a field the Nexus admin never touched.

## Why Bill.com payment terms were dropped

Checked against Bill.com's v3 docs and the user's sandbox on 2026-10-29. Bill.com payment terms are
just `name` + `daysDue`; `daysDue` must be unique per organization; terms **can never be deleted**;
and they attach to invoices, not customers. BC TEST's 16 terms include `CM` (end of current month)
and two `1M` terms with a 2% / 8-day discount — none representable as a fixed day count, and the
two `1M` terms would collide on uniqueness. The sandbox already has Net 10/15/30 and Due upon
receipt.

**Decision (user):** piece E sends each invoice's exact due date as already calculated by BC, so no
payment-term list needs to exist in Bill.com.

## Constraints and existing code to build on

- **Read-only reference copies already exist** for item lists:
  `nexus/src/lib/businessCentral/referenceRegistry.ts` (`BUSINESS_CENTRAL_REFERENCE_RESOURCES`),
  refreshed by an action in `nexus/src/app/actions/businessCentralItems.ts`. The read-only lists
  here should follow that pattern.
- **Published-page precedent:** `nexus/src/lib/businessCentral/noSeriesClient.ts` consumes page 457
  as an OData web service and throws a clear "publish page 457 as … named …" error when it is
  missing. The three new pages should behave the same way.
- **BC writes with concurrency control already exist** for items (`createItem`, `updateItem` /
  `deleteItem` with `If-Match` etag) in `nexus/src/lib/businessCentral/client.ts`.
- **Environment scoping:** `requireActiveBusinessCentralScope()` in
  `nexus/src/lib/businessCentral/environmentScope.ts`.
- **Admin check:** existing actions gate on `access.isAdmin` (e.g. `nexus/src/app/actions/billcom.ts`).
- **Migrations:** next free number is 053 (047–052 are Friends & Family; recheck before writing, another session is adding migrations in parallel).
  Recent migrations have failed on partial re-apply (039, see BACKLOG); new ones should be
  re-runnable.

## Decisions from design review

- **Codes can be renamed in Nexus (user).** A rename is sent to BC, and BC carries the new code into
  every record that uses it, exactly as a rename made in BC would. The builder must confirm in BC
  TEST that a rename works through each route — the standard API (`code` PATCH on `paymentTerms`,
  `taxAreas`) and the published OData pages (a key-field PATCH) — before relying on it. Nexus
  matches its rows to BC by BC's `id` where the API provides one, so a rename doesn't look like a
  delete plus an add. For page-based lists without an `id`, a rename done in Nexus updates the
  Nexus row in place; a rename done directly in BC shows up on Sync as old code removed, new code
  added (acceptable — nothing in Nexus links to those rows by code). Renames are not blocked by the
  "in use" check — BC carries them through; only deletes are blocked.
- **Most recent change wins, field by field (user).** A Nexus save sends BC **only the fields the
  admin actually changed**. So when someone edits in BC and an admin later saves in Nexus:
  - fields the admin changed → Nexus's value wins (it's the more recent change);
  - fields the admin didn't touch → BC's edit is kept.

  If BC answers 412 (its etag moved since Nexus last read the entry), Nexus re-reads the entry from
  BC, re-applies only the admin's changed fields, and saves again. After a successful save Nexus
  stores BC's returned record, so Nexus and BC agree. This replaces the "reject and sync first"
  rule considered earlier.
- **Sync pull: BC wins on any difference (Claude's call, user agreed).** Every Nexus save is written
  to BC immediately, so at Sync time BC always holds the latest of both sides; any difference must
  be a newer BC edit. This also covers page 7, which has no modified timestamp. Timestamps are kept
  for display only.
- **Price group deletes disabled until project 3 (Claude's call, user agreed)** — see Deleting.

## BC setup the user must do

In each BC environment, publish as OData web services (same place page 457 was published):

- Page 7 — Customer Price Groups
- Page 110 — Customer Posting Groups
- Page 312 — Gen. Business Posting Groups
- The pages for Tax Area Lines, Tax Jurisdictions and Tax Details (numbers confirmed by the builder)

The builder confirms each works after publishing and records the service names used.

## Left to the builder

- Table and column design, and whether managed lists share one table or get one each.
- Exact page layout and where the pages sit in the nav.
- Field set per list beyond code + description (carry what BC returns that a customer needs).
- How conflict timestamps are stored.
- Web service names for the published pages.

## Decisions for later projects

Recorded so they are not relitigated:

- Customer number is the BC customer number on every platform; Bill.com matches on it (account
  number field). No duplicates.
- Required to create a customer: name, email, customer number. Number comes from a number series
  or a customer template, like BC.
- Customer fields synced: name, email, phone, billing address, shipping address, payment terms,
  customer number. BC's single address = shipping address; billing address lives in Nexus and
  Bill.com.
- Templates are managed in Nexus and synced to BC. Template fields: no. series, tax liable, tax
  area code, customer price group, tax identification type, gen. bus. posting group, customer
  posting group, payment terms, location code, allow line discount.
- **Piece E:** invoice due dates are sent to Bill.com as calculated by BC; no Bill.com payment
  terms list.
