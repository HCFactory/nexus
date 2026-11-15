# Create Invoice: Discovery Notes (TEST BC + Bill.com sandbox)

**Date:** 2026-11-15. Plan Task 1 for `docs/superpowers/plans/2026-11-15-create-invoice.md`.

## BC (TEST)

- **Sales order id for actions:** `GET /companies({company})/salesOrders?$filter=number eq '<no>'` returns `id` (GUID). The API v2 salesOrder has **no document date field** (only `orderDate`, `postingDate`, `requestedDeliveryDate`).
- **Dates:** page 42 `SalesOrder('Order','<no>')` accepts a PATCH of `Document_Date` and `Posting_Date` (200). BC recalculates `Due_Date` from the document date and payment terms (W-100528: 2026-11-15 → due 2026-12-15).
- **Post:** `POST /companies({company})/salesOrders({id})/Microsoft.NAV.shipAndInvoice`, no body. On refusal BC returns 400 `Application_DialogException` with a readable `message`. Store that message as `invoice_error`.
- **Posted invoice:** `GET /salesInvoices?$filter=orderNumber eq '<no>'`. Fields: `id`, `number`, `orderNumber`, `externalDocumentNumber`, `invoiceDate`, `postingDate`, `dueDate`, `totalAmountExcludingTax`, `totalTaxAmount`, `totalAmountIncludingTax`, `status`, `customerNumber`. Existing invoices posted from BC have `orderNumber` filled (e.g. INV-100378 ← W-100488, ext "W-100488 / PO# 2282812").
- **Allowed posting dates (important).** TEST's General Ledger Setup allowed posting only from 2021-01-01 to 2025-12-31, so posting with today's date failed with `Posting Date is not within your range of allowed posting dates.` Nothing was posted. `generalLedgerSetup` is read-only over the API (405 on PATCH), so the user changes it in BC. **Go-live:** check production's General Ledger Setup (and any User Setup line for the Nexus app user) covers today.
- **W-100528** (test order): its Document/Posting dates were set to 2026-11-15 by the probe. It is the order chosen (with the user's go-ahead) for the posting test.
- Pending: the posting result (order deleted after posting? invoice found by `orderNumber`?), once the user widens the allowed posting dates.

## Bill.com (sandbox only: `gateway.stage.bill.com`)

- **Create:** `POST /v3/invoices` with `{ customer: { id }, invoiceNumber, invoiceDate, dueDate, processingOptions: { sendEmail: false }, invoiceLineItems: [{ description, quantity, price }] }` → 201. The response has `id` (`00e…`), `status: "OPEN"`, `totalAmount`, and line ids. Test invoice: `NX-DISC-1` (`00e01LLYUNPWUOTa0wu3`) for W00376, $2.73 + "Sales tax" $0.01 = $2.74.
- **Tax:** Bill.com's tax is a rate item (`salesTaxItemId` + `taxable` lines), so it can't take BC's exact tax amount. **Use a non-taxable "Sales tax" line at BC's posted tax amount** (the spec's fallback). Verified: totals add up exactly.
- **No PO, notes, memo or custom field** on invoices (API reference `InvoiceCreateRequestDto`; custom fields exist only for Spend & Expense). **User decision (2026-11-15): the Invoice # is enough.** Send no PO separately. The automatic Invoice # already includes it ("W-100528 / NX-TEST-4").
- **Duplicate invoice number is rejected:** 422 `BDC_1171` "Duplicate invoice number for 00e…". This is a second guard against double creation. Treat `BDC_1171` as "already exists": look it up and finish.
- **Find existing:** `GET /v3/invoices?filters=customerId:eq:<0cu id>` works (`invoiceNumber` isn't filterable), so match `invoiceNumber` in the results, paging with `max` (≤100).
- **Email:** `processingOptions.sendEmail: false` is accepted, and the invoice stays OPEN, so project 3 can send it later.
