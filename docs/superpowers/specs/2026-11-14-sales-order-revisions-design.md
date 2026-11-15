# Sales Order Revisions (user test round 1): Design

**Date:** 2026-11-14
**Status:** Approved by the user (layout sketch and decisions approved in chat)
**Builds on:** `2026-11-13-sales-orders-design.md` and `2026-11-13-sales-order-pricing-design.md` (branch `feat/sales-orders`, TEST only)

## Intent

The user tested the sales order form and reported two bugs, a pricing complaint, and 19 layout changes. The goal is a form that is compact, shows real money numbers while typing, and never flags "Changed in BC" when nobody changed the order.

## Bugs and findings (measured on TEST, 2026-11-15)

1. **False "Changed in BC" (W-100531).**
   - Every older Nexus order's header etag in BC differs from the stored `bc_etag` (W-100523..W-100531).
   - An order synced minutes earlier (W-100532) still matches.
   - Line etags are unchanged.
   - Reads don't cause it: header GET, line list and salesDocuments list/get were all checked.
   - So something in BC re-saves sales headers in the background, at an unknown field and interval. A snapshot of all test headers is saved for a later diff.
   - Comparing the header etag is therefore not a usable "changed in BC" signal.
2. **Amount incl. tax and totals only appear after a BC sync.**
   - Nexus already holds BC's tax tables (053: tax areas, area lines, details by jurisdiction and tax group) and items carry `tax_group_code`.
   - Example: HI-HNL-WHSL → jurisdiction HI-HN-WHSL, which gives BC's $0.01 tax on $2.73.
3. **"Prices need a save to show"**
   - The estimate was already computed client-side from the price-list copy.
   - But it showed as small text under an empty field. Change 8 fixes this.

## Goals

- **G1. Conflict detection by values, not etag.**
  - After each sync, store a snapshot of the BC values of the fields Nexus manages, for the header and each line.
  - Before writing, compare BC's current values of exactly those fields with the snapshot.
  - Only a difference counts as "Changed in BC".
  - With no snapshot (orders synced before this change), the header check passes, and lines fall back to the existing line-etag check.
  - The PATCH etag always comes from the fresh GET at the start of the sync, as today.
- **G2. Live amounts.**
  - Each line's amount incl. tax, plus subtotal, tax and total, update as the rep types.
  - They use the estimated or typed price and discount, plus the tax rate from the order's tax area and the item's tax group.
  - After a sync, while the form is unchanged, BC's own numbers are shown.
- **G3. Layout and fields** (the user's numbered list):
  1. Delete and Save buttons move to the page header, left of the status pill.
  2. Status pill has smaller padding.
  3. All inputs, selects and textareas (including line cells) use the same background as the customer picker (`bg-background`) in both themes.
  4. Order date is in the top-right corner of the Order block.
  5. The Order block title reads "Order W-100531" (just "Order" before BC assigns a number).
  6. –7. and 18. The order shows no document, posting or due date (18 wins over 7; they appear on the invoice in project 2).
  8. Unit price and Disc % show their effective value as normal text in the field, editable. The effective value is the typed value if any, else BC's value from the last sync if the line is unchanged, else the estimate.
     - Only a value the rep changes is stored and sent to BC.
     - Clearing the field returns to "BC decides" (null) and shows the effective value again.
     - No helper text under the fields.
  9. Invoice # shows its value in the field.
     - **Auto** (`invoice_number` null): `<SO#>`, or `<SO#> / <Customer PO>` when the PO isn't blank, cut to 35 characters (BC's limit).
     - Before BC assigns a number, the field is empty with the placeholder "Set when sent to BC".
     - Typing makes it manual.
     - On leaving the field after a manual change, a dialog confirms: "You changed the invoice number from X to Y. Keep it?" with options Keep or Undo.
     - Clearing the field returns to auto.
     - BC's External_Document_No gets the same value (manual, else auto).
  10. Invoice # sits below Customer PO. The Order block is narrower, with Notes to its right.
  11. Shipment method moves below Invoice # and is renamed "Delivery method" (still BC's Shipment_Method_Code).
  12. Requested delivery date sits below Delivery method.
  13. Notes become timestamped entries, each shown as a card:
      - The card shows the author and the time, with an edit icon (inline edit) and a delete icon (with confirm).
      - Add, edit and delete save immediately, separately from the form's Save button.
      - Allowed in any status (as notes are today), for users with `canEditSalesOrders`.
      - On an unsaved new order the Notes panel says "Save the order to add notes."
      - The old single `notes` text becomes the first entry, in the migration.
  14. Below the Order block comes the lines block, renamed "Order Items", with the totals.
  15. Billing address shows as compact text with an edit icon (top right) that switches the card to the existing inputs.
  16. The Ship to card sits right of Billing address. It shows the chosen address as text, and its edit icon reveals the existing ShipToPicker.
  17. "Terms & posting" is renamed "Invoicing". It holds payment terms, tax area and tax liable.
  19. Gen. bus. posting group and customer posting group are not shown. They are still filled from the customer or ship-to and sent to BC.

## Non-goals

- Changing what syncs to BC (beyond the auto invoice # now including the PO).
- Finding and stopping BC's background re-save (diagnosis continues separately; G1 makes it harmless).
- Exact BC tax rounding. The estimate rounds tax once over the order. BC's numbers replace it after sync.

## Approaches considered (conflict fix)

- **A. Value snapshot of managed fields (chosen).** It ignores background re-saves of fields Nexus doesn't manage, and still catches a real edit by someone in BC.
- B. Ignore header etag, compare only lines. This misses real header edits in BC (customer, address, terms).
- C. Compare BC's current values with Nexus's current values. Wrong after a local edit, since every local edit would look like a conflict.

## Data (migration 063)

- `sales_orders.bc_snapshot jsonb` and `sales_order_lines.bc_snapshot jsonb`, both nullable.
- New table `sales_order_notes`:
  - columns: `id`, `organization_id`, `bc_connection_id`, `sales_order_id` (FK on delete cascade), `body text not null`, `created_by uuid`, `created_at`, `updated_by uuid`, `updated_at`
  - RLS select-by-org (the 053 pattern); writes go through server actions with the service client
  - The old `notes` column is copied in once (only where it's non-empty and the order has no notes yet). It is kept but no longer edited.

## Left to the builder

- The exact managed-field list for the snapshots. Header: the keys of `toBcHeaderPatch`, plus `Sell_to_Customer_No`, plus the page-42 readable `Ship_to_*` fields. Lines: the keys of `toBcLine` minus the document keys.
- The tax-rate function: sum, over the tax area's jurisdictions, of the latest `tax_below_maximum` effective on the order date for the item's tax group. The rate is 0 when the order isn't tax liable.
- Component split for the new cards (billing card, ship-to card, notes panel).
