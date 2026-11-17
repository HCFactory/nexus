# Change invoice — discovery (TEST BC, Bill.com sandbox), 2026-11-17

No BC cancel and no BC post were run. Each draft invoice created here was deleted.

## BC: where a corrected invoice can be created

- **Page 43 (Sales Invoice) is not published.** `SalesInvoice`, `SalesInvoiceSalesLines`,
  `Sales_Invoice` and `SalesInvoices` all return 404. The published OData
  services include the table-based **`salesDocuments`** (Sales Header) and
  **`salesDocumentLines`** (Sales Line). They expose every field:
  `taxAreaCode`, `taxLiable`, `locationCode`, `genBusPostingGroup`,
  `customerPostingGroup`, `paymentTermsCode`, `shipmentMethodCode`,
  `postingDate`, `documentDate`, `dueDate`, and the ship-to fields. So nothing
  needs publishing, in TEST or in production.
- **Header:** `POST /api/v2.0/companies(..)/salesInvoices`
  `{ customerNumber, externalDocumentNumber, invoiceDate, postingDate, dueDate }`
  returns 201 with `{ id, number: "S-INV102025", status: "Draft" }`. BC fills
  tax area, location and payment terms from the customer.
  - `GET ODataV4/..salesDocuments(<id>)` works; the API id is the SystemId.
  - `PATCH salesDocuments(<id>)` (If-Match etag) with `taxAreaCode`,
    `taxLiable`, `locationCode`, `genBusPostingGroup`, `customerPostingGroup`,
    `paymentTermsCode`, `shipmentMethodCode`, `postingDate`, `documentDate`,
    `dueDate` returns 200, and `dueDate` sticks when it's sent in the same
    patch as `documentDate`.
- **Lines: use API v2, not `salesDocumentLines`.**
  - A `POST salesDocumentLines` returns 201 but skips BC's validation: line
    number 0, price 0, amount 0. Don't use it to create lines.
  - `POST salesInvoices(<id>)/salesInvoiceLines` with
    `{ lineType: "Item", lineObjectNumber: "20000", quantity: 2, unitPrice: 24.5, discountPercent: 10 }`
    returns 201: `sequence 10000`, `netAmount 44.1`, UOM `BOX` (the item's
    sales unit). The location and tax group are taken from the header
    (`WHS-1`, `HI-HNL-WHSL`/`TAXABLE`), so **patch the header location before
    adding lines**.
  - A line's location can also be patched afterwards with
    `PATCH salesDocumentLines(documentType='Invoice',documentNumber='<no>',lineNumber=<n>)`
    `{ locationCode }` (200).
  - `DELETE salesInvoices(<id>)/salesInvoiceLines(<lineId>)` (If-Match) returns
    204.
- **Totals:** `GET salesInvoices(<id>)` returns `status: "Draft"`,
  `totalAmountExcludingTax: 47.43`, `totalTaxAmount: 0.24` and
  `totalAmountIncludingTax: 47.67` (2 × 24.5 −10% + 3.33).
- **Delete a draft:** `DELETE salesInvoices(<id>)` (If-Match) returns 204.
- **INV-100411:** id `143fbb46-e8e0-f111-84e4-7ced8d88ddac`, status `Open`,
  ext `W-100528`, 2026-11-15 / due 2026-12-15, 24.62, customer W00389.
  Nexus order W-100528: tax `HI-HNL-WHSL`, liable, location `WHS-1`, terms
  `30 DAYS`, posting groups `US`/`US`, one line 20000 × 1 BOX @ 24.50.

## Bill.com sandbox: replace an invoice

- Test invoice `NX-CHG-1` (`00e01GFZQDQIJOLa166q`): two lines A 1×2 and
  B 1×3, total 5.
- **PUT with lines only** returns 400 `customer: must not be null`.
- **PUT with the full body**
  `{ customer: { id }, invoiceNumber, invoiceDate, dueDate, invoiceLineItems: [{ description, quantity, price }] }`,
  with no line ids, returns 200.
  - The same invoice id is kept.
  - Lines are **replaced**: A 2×2 and "C new" 1×4.5. B is gone, the lines get
    new ids, and the total is 8.5 with 8.5 due.
  - `GET` confirms it.
- So the change payload is `buildBillcomInvoice`'s payload without
  `processingOptions`.

## What the build uses

- `createDraftInvoice`: API v2 header POST, then a `salesDocuments` PATCH
  (tax, location, posting groups, terms, shipment method, ship-to, dates).
  Lines are then added through API v2 `salesInvoiceLines`.
- `setDraftLines`: delete the existing API v2 lines, then POST the new ones.
- `findDraftInvoice`: API v2 `salesInvoices?$filter=externalDocumentNumber eq '..' and customerNumber eq '..' and status eq 'Draft'`.
- `postDraftInvoice`: `salesInvoices(<id>)/Microsoft.NAV.post` (not run yet).
- `cancelBcInvoice`: `salesInvoices(<id>)/Microsoft.NAV.cancel` (not run yet).
