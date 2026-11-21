# Bill.com payment status stored in Nexus

Status: approved 2026-11-20 ("i want bill.com payment status stored in the invoice in nexus"; matching as part of Customers & Receivables; plan review agreed).

## What gets built

1. **Table `billcom_invoice_status`** (migration 074): one row per BC invoice and environment with match (found / mismatch), Bill.com invoice id, status, total, amount due, due date, Bill.com updatedTime and checked_at. Kept separate so the BC invoice sync never overwrites it.
2. **Sync step in Customers & Receivables** (full sync only; every 2 h and Admin → Sync), only for environments with an enabled Bill.com connection:
   - Reads `GET /v3/invoices?filters=updatedTime:gte:"<cursor>"&sort=updatedTime:asc&max=100`. The time must be quoted; the first run has no filter and walks everything.
   - Follows `nextPage`, saves the cursor (last updatedTime) in sync checkpoint `billcom_invoice_status`, and has its own 30 s window.
   - On Bill.com's rate limit (BDC_1144) it stops quietly and continues next sync. Other failures show as a line and never block the sync.
3. **Matching** (`matchBillcomInvoices`):
   - The Bill.com number must equal the External Doc. No. (else the BC invoice no.), with the same total to the cent and the same customer name. The customer name comes from the list itself.
   - Several BC invoices sharing a number (a partly invoiced order) each match by their own total; still unclear means skipped.
   - The number's only Nexus invoice failing the checks is stored as `mismatch`, so no stale Paid.
   - Archived Bill.com invoices are skipped.
4. **Live refresh:** opening an invoice page or charging a card stores what the live check found (found or mismatch). The live check also picks by total when several invoices share a number.
5. **Sales invoices list:**
   - A **Bill.com** column: Paid green, Past due red, Open / Partially paid, Doesn't match, or — when not stored.
   - A Bill.com status filter: All / Paid / Past due / Open / Not matched.
   - Shown only when the environment has Bill.com.
   - The Paid / Past due rule (`billcomPaymentDisplay`) is shared with the invoice page.
6. **Automatic full sync:** the worst-round estimate is raised to 190 s, so runs stay under 270 s.

## Not built (later)

- A "last checked" line on the invoice page; the page reads Bill.com live, so it is always current.
- The Bill.com webhook (step 3; test whether payments fire `invoice.updated`).

## After review (2026-11-20)

- **Mismatch guard:** a `mismatch` never replaces a `found` match from a different Bill.com invoice (`guardMismatches`).
- **Cut-off lookups:** if the Nexus lookup hits the 1,000-row cap (a very common number), only matches are stored.
- **Stale rows:**
  - archived Bill.com invoices remove their stored status;
  - a live "not found" removes the invoice's stored status;
  - ambiguous leaves it alone.
- **Look-back:** every run re-reads the last 24 h of changes, so an invoice that reached Nexus after its Bill.com copy changed still gets matched.
- **Time:** the clock is checked before each Bill.com request, and the automatic full round's worst case is now 225 s.
- **Race:** the page's insert falls back to an update if the sync inserted the row meanwhile.
- **Still open (low):**
  - more than about 30 pages of invoices sharing one exact `updatedTime` would stall the cursor (fix: also store the last id);
  - whether recording a payment changes Bill.com's `updatedTime` is untested (check on TEST with one Charge card payment). If it doesn't, stored Paid comes only from page visits until the webhook.
