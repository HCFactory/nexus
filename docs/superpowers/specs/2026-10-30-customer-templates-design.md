# Customer Templates — Design

Project #2 of 4 in the BC / Bill.com customer sync work:

1. Customer reference lists — done (merged to `main` at 379b9e6).
2. **Customer templates** — this document.
3. Customers ↔ BC (the "New customer" form lives here).
4. Customers ↔ Bill.com, matched on the BC customer number.

## Intent

When a new customer is set up, most BC settings are the same for every customer of a given kind (wholesale, fundraiser, person…). BC keeps those in **customer templates**. The user wants to manage those templates in Nexus — the same way Nexus now manages payment terms, price groups and tax lists — so that project #3's New customer form can say "pick a template, fill in name / emails / phone / address" and get every other setting right.

Success: an admin can see, add, edit, rename and delete customer templates in Nexus; each change lands in BC immediately; changes made directly in BC come into Nexus with **Sync with BC**; the four existing BC TEST templates appear in Nexus unchanged after a first Sync.

## How the New customer form will use templates (context for project #3 — not built here)

The user described the customer form so the template fields are chosen correctly:

- **Typed in by hand each time:** Name (required), Invoice email → BC `E-Mail` (required), Invoice email CC → BC "Email CC", Phone no. (required), Address.
- **Starting value from the template, editable per customer, required:** Payment terms, Tax area code.
- **Set by the template only (not shown on the customer form):** No. series, Tax liable, Tax identification type, Customer price group, Application method, Location code, posting groups, contact type.

## Goals

