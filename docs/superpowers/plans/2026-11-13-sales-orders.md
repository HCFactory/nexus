# Sales Orders + Customer Ship-to Addresses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reps create and edit sales orders in Nexus, and each order syncs one way to TEST BC as a real BC sales order. Customers get ship-to addresses that sync both ways with BC.

**Architecture:**
- Orders live in Nexus tables. Save is instant and marks the order `pending`.
- A background sync (Next.js `after()`, plus a sweep when the list page loads) pushes each order to BC through the published OData pages `SalesOrder` and `SalesOrderSalesLines`, using the existing `ReferenceTransport`. Nexus then stores what BC calculated.
- Ship-to addresses mirror the BC page `ShipToAddresses`. They are written BC-first, like customer editing, and pulled during customer Sync.

**Tech Stack:** Next.js 16 App Router (server actions, `after` from `next/server`), React 19, Supabase Postgres with RLS, Vitest with jsdom. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-sales-orders-design.md`, the source of truth. It is supported by `.omc/specs/deep-interview-sales-orders.md`, which holds the acceptance criteria and transcript.

## Global Constraints

- All work runs against the org's **default BC connection** (TEST). Nothing in this plan may target production.
- Order writes use the OData pages, **never API v2.0 `salesOrders`**:
  - `SalesOrder`: page 42, key `Document_Type,No`
  - `SalesOrderSalesLines`: page 46, key `Document_Type,Document_No,Line_No`
  - `ShipToAddresses`: page 300, key `Customer_No,Code`
  - `Document_Type` is always `'Order'`.
- BC field names are used verbatim, exactly as listed in the Task 9 mapping table.
- Ship-to code: **at most 10 characters, uppercase**. `External_Document_No`: at most 35 characters.
- Statuses, in this order with these colours: `draft` gray, `final` yellow, `pulled` orange, `shipped` blue, `invoiced` green.
  - Labels: Draft, Final, Pulled, Shipped, Invoiced.
  - `shipped` and `invoiced` can't be chosen by hand.
- Draft is fully editable. From `final` onward, only `status` and `notes` can change. Only `draft` and `final` orders can be deleted.
- One permission level: `canEditSalesOrders` covers create, edit, unlock and delete. Ship-tos use the existing `canEditCustomers`.
- A blank line price means BC prices the line. A typed price is sent as `Unit_Price`.
- Tax, totals and due date are only ever shown from BC's read-back. Nexus never calculates them.
- Migrations must be re-runnable (`if not exists`, `drop policy if exists`). Every new table gets RLS select-by-org (the 053 pattern). All writes go through the service client.
- Customer PO and Notes are never sent to BC.
- UI copy:
  - Sync badges: "Sending to BC…", "In BC", "Failed: {error}", "Changed in BC".
  - Overwrite button: "Overwrite BC with Nexus's version", behind a confirm.

## Review Focus

1. **A rep saves an edit while that order's sync is running.** The edit must still reach BC, and the order must not show "In BC" until it does. *(Task 10: `local_version` test.)*
2. **BC rejects one line halfway through** (for example a blocked item). The order shows Failed with BC's message. Retrying must not duplicate the lines already created. *(Task 10: partial-failure test.)*
3. **The customer has no ship-tos and no location, and the company has no location set.** The order uses the billing address and sends no `Location_Code` at all, rather than `''`. *(Task 8: test.)*
4. **Ship-to code clashes past 9** (`-10` must still fit in 10 characters), and streets with punctuation or lowercase letters. *(Task 4: tests.)*
5. **Deleting an order that never reached BC, or one whose sync is running right now.** The first deletes locally only. The second is refused with "This order is being sent to BC. Try again in a moment." *(Task 11: tests.)*

---

## File Structure

```
nexus/supabase/migrations/060_add_sales_orders_and_ship_tos.sql   tables, customer columns, RLS
nexus/src/types/salesOrders.ts                                     shared row/DTO types
nexus/src/lib/auth/permissions.ts (+ .test.ts)                     two new flags
nexus/src/components/layout/AppNav.tsx                             "Sales orders" nav item
nexus/src/lib/businessCentral/customerReferences/definitions.ts    shipmentMethods list
nexus/src/lib/businessCentral/customers/customerFields.ts          shipment method, mobile
nexus/src/lib/businessCentral/customers/customerCardFill.ts        contact no, default ship-to
nexus/src/lib/businessCentral/shipTo/
    shipToSource.ts       SHIP_TO_SOURCE + field map
    shipToCode.ts         makeShipToCode
    shipToService.ts      BC-first save/delete/setDefault, pullShipTos
nexus/src/app/actions/shipToAddresses.ts                           ship-to server actions
nexus/src/components/customers/ShipToSection.tsx, ShipToDialog.tsx
nexus/src/lib/salesOrders/
    orderRules.ts         status transitions, locks, delete rule
    orderDefaults.ts      customer/ship-to → header defaults, location chain
    bcOrderMapping.ts     Nexus ↔ BC field mapping, read-back, change detection
    orderSync.ts          syncSalesOrder / deleteSalesOrderInBc
    orderClaim.ts         lease claim/release, sweep
nexus/src/app/actions/salesOrders.ts                               order server actions
nexus/src/components/salesOrders/
    StatusSelect.tsx, SyncBadge.tsx, SalesOrderLinesTable.tsx,
    ShipToPicker.tsx, SalesOrderForm.tsx, SalesOrdersList.tsx
