# Shipment Methods + Update Customer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shipment methods become a managed (create/edit/rename/delete, synced to BC) customer list, and the sales order gets an "Update Customer" button that saves the order's delivery method as the customer's default.

**Architecture:** Flip `shipmentMethods` in the customer-lists framework from `readOnly` to `managed` (the framework already writes managed lists to BC and runs a live usage check before delete). Add one server action that runs the existing diff-based `updateCustomer` with only `shipment_method_code` changed, and a button in `SalesOrderForm` that calls it.

**Tech Stack:** Next.js 16 server actions, React 19, Supabase, Vitest + Testing Library, BC API v2.

**Spec:** `docs/superpowers/specs/2026-11-17-shipment-methods-update-customer-design.md`

## Global Constraints

- Button label "Update Customer"; success text `Saved as <customer number>'s default delivery method.`
- Button shown only when the order's delivery method ≠ the customer's saved `shipment_method_code`, and only when `canSaveShipTo` (= `access.canEditCustomers`).
- Only `shipment_method_code` changes on the customer; nothing else.
- Delete is refused while used: `Used by …` from customers (`shipmentMethodId`) and templates (`Shipment_Method_Code`), counted live from BC.
- TEST BC only for the live check.

## Review Focus

1. Blank delivery method on the order (customer has one) → button still shows and clears the customer's default only if the rep means it; pinned: button saves `''` correctly (Task 3 test `saves a blank method`).
2. A customer row changed by someone else since the page loaded → only `shipment_method_code` is sent (diff from a fresh server read, not the page's copy); pinned by Task 2 test `diff from a fresh read`.
3. No permission → the action refuses (not just the button hidden); Task 2 test `refused without customer edit`.
4. Renaming a method's code in Nexus → orders and customers that use it keep working (BC renames the key and keeps references); checked live in Task 4.
5. Draft order with no customer yet → no button; Task 3 test `no customer, no button`.

---

### Task 1: Shipment methods become a managed list

**Files:**
- Modify: `nexus/src/lib/businessCentral/customerReferences/definitions.ts` (shipmentMethods entry)
- Modify: `nexus/src/lib/businessCentral/customerReferences/usage.ts` (switch)
- Test: `definitions.test.ts`, `usage.test.ts`

- [ ] Tests first: in `definitions.test.ts` the read-only list becomes `['customerPostingGroups', 'generalBusinessPostingGroups', 'locations', 'noSeries']`, and `LIST_DEFINITIONS.shipmentMethods` is `mode: 'managed'` with `code` (required, key, max 10) and `display_name` (max 50… use 100 as today) editable. In `usage.test.ts`, a `shipmentMethods` row counts with `countCustomersAndTemplates('shipmentMethodId', 'Shipment_Method_Code', row)` (assert the customers filter `shipmentMethodId eq <bcId>` and the template filter `Shipment_Method_Code eq '<code>'`).
- [ ] Run, see them fail; implement (`mode: 'managed'`, fields editable with `required: true` on code; add the `case 'shipmentMethods'`); run green.
- [ ] Commit `feat(customers): shipment methods are a managed list synced to BC`.

### Task 2: `setCustomerDeliveryMethod` server action

**Files:**
- Modify: `nexus/src/app/actions/customerEditing.ts`
- Test: `nexus/src/app/actions/customerEditing.test.ts`

**Interfaces:**
- Produces: `setCustomerDeliveryMethod(customerId: string, shipmentMethodCode: string): Promise<{ ok: true } | { ok: false; error: string }>`

- [ ] Tests: `refused without customer edit` (editScope null → `{ ok:false, error: NO_PERMISSION }`, no update); `diff from a fresh read` — loads the customer row on the server and calls `updateCustomer(deps, { id, original: row, edited: { ...row, shipment_method_code: 'GROUND' } })`; unknown customer → `{ ok:false, error: 'Customer not found.' }`. No Bill.com push (shipment method isn't sent to Bill.com).
- [ ] Implement using the same row load the customer edit form uses (find it in `customerEditing.ts`/customer service; reuse, don't duplicate); `revalidatePath` for the customer and sales-order pages.
- [ ] Commit `feat(customers): save a customer's default delivery method`.

### Task 3: "Update Customer" button on the sales order

**Files:**
- Modify: `nexus/src/components/salesOrders/SalesOrderForm.tsx` (beside the Delivery method select, ~line 770)
- Test: `nexus/src/components/salesOrders/SalesOrderForm.test.tsx`

- [ ] Tests: `shows Update Customer when the order's method differs and saves it` (customer default `''`, pick `GROUND`, click → action called with `(customerId, 'GROUND')`, then text `Saved as W00389's default delivery method.` and button gone); `hidden when the method matches the customer`; `hidden without canSaveShipTo`; `no customer, no button`; `saves a blank method`; an error from the action shows in place.
- [ ] Implement: compare `header.shipment_method_code` with the current customer's `shipment_method_code` (from `context.customers`); after success, remember the saved code locally so the button hides without a reload, and `router.refresh()`.
- [ ] Commit `feat(sales-orders): Update Customer saves the order's delivery method to the customer`.

### Task 4: Full suite + live check on TEST

- [ ] `npx vitest run`, `npx tsc --noEmit`, `npx eslint src` all clean.
- [ ] Browser (TEST): Customer lists → Shipment methods: add `NXTEST` "Nexus test", rename description, rename code to `NXTEST2`, delete it (each confirmed in BC by re-sync); try deleting a method used by customers → refused with "Used by …". Sales order W-100533 (or a draft): change Delivery method → Update Customer → customer page shows the new method; set it back.
- [ ] Record results in the spec's notes section; commit.
