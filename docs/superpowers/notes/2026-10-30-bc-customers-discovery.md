# BC customers — discovery (BC TEST, 2026-10-30)

Page: OData `Customer_Card_Excel` (published in TEST), key `No`. No ReadOnly annotations in $metadata.

## Read-only
- Fields present: No, Name, E_Mail, EMailCCHCABG (invoice email CC — extension field), Phone_No, Address, Address_2, City, County (state), Post_Code, Country_Region_Code, Payment_Terms_Code, Tax_Area_Code, Tax_Liable, Tax_Identification_Type, Customer_Price_Group, Customer_Posting_Group, Gen_Bus_Posting_Group, Application_Method, Location_Code, Blocked, Credit_Limit_LCY.
- **Not present:** No_Series, Contact_Type (no field under any name). → Contact type dropped from Nexus (spec decision 2).
- `$filter=Customer_Price_Group eq 'WHSL-DLVRY'` works (632 customers).
- WHSL-CUST series line: starting W00000, last used W01249, **ending blank** (= unlimited in BC).

## Writes (user-approved; throwaway ZZNEXUS customers, all deleted, 0 left)
| Probe | Result |
|---|---|
| POST with no `No` | 201, BC numbered **C00333** from its default customer series (not the template's). One TEST number used. |
| `createBcNoSeriesAssigner.prepare('WHSL-CUST')` | **Bug:** throws SeriesExhaustedError — `isWithinRange` treats a blank ending number as exhausted. Blank means unlimited in BC. Affects item numbering too. |
| With the blank end treated as unlimited: POST with `No` = W01250 + all 20 spec fields in one call | 201; every field stored exactly as sent; POST etag == GET etag. `assigner.commit` advanced the series to W01250. |
| PATCH Credit_Limit_LCY + Blocked=Invoice | 200 |
| PATCH with stale etag | 409 `Request_EntityChanged` |
| PATCH Blocked='Bogus' | 400 `Application_InvalidOptionEnumValue` — options are ` `, `Ship`, `Invoice`, `All` |
| API v2 `customers` after card write | sees the customer, blocked=Invoice, email matches |
| DELETE (no entries) | 204 |

## Consequences / rulings
- All customer writes go to `Customer_Card_Excel`, key `No`, one POST for create (no partial-create path needed).
- Numbering: reuse `createBcNoSeriesAssigner` with the template's `no_series`; fix blank-ending = unlimited in `numberSeries.isWithinRange`.
- Blocked values: ` ` (blank), `Ship`, `Invoice`, `All`.
- Delete-with-entries refusal was not tested (never delete a real customer); handle any BC 4xx on DELETE as "refused".