nexus/src/app/(protected)/sales-orders/page.tsx, new/page.tsx, [id]/page.tsx
```

Tests sit next to each file as `*.test.ts(x)`, following the repo convention. Run them with `cd nexus && npm test -- <path>`.

---

### Task 1: Database tables and types

**Files:**
- Create: `nexus/supabase/migrations/060_add_sales_orders_and_ship_tos.sql`
- Create: `nexus/src/types/salesOrders.ts`

**Interfaces:**
- Produces: tables `sales_orders`, `sales_order_lines`, `customer_ship_to_addresses`, `business_central_shipment_methods`; new `business_central_customers` columns. TS types in `src/types/salesOrders.ts`:
  - `OrderStatus`, `SyncState`
  - `SalesOrderRow`, `SalesOrderLineRow`, `ShipToRow`
  - `ShipToValues`: the ship-to columns without ids or etag
  - `CustomerRow`: the `business_central_customers` columns the order uses
  - `OrderHeaderDefaults`: bill_*, ship_to_*, terms, `tax_liable`, `location_code`
  - `SalesOrderInput`: header fields + `lines: LineDraft[]` + optional `oneOffShipTo: { values: ShipToValues; saveToCustomer: boolean }`
  - `SalesOrderListRow`
  - `LineDraft` (shape in Task 12)

- [ ] **Step 1: Write the migration.** Every table has `id uuid pk default gen_random_uuid()`, `organization_id` and `bc_connection_id` (FKs on delete cascade, as in 053), `created_at` and `updated_at`.
  - `business_central_customers`: add columns `contact_no text not null default ''`, `mobile_phone_no text not null default ''`, `ship_to_code text not null default ''` and `shipment_method_code text not null default ''`.
  - `business_central_shipment_methods`: the exact column set of `business_central_customer_posting_groups` in 053 (`bc_id`, `bc_etag`, `bc_last_modified_at`, `last_synced_at`, `code`, `display_name`), unique `(organization_id, bc_connection_id, code)`.
  - `customer_ship_to_addresses`:
    - `customer_number text not null`, `code text not null check (char_length(code) <= 10 and code = upper(code))`
    - `name`, `address`, `address_2`, `city`, `state`, `post_code`, `country`, `contact`, `phone`, `email`, `tax_area_code`, `location_code` and `shipment_method_code`: each `text not null default ''`
    - `tax_liable boolean not null default false`, `bc_etag text`, `last_synced_at timestamptz`
    - unique `(organization_id, bc_connection_id, customer_number, code)`
  - `sales_orders`:
    - `status text not null default 'draft' check (status in ('draft','final','pulled','shipped','invoiced'))`
    - `customer_id uuid not null references business_central_customers(id)`, `customer_number text not null`
    - `order_date date not null`, `requested_delivery_date date`
    - `invoice_number text` (null means "use the BC order number"), `customer_po text not null default ''`, `notes text not null default ''`
    - billing: `bill_name`, `bill_address`, `bill_address_2`, `bill_city`, `bill_state`, `bill_post_code`, `bill_country`, `bill_contact_no`, `bill_phone`, `bill_mobile`, `bill_email`, `bill_email_cc`
    - ship-to: `ship_to_code` (`''` means one-off or billing), `ship_to_name`, `ship_to_address`, `ship_to_address_2`, `ship_to_city`, `ship_to_state`, `ship_to_post_code`, `ship_to_country`, `ship_to_contact`, `ship_to_phone`
    - terms: `payment_terms_code`, `tax_area_code`, `gen_bus_posting_group`, `customer_posting_group`, `shipment_method_code`, `location_code`
    - all of the above text columns are `text not null default ''`; plus `tax_liable boolean not null default false`
    - BC read-back: `bc_order_number text`, `bc_etag text`, `bc_create_marker text`, `bc_due_date date`, `bc_document_date date`, `bc_posting_date date`, `total_excl_tax numeric`, `total_tax numeric`, `total_incl_tax numeric`
    - sync: `sync_state text not null default 'pending' check (sync_state in ('pending','synced','failed','conflict'))`, `sync_error text`, `sync_attempts int not null default 0`, `claimed_until timestamptz`, `last_synced_at timestamptz`, `local_version int not null default 1`, `synced_version int not null default 0`
    - `created_by uuid references users(id) on delete set null`
    - indexes on `(organization_id, bc_connection_id, sync_state)` and `(organization_id, bc_connection_id, order_date desc)`
  - `sales_order_lines`:
    - `sales_order_id uuid not null references sales_orders(id) on delete cascade`, `organization_id`, `position int not null`
    - `item_number text not null`, `description text not null default ''`, `unit_of_measure_code text not null default ''`
    - `quantity numeric not null check (quantity > 0)`, `unit_price numeric` (null means BC prices it), `discount_percent numeric not null default 0 check (discount_percent between 0 and 100)`
    - `removed boolean not null default false` (a synced line waiting for its BC delete)
    - `bc_line_no int`, `bc_etag text`, `bc_unit_price numeric`, `amount_incl_tax numeric`
  - RLS: enable on all four new tables, with a select policy `organization_id in (select organization_id from public.users where id = auth.uid())`. `sales_order_lines` uses its own `organization_id`.
- [ ] **Step 2: Write `src/types/salesOrders.ts`.** It holds the `OrderStatus` and `SyncState` string unions plus row interfaces mirroring the columns above. Export `ORDER_STATUSES = ['draft','final','pulled','shipped','invoiced'] as const`.
- [ ] **Step 3: Verify.** Run `cd nexus && npx tsc --noEmit -p . 2>&1 | grep -v '^.next/'`. Expected: no new errors.
- [ ] **Step 4: Ask the user to apply 060** in the Supabase SQL editor (TEST project). Then run `select table_name from information_schema.tables where table_name in ('sales_orders','sales_order_lines','customer_ship_to_addresses','business_central_shipment_methods');`. Expected: 4 rows.
- [ ] **Step 5: Commit** `feat(sales-orders): add tables for sales orders, lines, ship-to addresses and shipment methods`.

### Task 2: Permissions and navigation

**Files:**
- Modify: `nexus/src/lib/auth/permissions.ts` (`ACCESS_KEYS`, `OVERRIDE_TO_ACCESS_KEY`, `ResolvedUserAccess`)
- Modify: `nexus/src/types/database.ts` (`PermissionOverrides`: `viewSalesOrders?`, `editSalesOrders?`)
- Modify: `nexus/src/components/layout/AppNav.tsx`
- Test: `nexus/src/lib/auth/permissions.test.ts`

**Interfaces:**
- Produces: `access.canViewSalesOrders`, `access.canEditSalesOrders`.

- [ ] **Step 1: Write failing tests.**
  - `resolveUserAccess({role:'admin', ...})` has both flags `true`.
  - A plain user has both `false`.
  - Override `{editSalesOrders: true, viewSalesOrders: true}` turns both on.
  - Override `{editSalesOrders: true}` alone gives `canEditSalesOrders` `true` but `canViewSalesOrders` `false`, and the actions check both (as `editScope` does for customers).
- [ ] **Step 2: Run** `npm test -- src/lib/auth/permissions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add both keys wherever `canEditCustomers` appears. Add the nav item `{ label: 'Sales orders', href: '/sales-orders', icon: ClipboardList }` as the first item in the Customers group, gated on `access.canViewSalesOrders`. Add both overrides to the admin user-permissions editor wherever `editCustomers` is listed.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sales-orders): add view/edit sales order permissions and nav item`.

### Task 3: Shipment methods list and new customer fields

**Files:**
- Modify: `nexus/src/types/customerReferences.ts` (`ListKey` + `'shipmentMethods'`)
- Modify: `nexus/src/lib/businessCentral/customerReferences/definitions.ts`
- Modify: `nexus/src/lib/businessCentral/customers/customerFields.ts`
- Modify: `nexus/src/lib/businessCentral/customers/customerCardFill.ts`
- Test: `definitions.test.ts`, `customerCardFill.test.ts`, `customerFields.test.ts`

**Interfaces:**
- Produces: `LIST_DEFINITIONS.shipmentMethods`; `getSelectOptions('shipmentMethods')`; customer columns filled from the card.

- [ ] **Step 1: Write failing tests.**
  - `LIST_DEFINITIONS.shipmentMethods` has `mode: 'readOnly'`, `source: {kind:'api', resource:'shipmentMethods'}`, and fields `code→code` (isKey, maxLength 10) and `display_name→displayName`.
  - `mapCardToCustomerColumns({etag:'e', fields:{Primary_Contact_No:'CT101830', MobilePhoneNo:'808', Ship_to_Code:'165KAIHOLU', Shipment_Method_Code:'GROUND'}})` includes `contact_no:'CT101830'`, `mobile_phone_no:'808'`, `ship_to_code:'165KAIHOLU'` and `shipment_method_code:'GROUND'`.
  - `CUSTOMER_FIELDS` contains `shipment_method_code` (bcName `Shipment_Method_Code`, type `select`, optionsFrom `shipmentMethods`) and `mobile_phone_no` (bcName `MobilePhoneNo`, text, maxLength 30, listHidden).
- [ ] **Step 2: Run** the three tests. Expected: FAIL.
- [ ] **Step 3: Implement** the definitions, fields and card mapping above.
  - `contact_no` and `ship_to_code` are filled but **not** added to `CUSTOMER_FIELDS`. The ship-to section edits the default, and contact no. stays read-only.
  - Show the shipment methods list on `/customer-lists` the same way posting groups appear.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run the existing suite under `src/lib/businessCentral/customers`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(customers): sync shipment methods; fill contact no, mobile, default ship-to and shipment method`.

