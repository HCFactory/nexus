# Sales invoice activity log and Bill.com payments — design

## Intent

Staff want to see, on each sales invoice, everything that happened to it and who did it, and to see the payments that paid it (and how they were paid) without opening Bill.com. All customer payments go through Bill.com; card charges made in Nexus (Stripe) are also recorded there.

## Goals

1. **Payments on the invoice.** A Payments section lists every payment applied to the invoice: date, type, reference, amount, status. Each row opens the payment's details page.
2. **Payment details page** `/receivables/payments/<billcom payment id>`:
   - date, amount, type (ACH / online ePayment, Check, Cash, Card, Other), online yes/no, reference (e.g. check number), status (Paid / Cancelled), convenience fee, unapplied amount;
   - deposit account (bank name and last 4);
   - customer (link to profile);
   - every invoice it paid, with the amount applied and a link to that invoice;
   - for a card charge made in Nexus: who charged, card brand and last 4, Stripe reference, Bill.com record state.
3. **Activity timeline on the invoice**, newest first, from:
   - posted in BC (date; "created from sales order X by <user>" when Nexus created it);
   - sent to Bill.com (Nexus-created invoices);
   - past due (the day after the due date, if money was still owed then);
   - payments received (type, reference, amount; links to the payment page);
   - card charges made in Nexus (who, card, amount, Bill.com recorded / failed);
   - invoice corrections (cancel and re-post: who, reason, new invoice link);
   - notes added (who);
   - **status changes** (new history, option B): BC status and Bill.com status, e.g. "Bill.com status: Open → Paid".
4. **Payments sync.** Part of the full Customers & Receivables sync (scheduled every 2 h and Sync now). It reads only payments changed since the last run.

## Non-goals

- Who created or posted invoices made directly in BC (BC's API does not say).
- Status history before this ships (only current status was ever stored).
- Who changed a status in BC or Bill.com (shown as "in Business Central" / "in Bill.com"). Status events record no user even for Nexus actions (triggers can't see the user); the Nexus action itself (correction, card charge, note) shows who in its own timeline entry.
- Status events show when a sync noticed the change, not the exact moment it happened in BC or Bill.com.
- Editing payments or recording non-card payments from Nexus.
- Payments for invoices Nexus hasn't matched to Bill.com yet (they appear once the status sync matches the invoice).

## Anti-goals

- A card charge appearing twice (once from Nexus, once from Bill.com).
- The payments sync slowing or breaking the existing sync, or exceeding the cron time budget.
- Showing bank account numbers beyond the last 4.

## Constraints

- **Bill.com v3, as tested on production:**
  - `GET /v3/receivable-payments` returns: id, customerId, `invoicePayments[]{invoiceId, amount, paymentDate, status, receivedPaymentId}`, paymentDate, receivablesAccount{type, bankName, accountNumber}, amount, unappliedAmount, convenienceFeeAmount, receivablesType (seen: ACH, CHECK, CASH, OTHER; Nexus records cards as CREDIT_CARD), status (PAID, CANCELED), referenceNumber, onlinePayment, createdTime, updatedTime.
  - Paging and filters behave as for invoices: first page `sort=updatedTime:asc` plus a quoted `updatedTime:gte` filter; later pages send only `page` and `max` (use `billcomListQuery`).
  - Rate limit BDC_1144: stop the round, finish next time.
- One database for local and live; migrations are applied by the user.
- Cron full sync round has a fixed time budget. The payments step gets its own budget (20 s, with a 10 s per-request timeout) and resumes from a checkpoint.

## Approaches considered

- **A. Build the timeline from existing records at read time, plus a payments table.** Simple, but no status history.
- **B. A plus a small status-history table (chosen).** Syncs record status changes from now on. Nexus actions record who.
- **C. Log every event into one events table from scratch.** Rejected: history would start on day one, although notes, charges, corrections and payments already exist and can be read directly.

## Design

### Data (migration 076)

- **`billcom_received_payments`:** one row per Bill.com payment.
  - Columns: organization_id, billcom_connection_id, billcom_payment_id (unique per connection), billcom_customer_id, payment_date, amount, unapplied_amount, convenience_fee, receivables_type, online_payment, reference_number, status, deposit_bank_name, deposit_account_last4, billcom_created_time, billcom_updated_time, synced_at.
  - Store only the last 4 digits of the account number.
- **`billcom_received_payment_invoices`:** one row per payment-to-invoice application.
  - Columns: payment id (fk), billcom_invoice_id, amount, payment_date, status, received_payment_id.
  - Replaced as a set whenever the payment is re-synced.
- **`sales_invoice_status_events`:**
  - Columns: organization_id, bc_connection_id, bc_invoice_id, source ('bc' | 'billcom'), from_status, to_status, changed_by (uuid, null when outside Nexus), occurred_at.
- **RLS:** select for org members on all three, like `billcom_invoice_status`.

### Linking payments to an invoice

- **From invoice to payments:** BC invoice → `billcom_invoice_status.billcom_invoice_id` (found matches only) → applications with that Bill.com invoice id → payments.
- **Merging Nexus card charges:** a payment whose id equals a `card_payments.billcom_payment_id` is shown as that card charge, enriched with who and which card.
  - **To verify in build:** does `record-payment`'s returned id equal the receivable-payment id?
  - **If not:** fall back to matching on same Bill.com invoice, amount, payment date and type CREDIT_CARD.
- **Charges never recorded in Bill.com** (failed or not yet recorded) still show, from `card_payments`.

### Sync

- New step **`billcom_received_payments`** in the full receivables sync, after the Bill.com status step.
- **Checkpoint cursor** on updatedTime, with the same rules as the status step:
  - clock check before each request;
  - 24 h look-back;
  - rate limit means incomplete, not an error.
- **First run** back-fills all history over several rounds; scheduled and Sync now rounds continue it.

### Status history

- **BC invoice sync:** when an upsert changes an invoice's `status`, insert a 'bc' event.
- **Bill.com status store:** when the stored Bill.com status of a matched invoice changes, insert a 'billcom' event.
  - This covers both the sync step and the refresh on invoice-page open.
- **First sighting** (no previous value) records nothing, so shipping doesn't create a flood of "→ Open" events.
- **who:** null from syncs. A Nexus action that changes status records the acting user.

### Timeline (read side)

- **Assembly:** one server function gathers every source for an invoice and returns a sorted list of typed events. The page renders it as an **Activity** card.
- **Past due** is computed: due date + 1 day, if the invoice wasn't fully paid by then, judged from payment dates and the current due amount.
- **Layout:** the Payments card and the Activity card sit on the invoice page, below the Bill.com and card panels.

### Payment details page

- **Access:** a server page reading the payment, its applications (each mapped to the BC invoice where matched) and any matching card charge.
- **Permission:** the same as viewing receivables.

## Left to the builder

- Exact visual layout of the two cards and the details page (match the existing invoice page cards).
- Labels for payment types:
  - ACH + online → "ePayment (online)";
  - ACH → "ACH";
  - CHECK → "Check #ref";
  - CASH → "Cash";
  - CREDIT_CARD → "Card";
  - OTHER → "Other".
- How many timeline entries to show before a "Show all".

## Open items

- Confirm the record-payment id equals the receivable-payment id (choose the merge rule).
- Whether cancelled payments show on the invoice. Proposed: show them struck through with "Cancelled".
