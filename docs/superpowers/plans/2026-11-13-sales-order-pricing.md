# Sales Order Pricing (Customer Price Groups) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The order form estimates each blank-price line at the price BC will charge (customer price group, customer or all-customers price lists). Rep-untyped discounts no longer overwrite BC's price-list discounts.

**Architecture:** BC price list lines are copied into a Nexus table during customer Sync. A pure `bestPrice` function mirrors BC's best-price rule. The order form uses it for the estimate. `discount_percent` becomes nullable, null meaning BC decides, and BC's discount is read back.

**Tech Stack:** Next.js 16, Supabase, Vitest. Branch `feat/sales-orders` (continues the sales-orders work).

**Spec:** `docs/superpowers/specs/2026-11-13-sales-order-pricing-design.md`

## Global Constraints

- Price lists are read-only copies. Nothing is written to BC price lists.
- BC is the final word. After a sync, the price and discount shown come from BC's read-back.
- `Line_Discount_Percent` is sent to BC only when the rep typed a discount (non-null).
- Migrations are re-runnable, with RLS select-by-org (the 053 pattern). Stage specific paths only.
- Typecheck: `cd nexus && npx tsc --noEmit -p . 2>&1 | grep -v '^.next/'`.

## Review Focus

1. **A Draft price list (e.g. HILO CANDY in TEST) must never affect the estimate.**
2. **A customer with no price group** gets all-customers or customer-specific lists, else the item price.
3. **Changing quantity across a list's `Minimum_Quantity`** changes the estimate.
4. **An existing order line with `discount_percent` 0** still loads and saves. Typing a discount then clearing it returns to "BC decides".
5. **The customer Sync still finishes** when the price-list pull fails, with the error reported like the other steps.

---

### Task 1: Migration 062 and types

**Files:**
- Create: `nexus/supabase/migrations/062_add_sales_price_lists.sql`
- Modify: `nexus/src/types/salesOrders.ts`

**What it does:**
- New table `business_central_sales_price_list_lines`:
  - `id`, `organization_id`, `bc_connection_id` (FKs on delete cascade)
  - `price_list_code text not null`, `line_no int not null`
  - `list_status text not null default ''`
  - `source_type text not null default ''`, `source_no text not null default ''`
  - `item_number text not null default ''`, `unit_of_measure_code text not null default ''`
  - `minimum_quantity numeric not null default 0`
  - `starting_date date`, `ending_date date`
  - `unit_price numeric not null default 0`, `line_discount_percent numeric not null default 0`
  - `amount_type text not null default ''`
  - `last_synced_at timestamptz`
  - unique `(organization_id, bc_connection_id, price_list_code, line_no)`, plus an index on `(organization_id, bc_connection_id, item_number)`
  - RLS select-by-org
- `sales_order_lines.discount_percent`: drop the not-null and the default, keeping the 0–100 check. Add `bc_line_discount_percent numeric`.
- Types:
  - `SalesPriceListLineRow`
  - `SalesOrderLineRow.discount_percent: number | null`, plus `bc_line_discount_percent: number | null`
  - `LineDraft.discount_percent: number | null`, plus `bc_line_discount_percent: number | null`
- Fix the typecheck fallout with the smallest changes. Treat null as "not typed". Don't change behavior here; Task 4 does.
- **Verify:** the typecheck is clean, and the full suite still passes.
- **Commit:** `feat(pricing): table for BC sales price lists; nullable line discount`.
- The user applies 062. The controller checks it.

### Task 2: Price list sync

**Files:**
- Create: `nexus/src/lib/businessCentral/priceLists/priceListSync.ts` (+ test)
- Modify: `nexus/src/app/actions/businessCentralReceivables.ts` (customer Sync: add a block after the ship-to pull, reporting failures the same way)