### Task 4: Ship-to code generator

**Files:**
- Create: `nexus/src/lib/businessCentral/shipTo/shipToCode.ts`
- Test: `nexus/src/lib/businessCentral/shipTo/shipToCode.test.ts`

**Interfaces:**
- Produces: `makeShipToCode(street: string, taken: ReadonlySet<string>): string`

- [ ] **Step 1: Write failing tests** (exact values):
  - `makeShipToCode('165 Kaiholu St', new Set())` → `'165KAIHOLU'`
  - `makeShipToCode('99 dock rd.', new Set())` → `'99DOCKRD'`
  - `makeShipToCode('165 Kaiholu St', new Set(['165KAIHOLU']))` → `'165KAIHO-2'`
  - with `taken` = `165KAIHOLU` plus `165KAIHO-2` through `165KAIHO-9` → `'165KAIH-10'`
  - `makeShipToCode('', new Set())` → `'SHIPTO'`
  - `makeShipToCode('', new Set(['SHIPTO']))` → `'SHIPTO-2'`
  - Comparison is case-insensitive: `taken` = `{'165kaiholu'}` still yields `'165KAIHO-2'`.
  - Every result has length ≤ 10 and equals its uppercase form.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.** Base = uppercase, keep only `[A-Z0-9]`, cut to 10, and use `'SHIPTO'` when empty. If the base is taken, try `n = 2, 3, …` with `base.slice(0, 10 - String(n).length - 1) + '-' + n`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ship-to): generate 10-character ship-to codes from street addresses`.

### Task 5: Ship-to service (BC-first writes, pull from BC)

**Files:**
- Create: `nexus/src/lib/businessCentral/shipTo/shipToSource.ts`, `shipToService.ts`
- Test: `nexus/src/lib/businessCentral/shipTo/shipToService.test.ts`

**Interfaces:**
- Consumes: `ReferenceTransport` (`list/get/create/patch/remove`), `BcConflictError`, `CUSTOMER_CARD_SOURCE`, `makeShipToCode`.
- Produces:
  - `SHIP_TO_SOURCE = { kind:'odata', service:'ShipToAddresses', pageNumber:300, keyFields:['Customer_No','Code'] }`
  - `SHIP_TO_FIELDS`: column → BC map. `name→Name`, `address→Address`, `address_2→Address_2`, `city→City`, `state→County`, `post_code→Post_Code`, `country→Country_Region_Code`, `contact→Contact`, `phone→Phone_No`, `email→E_Mail`, `tax_area_code→Tax_Area_Code`, `tax_liable→Tax_Liable`, `location_code→Location_Code`, `shipment_method_code→Shipment_Method_Code`.
  - `interface ShipToDeps { supabase; transport; orgId; connectionId; now(): string }`
  - `saveShipTo(deps, input: { id?: string; customerNumber: string; code?: string; values: ShipToValues }): Promise<ShipToRow>`
  - `deleteShipTo(deps, id: string): Promise<void>`
  - `setDefaultShipTo(deps, customerNumber: string, code: string | ''): Promise<void>`
  - `pullShipTos(deps, customerNumber?: string): Promise<{ upserted: number; deleted: number }>`

**Latest-edit-wins (my call, from the spec's "builder picks a safe equivalent").** BC's `Last_Date_Modified` is a date with no time, so it can't order two edits made on the same day. Instead:
- Nexus writes reach BC immediately, at save time, so a Nexus save is always the latest edit at that moment. On an etag mismatch it re-reads the etag and overwrites.
- A pull always takes BC's version for any row whose BC etag differs from the stored one, because that BC change happened after Nexus last wrote or read it.

- [ ] **Step 1: Write failing tests** with a fake transport and the `fakeSupabase` helper style from `customerService.test.ts`:
  - **New ship-to, blank code:** calls `transport.create(SHIP_TO_SOURCE, {Customer_No:'C1', Code:'165KAIHOLU', Name:..., ...})` and inserts a local row with BC's etag.
  - **Code generation sees existing codes:** a local row `165KAIHOLU` for C1 → the new code is `'165KAIHO-2'`.
  - **Typed code** `'dock'` → sent as `'DOCK'`. A typed code longer than 10 characters → throws `'Ship-to code must be 10 characters or fewer.'` with no BC call.
  - **Update** sends only changed fields with the stored etag. On `BcConflictError`, it re-gets the etag and patches once more (Nexus wins), then stores the new etag.
  - **Delete** calls `transport.remove`, then deletes the row. If the row's code equals the customer's `ship_to_code`, it also patches the customer card `Ship_to_Code:''` and sets the local `ship_to_code = ''`.
  - **`setDefaultShipTo('C1','DOCK')`** patches `CUSTOMER_CARD_SOURCE` key `{No:'C1'}` with `{Ship_to_Code:'DOCK'}` using the stored `bc_card_etag`, then updates the local customer `ship_to_code` and `bc_card_etag`.
  - **`pullShipTos(deps,'C1')`** lists with filter `Customer_No eq 'C1'`. It inserts BC rows missing locally, updates rows whose etag differs, deletes local rows missing in BC, and leaves rows with an equal etag untouched.
  - **`pullShipTos(deps)`** with no customer lists all ship-tos and merges per customer the same way.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ship-to): BC-first ship-to save/delete/default and pull from BC`.

