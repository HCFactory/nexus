# BC customer templates — discovery (BC TEST, 2026-10-30)

Services published by the user: `CustomerTemplates` (Customer Templ. Card) and `NoSeries` (No. Series). Both key on `Code`. Page numbers 1382 / 456 are the plan's assumption (used only in the "publish page N" error text).

## Read-only
- 4 templates: 501C-FUND, CUST-PERSON, FUNDRAISER-STD, WHOLESALE. 153 number series.
- `Contact_Type`, `Tax_Identification_Type`, `Application_Method` are `Edm.String` (no EnumType in $metadata). Values seen: `Company`/`Person`, `Legal Entity`/`Natural Person`, `Manual`.
- `$filter=Payment_Terms_Code eq '30 DAYS'` → 501C-FUND, FUNDRAISER-STD, WHOLESALE; `Tax_Area_Code eq 'HI-HNL-RT'` → CUST-PERSON, FUNDRAISER-STD. Filtering works.

## Writes (throwaway ZZNEXUS-T template, ZZNEXUS-P payment term; all deleted, verified 0 left)
| Probe | Result |
|---|---|
| POST with only the 13 spec fields | 201. The GET etag equals the POST etag (no post-create touch here). |
| Non-spec fields after create | BC filled its defaults: Copy_Sell_to_Addr_to_Qte_From=Company, Allow_Line_Disc=true, Bank_Communication="E English", Reserve=Optional, Shipping_Advice=Partial. |
| Duplicate create | 400 `Internal_EntityWithSameKeyExists` |
| PATCH `Application_Method: "Apply to Oldest"` | 200 — exact spelling confirmed |
| PATCH with stale etag | 409 `Request_EntityChanged` (engine maps to conflict) |
| PATCH `Contact_Type: "Bogus"` | 400 `Application_InvalidOptionEnumValue` — "'Bogus' is not an option. The existing options are: Company,Person" |
| Rename via PATCH `Code` | 200; old key 404, new key 200 |
| Rename payment term used by template (API v2) | template's `Payment_Terms_Code` followed the rename (cascade confirmed) |
| `$filter` on renamed code | finds the template |
| DELETE template / payment term | 204 / 204 |

## Consequences
- Plan values stand: fixed choices `Company`/`Person`, `Legal Entity`/`Natural Person`, `Manual`/`Apply to Oldest`.
- Spec decision 6: create with only the 13 fields works — no copy-from-template design needed.
- Spec decision 2 confirmed: renames cascade into templates, so the follow-up re-pull is needed.
