# Shipment methods in Nexus + "Update Customer" (sales order changes, item #1)

Status: approved 2026-11-17 (short design).

## Why

The user's words: the delivery method "will be one off for the order but add a button to save to the customer like 'Update Customer'. Shipment methods should also be a table in nexus so users can create and edit on nexus and it syncs with BC."

## Already built (not part of this work)

- The order's Delivery method dropdown lists every BC shipment method (Nexus's synced copy, `business_central_shipment_methods`), and changing it affects only that order.
- The customer page already edits the customer's Shipment method and saves it to BC (`updateCustomerAction` → `updateCustomer`, diff-based).

## What gets built

1. **Shipment methods editable in Nexus.** In Customer lists → Shipment methods, the list changes from read-only to managed, the same as Payment terms:
   - add a method, edit its description, rename its code, delete it;
   - each change is written to BC (API v2 `shipmentMethods`) right away;
   - a delete is refused while customers or customer templates use the method ("Used by 3 customers and template RETAIL"), counted live from BC like Payment terms (`customers.shipmentMethodId`, template `Shipment_Method_Code`).
2. **"Update Customer" button** on the sales order, next to Delivery method:
   - shown only when the order's delivery method differs from the customer's saved default, and only to users who may edit customers;
   - clicking saves that method as the customer's default (BC customer card and Nexus's copy) through the existing customer update, changing nothing else on the customer;
   - it then says "Saved as W00007's default delivery method." and the button hides;
   - other orders are unchanged.

## Non-goals

- No other customer fields from the order (payment terms, tax area, location) — the user chose delivery method only.
- Ship-to addresses' own delivery methods are not touched by the button.
- No change to the delivery method dropdown or one-off behaviour.

## Approaches

- **Managed list through the existing customer-lists framework (picked).** Payment terms, tax areas and price groups already work this way (create/edit/rename/delete, live usage check before delete); shipment methods become one more managed list. Cheapest and consistent.
- A separate Nexus-only table synced to BC later: rejected — two sources of truth, and the framework already writes straight to BC.
- "Update Customer" writing BC directly: rejected — the customer update path already handles BC, Nexus's copy and its checks.

## Calls I made (Claude's)

- Button label: "Update Customer"; confirmation text as above; no confirm dialog (it changes one field and can be changed back on the customer page).
- Permission: the customer-edit permission (same as editing on the customer page).
- Delete usage counts customers and templates only (same as Payment terms); ship-to addresses and orders are not counted.
- First task checks live (read-only) that BC's `shipmentMethods` accepts create/patch/delete through the API and the exact field names on `customers` and the template page; the plan adjusts to what BC shows.

## Left to the builder

Exact placement of the button beside the field; the empty-state and error wording for the list, reusing the existing list UI's patterns.
