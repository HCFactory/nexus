# Invoice numbering and invoice page (sales order round, items 7 + 8)

**Date:** 2026-11-15. Branch `feat/sales-orders`. TEST BC + Bill.com sandbox only.

## Why

Reps think of an invoice by the number the customer sees: the Invoice #
(BC's External Document No., e.g. "W-100532 / PO-9"), not BC's posted
number (INV-100412). They also want to open an invoice inside Nexus and
see its lines, and above all whether it's paid, without going to BC or
Bill.com. This page is also where "Change invoice" and its change log go
later (separate project).

## Goals

1. **Receivables › Invoices list:** first column **Invoice #** =
   `external_document_number` ("—" when blank, e.g. invoices posted in BC
   without one), then **BC Invoice No.** = `bc_invoice_number`. Search
   matches both (it already searches the document number).
2. **Invoice page** `/receivables/invoices/[id]` (id = Nexus row id),
   opened by clicking a list row:
   - Header: Invoice #, BC Invoice No., customer (link as in the list),
     invoice date, due date, BC status.
   - **Sales order** link when a Nexus order produced it
     (`sales_orders.bc_posted_invoice_id = bc_invoice_id`).
   - **Bill.com panel:** status (Open / Partially paid / Paid…), amount
     due, total, and a link to the customer-facing PDF when Bill.com gives
     one. Read live from Bill.com when the page opens (one call).
     Found by `sales_orders.billcom_invoice_id` when Nexus made it, else
     by looking up the customer's Bill.com invoices by Invoice # (needs the
     customer's Bill.com link). Not found / Bill.com off / error → the
     panel says so; the rest of the page still shows.
   - Lines table from `business_central_sales_invoice_lines` (item,
     description, qty, unit price, discount %, amount), then subtotal,
     tax, total from the invoice header.
3. **View invoice** on a sales order opens this page directly (replaces
   the `?q=` list link).
4. **Lines available at once for Nexus invoices:** right after posting,
   the invoice process copies the posted invoice's lines into
   `business_central_sales_invoice_lines` (same mapper and conflict target
   as the Receivables sync), best effort like the header copy.
   Fallback: if the page finds no stored lines, it reads them from BC and
   stores them.

## Non-goals

- Editing, cancelling or changing invoices (next project).
- Recording payments (backlog project 4). The Bill.com panel only reads.
- Changing the Receivables sync itself.

## Approach

One sensible way: read Nexus's existing copy of BC invoices and lines
(already synced), add one live Bill.com read per page open. Rejected:
reading BC live for the whole page (slow, and the copy already exists);
storing Bill.com status in Nexus (needs a Bill.com sync and goes stale —
belongs to the Payments project).

## Permissions

Viewing the page and the Bill.com panel: the existing "view receivables"
permission, same as the list.

## Left to the builder / discovery

- Bill.com v3: the invoice-by-id response fields for status / amount due,
  and how to get a PDF or web link (`invoicePdfId` was all zeros in the
  sandbox). If no link is available, omit it.
- How Bill.com numbers invoices copied by Bill.com's own BC connector
  (affects the lookup by Invoice # for invoices not made by Nexus). If they
  can't be matched reliably, show "Not found in Bill.com".
- Exact Bill.com status labels shown to reps.