### Task 6: Ship-to actions and customer Sync hook

**Files:**
- Create: `nexus/src/app/actions/shipToAddresses.ts`
- Modify: `nexus/src/app/actions/businessCentralReceivables.ts`: after the card-fill block (~line 195–230), add a `pullShipTos` block that reports failures the same way as card fields.
- Test: `nexus/src/app/actions/shipToAddresses.test.ts`, `businessCentralReceivables.customers.test.ts`

**Interfaces:**
- Consumes: Task 5 functions; `requireActiveBusinessCentralScope`; `createReferenceTransport`.
- Produces (server actions):
  - `listShipTos(customerNumber: string): Promise<ShipToRow[]>` (view permission)
  - `saveShipToAction(input): Promise<{ok:true; row: ShipToRow} | Fail>`
  - `deleteShipToAction(id): Promise<{ok:true} | Fail>`
  - `setDefaultShipToAction(customerNumber, code): Promise<{ok:true} | Fail>`
  - `refreshShipTos(customerNumber): Promise<ShipToRow[]>`. It calls `pullShipTos(deps, customerNumber)`. On failure it logs, still returns the local rows, and never throws.

- [ ] **Step 1: Write failing tests.**
  - The write actions return `{ok:false, error:"You don't have permission to change customers"}` without `canEditCustomers`.
  - Customer Sync calls `pullShipTos` once with no customer number.
  - A `pullShipTos` failure appears in the results as `error: 'Ship-to addresses: <message>'` with `complete:false`, and the rest of the sync still finishes.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Mirror `customerEditing.ts` (`editScope`, `revalidateCustomers`).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ship-to): server actions and pull ship-tos during customer sync`.

### Task 7: Customer profile UI (Billing address and ship-to table)

**Files:**
- Create: `nexus/src/components/customers/ShipToSection.tsx`, `ShipToDialog.tsx` (+ tests)
- Modify: `nexus/src/components/customers/CustomerDetail.tsx`, `CustomerForm.tsx`, `nexus/src/app/(protected)/customers/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 6 actions; `getSelectOptions` for `taxAreas`, `locations` and `shipmentMethods`.
- Produces: `<ShipToSection customerNumber defaultCode rows canEdit options />`.

