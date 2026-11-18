# Sales Order Pricing (Customer Price Groups): Design

**Date:** 2026-11-13
**Status:** Draft, awaiting approval
**Builds on:** `2026-11-13-sales-orders-design.md` (branch `feat/sales-orders`, TEST only)

## Intent

Reps should see the customer's real price while entering an order, the same price BC will charge, not the item's general list price. BC's own price-list discounts must also survive the sync.

## What we measured on TEST BC (2026-11-13)

- **BC already prices lines by customer price group** when Nexus leaves the price blank. A FOODLAND customer ordering P-1007 got $2.73 from the FOODLAND list.
- **Price lists** are published as `Sales_Price_List_Excel` (headers) and `Sales_Price_List_ExcelLines` (lines). TEST has 14 lists and 689 lines, 409 of them with a product.
- **Fields on each line** that matter: `SourceType`/`AssignToNo` (customer price group code), `Asset_No`/`Product_No` (item), `Unit_of_Measure_Code`, `Minimum_Quantity`, `StartingDate`/`EndingDate`, `Unit_Price`, `Line_Discount_Percent`, `Amount_Type` (e.g. "Price & Discount"), and the header's `Status` (Active/Draft).
- **Customers carry `customer_price_group`** in Nexus already. 13 groups are in use.
- **The bug:** Nexus sends `Line_Discount_Percent` on every line, 0 when the rep typed nothing. That overwrites any discount BC applied from a price list.

## Goals

1. Copy BC's sales price lists into Nexus during the customer Sync, as one more reference list.
2. While typing an order, the estimate shown for a blank-price line is the price BC would use. Fall back to the item's list price when no list matches.
3. Send a discount to BC only when the rep typed one, so BC's price-list discount stays otherwise.
4. BC stays the final word: after the sync, the line shows BC's price and BC's discount.

## Non-goals

- Editing price lists in Nexus. They stay read-only copies.
- Customer discount groups, invoice discounts, and quantity-break UI beyond using `Minimum_Quantity` in the estimate.
- Changing how BC prices anything.

## How the estimate is worked out (my call: mirrors BC's "best price")

For a line with customer C, item I, unit of measure U, quantity Q and order date D, a price-list line applies when all of these hold:
- its list is **Active**
- it targets C's price group, customer C directly, or **All Customers**
- the item matches I
- its unit of measure is U or blank
- Q ≥ `Minimum_Quantity`
- D falls within the starting and ending dates (`0001-01-01` means open)

Among the matching lines, take the **lowest** `Unit_Price`, as BC's best-price rule does. If none match, use the item's `unit_price`. The label reads `12.50 (est.)` as today. The price group isn't shown, to keep the label simple.

## Discounts

- `discount_percent` becomes **nullable**. Blank means "BC decides", and the field shows BC's discount after the sync, as it already does for price. This needs a migration (062) that allows null and stops defaulting to 0.
- The BC line patch sends `Line_Discount_Percent` only when the rep typed a value.
- Existing lines keep their stored value. A 0 the rep didn't type isn't distinguishable today, so after 062 the existing test orders keep their 0. They're TEST-only.

## Data

A new table `business_central_sales_price_list_lines`, mirroring the fields above plus the list's status and the source type and code, scoped by org and connection, with RLS select-by-org (the 053 pattern). It's filled by the customer Sync. The table is fully replaced on each sync, since price lists are small (689 lines). The order form loads the lines relevant to the picked customer.

## Left to the builder

- The exact `SourceType` values BC returns for All Customers and Customer (verify on TEST).
- Whether the item key is `Asset_No` or `Product_No` (both appear; take the non-empty one).
- Test cases mirror BC: group match, all-customers, customer-specific, min quantity, date window, UoM, Draft list ignored, lowest price wins.
