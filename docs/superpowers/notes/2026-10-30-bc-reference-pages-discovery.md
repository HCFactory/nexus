# BC reference pages — discovery (BC TEST, 2026-10-30)

Read-only probe of the published OData V4 pages, company `Hawaii Candy Factory LLC`, environment `TEST`.
Field names, keys and lengths come from `$metadata`; `!` = not nullable. None of these pages expose a
modified timestamp, so Sync compares values only (spec: BC wins on any difference).

| Service name | Page | Rows | Key fields |
|---|---|---|---|
| `CustomerPriceGroups` | 7 | 14 | `Code` |
| `CustomerPostingGroups` | 110 | 9 | `Code` |
| `GenBusinessPostingGroups` | 312 | 4 | `Code` |
| `TaxAreaLines` | 465 | 9 | `Tax_Area`, `Tax_Jurisdiction_Code` |
| `TaxJurisdictions` | 466 | 10 | `Code` |
| `TaxDetails` | 468 | 50 | `Tax_Jurisdiction_Code`, `Tax_Group_Code`, `Tax_Type`, `Effective_Date` |

## Fields

- **CustomerPriceGroups:** `Code` String(10)!, `Description` String(100), `Price_Calculation_Method` String,
  `Allow_Line_Disc` Boolean, `Allow_Invoice_Disc` Boolean, `Price_Includes_VAT` Boolean,
  `VAT_Bus_Posting_Gr_Price` String(20), `Coupled_to_Dataverse` Boolean.
- **CustomerPostingGroups:** `Code` String(20)!, `Description` String(100), `Receivables_Account` String(20)!,
  plus ~15 G/L account fields (`Service_Charge_Acc`, `Payment_Disc_Debit_Acc`, …). Read-only copy needs `Code`, `Description`, `Receivables_Account`.
- **GenBusinessPostingGroups:** `Code` String(20)!, `Description` String(100), `Def_VAT_Bus_Posting_Group` String(20), `Auto_Insert_Default` Boolean.
- **TaxAreaLines:** `Tax_Area` String(20)!, `Tax_Jurisdiction_Code` String(10)!, `Jurisdiction_Description` String(100) (display, from the jurisdiction), `Calculation_Order` Int32.
- **TaxJurisdictions:** `Code` String(10)!, `Description` String(100), `Default_Sales_and_Use_Tax` Decimal,
  `Calculate_Tax_on_Tax` Boolean, `Unrealized_VAT_Type` String, `Adjust_for_Payment_Discount` Boolean,
  `Tax_Account_Sales` / `Tax_Account_Purchases` / `Reverse_Charge_Purchases` / `Unreal_*` String(20),
  `Report_to_Jurisdiction` String(10), `Country_Region` String, `Print_Order` Int32, `Print_Description` String(30).
- **TaxDetails:** `Tax_Jurisdiction_Code` String(10)!, `Tax_Group_Code` String(20)! (may be `""`),
  `Tax_Type` String! (enum caption, e.g. `"Sales and Use Tax"`), `Effective_Date` Date! (`YYYY-MM-DD`),
  `Tax_Below_Maximum` Decimal (percent, 4.5 = 4.5%), `Maximum_Amount_Qty` Decimal, `Tax_Above_Maximum` Decimal, `Expense_Capitalize` Boolean.

## Things the code must handle

- Every row carries `@odata.etag`; no `SystemModifiedAt` field.
- TaxDetails key includes an empty-string `Tax_Group_Code` and a `Tax_Type` with spaces — key literals must quote and URL-encode them (`Tax_Group_Code=''`). `Effective_Date` is unquoted.
- Tax area code is String(20) in lines; jurisdiction code is String(10); price group code is String(10).

## Write probes (user approved; throwaway `ZZNEXUS` entries in TEST, all removed afterwards)

| Check | Result |
|---|---|
| Create (OData page 7, API paymentTerms/taxAreas, pages 465/466/468) | 201 on all |
| Duplicate create | 400 `Internal_EntityWithSameKeyExists`: "The record in table … already exists. Identification fields and values: Code='…'" |
| **Stale etag (If-Match with an old etag)** | **409 `Request_EntityChanged`: "Another user has already changed the record."** on both OData and API — **not 412** |
| Rename via key PATCH (`Code` on OData, `code` on API) | 200; API keeps the same `id` |
| Rename ripple | Jurisdiction rename → its tax area lines and tax details follow. Tax area rename → its lines follow |
| TaxDetails by full key (`Tax_Group_Code=''`, `Tax_Type='Sales and Use Tax'`, unquoted date) | GET/PATCH 200 |
| Rate | `Tax_Below_Maximum` stored as sent (4.712, 4.5) — a plain percent |
| Bad date formula | 400 `Application_EvaluateException`: "The date formula 'BANANA' should include a time unit. …" |
| **Delete a jurisdiction that is in use** | **204 — BC allows it and silently deletes its tax area lines and tax details** |
| **Delete a tax area that has lines** | **204 — BC deletes its lines too** |
| Create one tax detail after creating a jurisdiction | 3 detail rows existed for the jurisdiction afterwards (BC inserted extra rows) — Nexus must re-read details after creating a jurisdiction/detail rather than assume one row |

### Consequences for the build

1. The transport must treat **409 `Request_EntityChanged`** (as well as 412) as `BcConflictError`, so the
   "re-read, re-apply changed fields, retry once" path actually runs.
2. The jurisdiction usage check is essential: BC does not protect it, it cascades.
3. Deleting a tax area cascades its lines in BC; the service already removes the Nexus line rows.
4. After creating a jurisdiction or a tax detail, re-read that jurisdiction's tax details from BC.