A **Customer templates** list in Nexus (under Customer lists, alongside the project #1 lists) that manages exactly these fields:

| Nexus label | BC field (OData `CustomerTemplates`) | Input | Rules |
|---|---|---|---|
| Code | `Code` (Code[20]) | text | required, key, renamable (as in project #1) |
| Description | `Description` (Text[100]) | text | |
| Contact type | `Contact_Type` | fixed choice: Company / Person | required |
| No. series | `No_Series` (Code[20]) | dropdown from number series (see below) | required |
| Customer posting group | `Customer_Posting_Group` (Code[20]) | dropdown from project #1 list | required |
| Gen. bus. posting group | `Gen_Bus_Posting_Group` (Code[20]) | dropdown from project #1 list | required |
| Customer price group | `Customer_Price_Group` (Code[10]) | dropdown from project #1 list | **may be empty** (CUST-PERSON has none) |
| Payment terms (starting value) | `Payment_Terms_Code` (Code[10]) | dropdown from project #1 list | required |
| Tax area (starting value) | `Tax_Area_Code` (Code[20]) | dropdown from project #1 list | required |
| Tax liable | `Tax_Liable` | tick box | |
| Tax identification type | `Tax_Identification_Type` | fixed choice: Legal Entity / Natural Person | required |
| Application method | `Application_Method` | fixed choice: Manual / Apply to Oldest | required; new templates default to **Manual** |
| Location | `Location_Code` (Code[10]) | dropdown from project #1 locations | required |

"Required" above means Nexus requires it when saving from Nexus; all four existing templates have every one of these filled except price group on CUST-PERSON.

**Number series** — a new read-only list pulled from BC (`NoSeries`, 153 rows in TEST). The No. series dropdown offers only series whose **code contains `CUST`** (today: CUST, FUND-CUST, WHSL-CUST), plus whatever series a template already uses even if it breaks that rule, so an existing value never disappears from its own dropdown. The number series list itself does not need its own page in Nexus (user's call left open — see "Left to the builder").

## Behaviour

Everything in the project #1 spec (`docs/superpowers/specs/2026-10-29-customer-reference-lists-design.md`) applies unchanged unless stated here:

- **Admins only** may add, edit, delete or Sync; everyone in the org can view.
- **Manual Sync**; Sync pulls BC → Nexus, BC wins on any difference, rows gone from BC are removed from Nexus.
- **Saving writes to BC first**, sends **only the fields the admin changed**, shows BC's own error text on failure.
- **Most recent change wins** per field on a conflict (stale etag → re-read, re-apply only the changed fields, retry once).
- **After a create, read the record back** to store its current etag (lesson from project #1, commit 88e7419 — already in the shared engine).
- **Delete is always allowed.** BC does not record which template a customer was made from, so deleting a template never affects existing customers. No usage check.
- **Fields not in the table above are never sent to BC.** A template created from Nexus gets BC's own defaults for them; editing a template from Nexus never changes them. (The existing templates carry values like Allow line discount, Reserve, Shipping advice, Bank communication — those stay exactly as they are in BC.)

## Non-goals

- The New customer form, creating customers, or applying a template to a customer (project #3).
- Anything Bill.com (project #4).
- Managing number series (read-only pick list only).
- Exposing the ~60 other BC template fields (shipping, reminders, currency, Mexican tax IDs, etc.).
- Contact templates, vendor templates, item templates.
- Template dimensions (BC's "Dimensions" on a template).

## Anti-goals

- Nexus silently changing a BC template field the user never touched in Nexus — including on create, update, rename or sync.
- An existing template's current value vanishing from a dropdown (e.g. a series that doesn't contain `CUST`, or a price group later removed) and being blanked on the next save.
- Touching production BC. All development and live testing is in TEST.

## Constraints and existing code to build on

- Reuse the project #1 generic engine: `nexus/src/lib/businessCentral/customerReferences/` (definitions, transport, service, mapping, validation, merge, usage) and the generic list UI `nexus/src/components/customerReferences/ReferenceListClient.tsx` / `ReferenceEntryForm.tsx` and pages under `nexus/src/app/(protected)/customer-lists/`. Customer templates should be "one more list definition" wherever possible.
- The engine's select fields today only take options from another list (`optionsFrom`). Contact type, tax identification type and application method need **fixed option lists** — a small engine extension.
- BC sources: OData service `CustomerTemplates` (key `Code`) and `NoSeries` (key `Code`), both published in BC TEST by the user on 2026-10-30. Neither is in the BC API v2.0. Production will need the same two pages published before use there.
- New tables follow migration 053's pattern: `organization_id` + `bc_connection_id` scoping, RLS select-only for members, writes via the service-role client. Recheck the next free migration number right before creating it (053 is the latest on 2026-10-30; another session also adds migrations on `main`).
- BC TEST write behaviour on this page (duplicate create, stale etag, rename cascade, delete) has **not** been probed yet. Probe it in TEST with throwaway `ZZNEXUS…` codes before relying on it, and **ask the user before writing to BC TEST**.
- User is a beginner: plain-language UI text and errors.

## BC setup the user must do

- Done in TEST: `CustomerTemplates` (Customer Templ. Card) and `NoSeries` (No. Series) published as web services.
- Before production use: publish the same two pages under the same service names in production.

## Decisions from design review

Settled after a builder read-through. Items marked *(my call)* were decided by Claude, not the user — the user can overrule them.

1. **Templates count as "in use" for the project #1 lists.** The user's standing rule is "check usage before any delete". Deleting a payment term, tax area, customer posting group, gen. bus. posting group or location that any template uses is blocked with a plain message naming the template(s), the same way a jurisdiction in use is blocked. Count template usage from BC live (fail closed), consistent with project #1's usage counter. Price-group delete stays disabled until project #3 regardless.
2. **Renaming a referenced code** *(my call)*: BC carries a renamed code into the template fields that point at it (BC's normal rename behaviour — confirm with the TEST probe). After renaming a payment term, tax area, price group, posting group or location from Nexus, re-pull customer templates so Nexus matches, using the same follow-up-sync mechanism as project #1 (a failed follow-up is a warning, not a failed save).
3. **Sync on templates** *(my call)* also refreshes number series (one button, series first). It does not refresh the other project #1 lists — each has its own Sync. A template whose value isn't in Nexus's copy of a list (stale, or broken in BC) shows that value as-is in its dropdown and keeps it on save.
4. **BC data that breaks Nexus's rules** *(my call)*: Sync imports BC's values as they are, blanks included. As in project #1, a save validates only the fields the admin changed, so an untouched blank never blocks an unrelated edit; a create validates everything.
5. **Fixed choices** *(my call)*: use BC's exact values (as read from TEST: `Company`/`Person`, `Legal Entity`/`Natural Person`, `Manual`/`Apply to Oldest`; confirm spelling from the OData `$metadata`). Like list-based dropdowns, a current value not in the fixed list (including blank) is shown and kept.
6. **Create probe decides the create path.** The first build step probes, in BC TEST with a throwaway `ZZNEXUS…` template and the user's OK: create with only the 13 fields, edit one field, rename, stale-etag edit, delete; and checks that untouched fields keep BC's defaults. If BC refuses a create with only these fields, stop and bring it back to the user rather than inventing a copy-from-template design.
7. **Number series** *(my call)*: scoped per organization + BC connection like every other list; the `CUST` match is case-insensitive.

## Left to the builder

- Whether the number series list gets its own read-only page under Customer lists, or is only a hidden pick list synced along with templates (Sync on templates must refresh it either way, or it needs its own Sync).
- Exact option-value spelling for the three fixed choices (take them from BC's actual values: `Company`/`Person`, `Legal Entity`/`Natural Person`, `Manual`/`Apply to Oldest`).
- Whether the templates list shows all columns or a subset with the rest in the edit form (the table has 13 fields; mind phone width).
- Database column names and types.