**Interfaces:**
- `pullSalesPriceLists(deps: { supabase; transport; orgId; connectionId; now(): string }): Promise<{ lines: number }>`
  - Lists `Sales_Price_List_Excel` (headers: `Code`, `Status`, `SourceType`, `AssignToNo`/`SourceNo`, dates) and `Sales_Price_List_ExcelLines`.
  - Joins each line to its header by `Price_List_Code` = header `Code`. The line inherits `list_status`. It takes the source type and number from the line when non-empty, else from the header.
  - The item comes from `Asset_No`, else `Product_No`.
  - Dates of `0001-01-01` are stored as null.
  - Lines with no item are skipped.
  - The org and connection's rows are replaced fully: delete, then insert in chunks of 500.
- **Verify on TEST before coding the mapping** (one read-only script): the exact `SourceType` strings BC returns for All Customers, Customer and Customer Price Group on headers and lines. Record them in the code as constants.
- **Tests:** join and inheritance; Draft status kept as data; `0001-01-01` becomes null; no-item lines skipped; the replace scoped by org and connection; a sync failure reported as `Sales price lists: <msg>` with `complete:false` while the sync continues.
- **Commit:** `feat(pricing): copy BC sales price lists during customer sync`.

### Task 3: Best-price estimate (pure)

**Files:**
- Create: `nexus/src/lib/salesOrders/bestPrice.ts` (+ test)

**Interface:**
- `bestPrice(lines: SalesPriceListLineRow[], q: { customerNumber: string; priceGroup: string; itemNumber: string; uom: string; quantity: number; orderDate: string }, fallback: number | null): { unitPrice: number | null; discountPercent: number | null }`
- A line applies when:
  - `list_status` is Active
  - its source is the customer's price group, customer number q.customerNumber, or All Customers
  - the item matches
  - its UoM is `''` or q.uom
  - q.quantity ≥ minimum
  - orderDate falls within the start and end dates (null means open)
- Result: the lowest `unit_price` among the applicable lines that have a price (Amount_Type includes "Price"), and the highest `line_discount_percent` among the applicable lines that have a discount (Amount_Type includes "Discount"). With no price, return the fallback. With no discount, return null.
- **Tests:** every case in Review Focus 1–3, plus lowest-wins, the UoM mismatch, the date window, and a customer-specific list beating a group list on price.
- **Commit:** `feat(pricing): best-price estimate mirroring BC`.

### Task 4: Wire into the order form and sync

**Files:**
- Modify:
  - `nexus/src/app/actions/salesOrders.ts`: the form context includes the price-list lines. Load them for all customers once; they're small. Alternatively add `getPriceListLinesForCustomer`, the builder's call.
  - `nexus/src/components/salesOrders/SalesOrderForm.tsx` and `SalesOrderLinesTable.tsx`: the estimate comes from `bestPrice(...)` with the item `unit_price` as fallback, recomputed on quantity, customer and order-date changes.
  - Disc %: blank shows BC's `bc_line_discount_percent` (after sync) or the estimated discount, greyed and marked `(est.)` before sync. Typing sets the value; clearing it returns to null.
  - `nexus/src/lib/salesOrders/bcOrderMapping.ts` and `orderSync.ts`: `toBcLine` sends `Line_Discount_Percent` only when non-null. Patch comparisons ignore the discount when null. Read-back stores `bc_line_discount_percent` from the BC line.
  - The `saveSalesOrder` validation accepts null discount.
- **Tests:**
  - the estimate uses the group price
  - quantity crossing the minimum changes the estimate
  - a null discount is not sent to BC
  - a typed discount is sent
  - read-back stores BC's discount
  - clearing a typed discount goes back to null
- **Commit:** `feat(pricing): customer-group price estimate and BC-decided discounts on orders`.

### Task 5: Live check on TEST

- Run the full suite, lint and build.
- In the browser: create an order for a FOODLAND customer with P-1007 and check the estimate shows $2.73 `(est.)` before the sync. After the sync, BC's $2.73 shows with no "(est.)", and the line in BC has the discount BC chose, not 0.
- Update `BACKLOG.md` #5 project 1 notes.