- [ ] **Step 1: Write failing component tests.**
  - The address fields (`address_line_1`, `address_line_2`, `city`, `state`, `postal_code` and `country`) render under a heading with text exactly `Billing address`, in both the detail view and the form.
  - `ShipToSection` renders a table with columns `Code`, `Name` and `City / State`, plus a ★ that is filled only on the row whose code equals `defaultCode`.
  - Clicking an empty ☆ calls `setDefaultShipToAction(customerNumber, code)`.
  - **+ Add** opens `ShipToDialog` with these fields: code (placeholder `Leave blank to use the street address`, maxLength 10), name, address, address 2, city, state, ZIP, country, contact, phone, email, tax area (select), tax liable (switch), location (select) and shipment method (select).
  - Save calls `saveShipToAction`. An `{ok:false}` result shows the error in the dialog.
  - Edit, delete and ★ are hidden when `canEdit` is false.
  - Delete asks for confirmation through the app's dialog component, not `window.confirm`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the existing `dialog`, `input`, `select` and `switch` UI components.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run `npm run lint`. Expected: clean.
- [ ] **Step 5: Commit** `feat(customers): label billing address and add ship-to address table`.

### Task 8: Order rules and defaults (pure)

**Files:**
- Create: `nexus/src/lib/salesOrders/orderRules.ts`, `orderDefaults.ts` (+ tests)

**Interfaces:**
- Produces:
  - `canChangeStatus(from: OrderStatus, to: OrderStatus): boolean`. Any of `draft`, `final` and `pulled` can move to another of those three. Nothing moves to or from `shipped` or `invoiced` by hand.
  - `editableFields(status: OrderStatus): 'all' | readonly ['status','notes']`
  - `canDelete(status: OrderStatus): boolean`: true only for `draft` and `final`.
  - `customerDefaults(customer: CustomerRow, defaultShipTo: ShipToRow | null, companyLocation: string): OrderHeaderDefaults` returns the bill_* fields, ship_to_* fields, terms fields, `tax_liable` and `location_code`.
  - `applyShipTo(header: OrderHeaderDefaults, customer: CustomerRow, shipTo: ShipToRow | null, companyLocation: string): OrderHeaderDefaults`
  - `todayIn(timeZone: string | null | undefined, now?: Date): string` (YYYY-MM-DD; same approach as `customerEditing.ts`'s `today`)

- [ ] **Step 1: Write failing tests.**
  - `canChangeStatus('final','draft')` → true; `('draft','shipped')` → false; `('invoiced','draft')` → false.
  - `editableFields('final')` → `['status','notes']`; `editableFields('draft')` → `'all'`.
  - `canDelete('pulled')` → false; `canDelete('final')` → true.
  - **Customer with default ship-to** DOCK (location `WH2`, tax area `HI-OAHU`, shipment method blank; customer location `MAIN`, shipment method `GROUND`):
    - `ship_to_code:'DOCK'`, ship-to address from DOCK
    - `tax_area_code:'HI-OAHU'`, `location_code:'WH2'`, `shipment_method_code:'GROUND'`
    - bill_* fields from the customer card, including `bill_email_cc` and `bill_contact_no`
  - **No ship-to:** `ship_to_code:''`, ship_to_* fields copied from the billing address, `tax_area_code` = customer's.
  - **Location chain:** no ship-to location and no customer location → `companyLocation`. All three blank → `location_code:''`, which Task 9 omits.
  - `applyShipTo(header, customer, null, 'MAIN')` resets to billing address, customer tax area and customer location.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sales-orders): status rules, locks and customer/ship-to defaults`.

### Task 9: BC mapping, read-back and change detection (pure)

**Files:**
- Create: `nexus/src/lib/salesOrders/bcOrderMapping.ts` (+ test)

**Interfaces:**
- Produces:
  - `SALES_ORDER_SOURCE`, `SALES_LINE_SOURCE` (OData sources per Global Constraints)
  - `createMarker(orderId: string): string` → `'NX-' + orderId.replace(/-/g,'').slice(0,12).toUpperCase()`
  - `toBcCreate(order): Record<string, unknown>` → `{ Document_Type:'Order', Sell_to_Customer_No, External_Document_No: createMarker(id) }`
  - `toBcShipToPatch(order)`. Sent first, because validating `Ship_to_Code` in BC refills the address, tax area and location:
    - `{ Ship_to_Code }` for a saved ship-to
    - otherwise `{ Ship_to_Code:'' }`
  - `toBcHeaderPatch(order, bcNumber: string)` sends everything else:
    - `Order_Date`, `Requested_Delivery_Date` (omit when null)
    - `External_Document_No: order.invoice_number ?? bcNumber`
    - `Sell_to_Address`, `Sell_to_Address_2`, `Sell_to_City`, `Sell_to_County`, `Sell_to_Post_Code`, `Sell_to_Country_Region_Code`, `Sell_to_Contact_No`, `Sell_to_Phone_No`, `SellToMobilePhoneNo`, `Sell_to_E_Mail`, `EMailCCHCABG`
    - `Ship_to_Name`, `Ship_to_Address`, `Ship_to_Address_2`, `Ship_to_City`, `Ship_to_County`, `Ship_to_Post_Code`, `Ship_to_Country_Region_Code`, `Ship_to_Contact`, `Ship_to_Phone_No`
    - `Payment_Terms_Code`, `Tax_Area_Code`, `Tax_Liable`, `Gen_Bus_Posting_Group`, `Customer_Posting_Group`, `Shipment_Method_Code`, `Location_Code` (omit when `''`)
    - It never includes `customer_po` or `notes`.
  - `toBcLine(orderNumber: string, line, locationCode: string)`:
    - `{ Document_Type:'Order', Document_No, Type:'Item', No: item_number, Quantity, Line_Discount_Percent, Unit_of_Measure_Code }`
    - plus `Unit_Price` only when `unit_price !== null`
    - plus `Location_Code` only when non-empty
  - `readBack(header: BcRecord, lines: BcRecord[])` returns:
    - `{ bc_order_number: No, bc_etag, bc_due_date: Due_Date, bc_document_date: Document_Date, bc_posting_date: Posting_Date, total_excl_tax, total_tax, total_incl_tax }`
    - The three totals come from the first line's `Total_Amount_Excl_VAT`, `Total_VAT_Amount` and `Total_Amount_Incl_VAT`, or `0` when there are no lines.
    - `lines: { bc_line_no, bc_etag, bc_unit_price: Unit_Price, amount_incl_tax: Amount_Including_VAT }[]`
  - `bcChangedOutsideNexus(stored: {bc_etag; lines: {bc_line_no; bc_etag}[]}, current: {header: BcRecord; lines: BcRecord[]}): boolean`. True if the header etag differs, any stored line's etag differs or is missing, or BC has a line number Nexus doesn't know.

- [ ] **Step 1: Write failing tests** covering each function with the exact field names above:
  - `toBcHeaderPatch` with `invoice_number: null` and bcNumber `'SO-1001'` → `External_Document_No:'SO-1001'`.
  - Keys `Customer_PO`, `notes` and `customer_po` never appear in any output.
  - `toBcLine` omits `Unit_Price` when null, and omits `Location_Code` when `''`.
  - `bcChangedOutsideNexus` is false for identical etags; true when one line's etag changed; true when BC has an extra line.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sales-orders): map orders to the BC SalesOrder page and read back BC values`.

