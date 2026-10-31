# Customers ↔ BC — Design

Project #3 of 4 in the BC / Bill.com customer sync work:

1. Customer reference lists — done (`docs/superpowers/specs/2026-10-29-customer-reference-lists-design.md`).
2. Customer templates — done (`docs/superpowers/specs/2026-10-30-customer-templates-design.md`).
3. **Customers ↔ BC** — this document.
4. Customers ↔ Bill.com, matched on the BC customer number.

## Intent

Today customers are created and changed in BC; Nexus only mirrors them read-only (AR read sync, migration 041, `business_central_customers`, ~1,975 rows in TEST). The user wants to create, edit and delete customers from Nexus, with sales staff able to do it too, and with templates (project #2) filling in the settings a person shouldn't have to choose. The BC customer number BC assigns is what project #4 matches to Bill.com.

Success: from Nexus, a permitted user creates a customer from a template, edits any of the fields below, and deletes a customer; each change is in BC immediately; changes made in BC come into Nexus on Sync.

## Fields Nexus manages

| Field | On New customer form | Notes |
|---|---|---|
| Name | typed, required | |
| Invoice email (BC `E_Mail`) | typed, required | |
| Invoice email CC | typed | custom BC field `EMailCCHCABG` on `Customer_Card_Excel` |
| Phone no. | typed, required | |
| Address, Address 2, City, State (County), ZIP (Post code), Country | typed | |
| Payment terms | from template, editable, required | dropdown from project #1 list |
| Tax area | from template, editable, required | dropdown from project #1 list |
| No. series | from template only | used once, at create, to number the customer |
| Tax liable, Tax identification type | from template only | |
| Customer price group | from template only | may be empty |
| Customer posting group, Gen. bus. posting group | from template only | |
| Application method, Location, Contact type | from template only | |
| Blocked (blank / Ship / Invoice / All) | not on create (blank) | editable later |
| Credit limit (LCY) | not on create (0) | editable later |

"From template only" fields are not shown on the New customer form but **are** editable on the Edit customer form. Every field in the table is editable when editing, except No. series (creation-only) and the customer number.

## Behaviour

- **Who:** admins, plus users granted a new per-user permission **"Create and edit customers"** (`canEditCustomers`), default off for non-admins, ticked per person on the admin page (user's choice; no new role). Viewing still needs the existing `canViewCustomers`. Create, edit, delete and customer Sync all require `canEditCustomers` (Sync — *my call*; viewers keep the existing read sync if it is already exposed to them).
- **Where:** the existing Customers page gets a **New customer** button and an **Edit** action per customer; Edit also offers **Delete**.
- **New customer:** pick a template → its values pre-fill the form → user types name, emails, phone, address and may change payment terms / tax area → save creates the customer in BC with **all** template values applied (Nexus copies the template's fields itself; BC's API does not apply templates). BC assigns the number from the template's No. series. Nexus then stores the new customer in `business_central_customers`.
- **Edit:** like projects #1–2 — BC first, only changed fields, BC's message shown verbatim on failure, stale etag → re-read, re-apply changed fields, retry once (most recent change wins per field).
- **Delete:** confirm first ("Are you sure?"). BC refuses to delete a customer with ledger entries/invoices; Nexus shows BC's message and suggests setting Blocked to All instead (*my call*). On success the Nexus row is removed.
- **Sync:** the existing customer pull also fills the new columns (BC wins on difference, as today).
- **Price-group delete comes back:** remove the project #1 `deleteDisabledReason` on price groups; deleting is blocked while any customer or template uses the group (count live from BC, fail closed — same as payment terms).

## Constraints

- BC sources: standard API v2.0 `customers` (already used by the read sync) and the published OData page `Customer_Card_Excel` (135 fields, in TEST) for fields the API lacks (posting groups, price group, location, application method, credit limit, email CC, tax ID type). Which one each write goes to, and keeping one etag story, is the builder's design — but reads and writes must not fight (e.g. a stale etag from the other source).
- **Unknowns to probe first in BC TEST, with the user's OK before any write** (throwaway `ZZNEXUS…` customer, deleted afterwards):
  - How to get BC to number a new customer from a given No. series (e.g. set `No_Series` on create, or pick the next number via the existing `noSeriesClient`/`numberAssigner` code and send `No`). If neither works, stop and bring it back to the user.
  - Whether `Contact_Type` exists under another name on `Customer_Card_Excel`; if not, decide with the user.
  - That `Customer_Card_Excel` accepts PATCH/POST/DELETE, and BC's error when deleting a customer with entries.
- Every query scoped by `organization_id` + `bc_connection_id`; writes through the service-role client after the permission check; never touch production BC.
- Before production use, `Customer_Card_Excel` must be published there too (add to the BACKLOG production list).
- Another session commits to `main`; recheck the migration number (054 is the latest on 2026-10-30).
- User is a beginner: plain-language UI and errors.

## Decisions from design review

Items marked *(my call)* were decided by Claude, not the user; the user can overrule them.

1. **Partial create** *(my call)*: prefer creating with one call that carries every field. If BC forces two calls and the second fails, keep the customer (BC has used the number), store it in Nexus, and show "Created, but some settings weren't applied — open Edit to fix." Never auto-delete.
2. **Probe gate** *(my call)*: the plan stops after the BC TEST probe if BC can't be made to number from the template's series; no pre-approved fallback (computing numbers in Nexus risks clashing with customers made in BC). If `Contact_Type` isn't on the page, drop the field from Nexus and tell the user.
3. **Sync permission** *(my call)*: the existing customer/AR sync and its permission stay exactly as they are; it just fills the new columns. `canEditCustomers` gates create, edit and delete only.
4. **Delete and other data**: nothing in the database references `business_central_customers` (checked 2026-10-30), so a delete only removes that row. Rows for customers deleted directly in BC follow whatever the existing sync does today.
5. **Required fields on edit**: as in projects #1–2, create validates every field; edit validates only the fields the user changed, so an existing customer missing an email can still be edited.
6. **BC connection**: everything uses the active connection from `requireActiveBusinessCentralScope()`, like projects #1–2.

## Non-goals

- Ship-to addresses, contacts, dimensions, bank accounts, documents, statistics, and the ~100 other customer-card fields.
- Bill.com (project #4).
- Bulk edits or imports.
- A "Sales" role.

## Left to the builder

- Layout of the New/Edit customer forms (likely reuse `ReferenceEntryForm`-style rendering and the dropdown sources from projects #1–2).
- Whether customer saves reuse the project #1 engine (transport/merge/service) or the AR sync's customer code.
- Column names/types for the new fields on `business_central_customers`.