### Task 10: Order sync engine

**Files:**
- Create: `nexus/src/lib/salesOrders/orderSync.ts` (+ test)

**Interfaces:**
- Consumes: Task 9; `ReferenceTransport`; `BcReferenceError`, `BcConflictError`.
- Produces:
  - `interface OrderSyncDeps { supabase; transport; orgId; connectionId; now(): string }`
  - `syncSalesOrder(deps, orderId: string, opts?: { overwrite?: boolean }): Promise<SyncState>`
  - `deleteSalesOrderInBc(deps, order: SalesOrderRow): Promise<void>`

**Flow** (the caller already holds the lease):
1. Load the order and its lines, and remember `version = local_version`.
2. **No `bc_order_number` yet:**
   1. Look for an earlier create that succeeded but never reported back: `transport.list(SALES_ORDER_SOURCE, {filter: "Document_Type eq 'Order' and External_Document_No eq '<marker>'"})` where the marker is `bc_create_marker ?? createMarker(id)`. If one is found, adopt it.
   2. Otherwise save `bc_create_marker`, then `create(toBcCreate)`.
   3. Store `bc_order_number` immediately.
3. **Has a number, and not overwrite:** `get` the header and `list` its lines (`Document_No eq '<no>'`). If `bcChangedOutsideNexus`, set `sync_state='conflict'`, `sync_error='Changed in BC'` and stop.
   - **With overwrite:** skip the check and use the fresh etags.
4. `patch` `toBcShipToPatch`, then `patch` `toBcHeaderPatch`, each time using the latest etag returned.
5. Lines:
   - `removed` rows with a `bc_line_no`: `remove`, then delete the row.
   - Rows without a `bc_line_no`: `create(toBcLine)`, and store `bc_line_no` and etag **immediately, per line**.
   - Rows with a `bc_line_no`: `patch` only when their BC fields differ.
   - With overwrite, BC lines unknown to Nexus are removed.
6. Re-read the header and lines, then write `readBack` values, `synced_version = version`, `last_synced_at`, `sync_error=null`, and `sync_attempts=0`.
   - `sync_state` = `'synced'` if `local_version` (re-read now) equals `version`, otherwise `'pending'`.
7. **Any thrown error:** `sync_state='failed'`, `sync_error = BcReferenceError.bcMessage ?? message`, and `sync_attempts + 1`. Whatever was already stored in steps 2 and 5 is kept.

`deleteSalesOrderInBc`: when `bc_order_number` is set, `get` the order for a fresh etag and `remove` it. If BC answers 404, treat the order as already gone.

- [ ] **Step 1: Write failing tests** with a fake transport that records calls:
  - **First sync:** `create` then the two patches; one line `create` per line; `External_Document_No` in the second patch equals the BC number when `invoice_number` is null; ends `synced` with totals from read-back.
  - **Lost response:** the order has a `bc_create_marker` and the BC list finds that marker → no `create` call, and the order is adopted.
  - **Edit during sync** *(Review Focus 1)*: the fake bumps `local_version` mid-sync → ends `pending` with `synced_version` = the starting version.
  - **Partial failure** *(Review Focus 2)*: the second line's `create` throws `BcReferenceError('Item 10031 is blocked')` → state `failed`, `sync_error` contains `Item 10031 is blocked`, and line 1 keeps its `bc_line_no`. A re-run creates only line 2.
  - **Conflict:** the stored header etag differs from BC's → `conflict`, and no patch calls.
  - **Overwrite on a conflicted order:** patches with the fresh etag and removes a BC-only line → `synced`.
  - **Removed line:** BC `remove` is called, then the local row is deleted.
  - **Customer PO and notes** are absent from every payload sent.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sales-orders): sync orders to BC with conflict detection and safe retries`.

### Task 11: Lease, sweep and server actions

**Files:**
- Create: `nexus/src/lib/salesOrders/orderClaim.ts`, `nexus/src/app/actions/salesOrders.ts` (+ tests)

**Interfaces:**
- Consumes: Tasks 8 to 10; `after` from `next/server`; `requireActiveBusinessCentralScope`.
- Produces:
  - `LEASE_MS = 120_000`, `SWEEP_BATCH = 5`
  - `claimOrder(supabase, orderId, nowIso): Promise<boolean>`: a conditional update setting `claimed_until = now + LEASE_MS` where `claimed_until is null or claimed_until < now`; true if a row came back.
  - `releaseOrder(supabase, orderId): Promise<void>`
  - `sweepPendingOrders(deps, limit = SWEEP_BATCH): Promise<number>`: picks the oldest `pending` or `failed` orders that are unclaimed, then claims, syncs and releases each one.
  - Actions:
    - `listSalesOrders(): Promise<SalesOrderListRow[]>`: schedules `after(() => sweepPendingOrders(...))`.
    - `getSalesOrder(id)`
    - `getSalesOrderFormContext(): Promise<{ customers; items; selectOptions; companyLocation; today }>`
      - items: non-blocked `business_central_items`, with `bc_item_number`, `display_name`, `unit_price` and `base_unit_of_measure_code`
      - selects: `paymentTerms`, `taxAreas`, `generalBusinessPostingGroups`, `customerPostingGroups`, `shipmentMethods`
    - `saveSalesOrder(input: SalesOrderInput): Promise<{ok:true; id} | Fail>`
    - `setSalesOrderStatus(id, status)`
    - `deleteSalesOrder(id)`
    - `retrySalesOrderSync(id)`
    - `overwriteBcWithNexus(id)`
  - **Company location (my call):** the most-used `location_code` across the org's customers, or `''`.

- [ ] **Step 1: Write failing tests.**
  - **No `canEditSalesOrders`:** every write returns `{ok:false, error:"You don't have permission to change sales orders"}`.
  - **`saveSalesOrder` on a `final` order** with a changed `customer_po` → `{ok:false, error:'This order is Final. Move it back to Draft to change it.'}`. Changing only `notes` succeeds.
  - **Successful save:** increments `local_version`, sets `sync_state='pending'`, and schedules `after` once.
  - **Lines:**
    - a removed line that has a `bc_line_no` is marked `removed=true`
    - a removed line without one is deleted
    - the blank row is never persisted (rows with no `item_number` are ignored)
  - **`setSalesOrderStatus(id,'shipped')`** → `{ok:false, error:'Shipped and Invoiced are set by the Ship and Create invoice buttons.'}`
  - **`deleteSalesOrder` on `pulled`** → `{ok:false, error:'Only Draft or Final orders can be deleted.'}`
  - **Delete with no BC number** → deletes locally, with no BC call *(Review Focus 5)*.
  - **Delete while claimed** → `{ok:false, error:'This order is being sent to BC. Try again in a moment.'}` *(Review Focus 5)*.
  - **Delete where BC delete fails** → the order is kept, set to `failed` with the error, and the action returns `{ok:false}`.
  - `claimOrder` returns false while another lease is live, and true after it expires.
  - `sweepPendingOrders` skips `conflict` and `synced` orders and handles at most 5.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `saveSalesOrder` sets `order_date` to `todayIn(connection.time_zone)` on create when not given.
  - `overwriteBcWithNexus` calls `syncSalesOrder(..., {overwrite:true})` under a claim.
  - Revalidate `/sales-orders` with `'layout'`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sales-orders): server actions, background sync trigger and sweep`.

### Task 12: Lines table

**Files:**
- Create: `nexus/src/components/salesOrders/SalesOrderLinesTable.tsx` (+ test)
- Reference: `ItemPicker` and `InvoiceItemsTable` in `nexus/src/components/invoices/InvoicesClient.tsx` (style and picker behaviour; extract `ItemPicker` into `src/components/items/ItemPicker.tsx` if it can be reused as is, otherwise copy its pattern)

**Interfaces:**
- Produces: `<SalesOrderLinesTable lines items locked onChange(lines) />`, where `LineDraft = { key: string; id?: string; item_number: string; description: string; quantity: number; unit_price: number | null; discount_percent: number; unit_of_measure_code: string; amount_incl_tax: number | null; estimate_price: number | null }`.

- [ ] **Step 1: Write failing tests.**
  - Headers are exactly `Item`, `Qty`, `Unit price`, `Disc %` and `Amount incl. tax`.
  - One blank row is always last. Clicking its Item cell opens a searchable list showing `number – name`. Typing `pesto` filters it.
  - Picking an item adds a line (qty 1, unit of measure = item base unit, `estimate_price` = item `unit_price`), and a new blank row appears.
  - With a blank price, the cell shows the estimate followed by `(est.)`. Typing a price sets `unit_price`.
  - **Amount incl. tax** is not an input. It shows `—` when null.
  - The per-row delete removes the line.
  - When `locked`, every input is disabled and there is no blank row.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sales-orders): lines table with always-blank item row`.

### Task 13: Order page

**Files:**
- Create: `nexus/src/components/salesOrders/StatusSelect.tsx`, `SyncBadge.tsx`, `ShipToPicker.tsx`, `SalesOrderForm.tsx` (+ tests)
- Create: `nexus/src/app/(protected)/sales-orders/new/page.tsx`, `[id]/page.tsx`

**Interfaces:**
- Consumes: Task 11 actions; Task 8 `customerDefaults`, `applyShipTo`, `editableFields`, `canChangeStatus`; Task 6 `refreshShipTos` and `saveShipToAction`; Task 12 table.
- Produces: the order page, matching the sketch in the spec's "The order page".

- [ ] **Step 1: Write failing tests.**
  - **StatusSelect:** shows the five labels with classes for gray, yellow, orange, blue and green. `Shipped` and `Invoiced` options are disabled.
  - **SyncBadge:** renders `Sending to BC…`, `In BC`, `Failed: <error>` with a `Try again` button, and `Changed in BC` with an `Overwrite BC with Nexus's version` button that asks for confirmation through the app dialog.
  - **Picking a customer:**
    - fills the Billing address fields (labelled `Billing address`), the terms fields, the tax liable switch and the default ship-to through `customerDefaults`
    - calls `refreshShipTos(customerNumber)` once
    - switching to another customer silently refills these fields, while lines, notes, customer PO and invoice # stay unchanged
  - **ShipToPicker:**
    - lists the saved ship-tos with ★ on the default, a `Billing address` option, and `One-off address…`
    - One-off shows the address fields and a `Save to customer` checkbox; when checked, saving the order first calls `saveShipToAction` and uses the returned code
  - **Invoice # (Ext. Doc No.):** placeholder `Same as order number`. Customer PO has the helper text `Nexus and Bill.com only, not sent to BC`.
  - **Dates:** document and posting date show `Set when invoiced`. Due date shows BC's `bc_due_date`, or `—`.
  - **Totals:** subtotal, `Tax (from BC)` and total come from read-back. While pending they show `Calculated when sent to BC`.
  - **Final order:** every field except Status and Notes is disabled. Delete shows only for Draft or Final, with a confirm step.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** The pages gate on `canViewSalesOrders` and render read-only without `canEditSalesOrders`.
- [ ] **Step 4: Run** the tests, then `npm run lint`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(sales-orders): order page with billing, ship-to, terms, status and sync state`.

### Task 14: Sales orders list

**Files:**
- Create: `nexus/src/components/salesOrders/SalesOrdersList.tsx` (+ test), `nexus/src/app/(protected)/sales-orders/page.tsx`

**Interfaces:**
- Consumes: `listSalesOrders`, `StatusSelect` colours, `SyncBadge`.

- [ ] **Step 1: Write failing tests.**
  - Columns: `Order #` (or `Not yet in BC`), `Invoice #`, `Customer`, `Customer PO`, `Order date`, `Total`, `Status` and `Sync`.
  - The `Needs attention` filter shows only `failed` and `conflict` orders.
  - A row click goes to `/sales-orders/<id>`.
  - `New sales order` shows only with `canEditSalesOrders`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sales-orders): sales orders list with needs-attention filter`.

### Task 15: Done test on TEST, and backlog

**Files:**
- Modify: `BACKLOG.md`

- [ ] **Step 1: Run the full checks.** `cd nexus && npm test && npm run lint && npm run build`. Expected: all pass. Then load the app with `npm run dev` and open `/sales-orders`. A passing build alone doesn't prove the app runs.
- [ ] **Step 2: Run the spec's done test in the browser against TEST.**
  1. Re-enter 5 real recent orders: one to a saved ship-to, one to a one-off ship-to with `Save to customer`, and one with a discount. Each must appear in TEST BC with every field matching, and BC's tax and totals must match Nexus.
  2. Edit a ship-to in BC, press customer Sync, and see it in Nexus. Edit a ship-to in Nexus and see it in BC.
  3. Change a synced order in BC, reopen it in Nexus, and see `Changed in BC`. Use Overwrite, and BC now matches Nexus.
  - Record the results under #5 in the backlog. Report any failure as a failure; don't mark it done.
- [ ] **Step 3: Update `BACKLOG.md`.**
  - Under #1 (go-live), add: publish `SalesOrder` (page 42), `SalesOrderSalesLines` (page 46) and `ShipToAddresses` (page 300) in production BC, and apply migration 060.
  - Under #5, mark project 1 done on TEST, and note that project 2 needs a BC ship-only action.
- [ ] **Step 4: Commit** `docs(backlog): sales orders project 1 done on TEST`.
