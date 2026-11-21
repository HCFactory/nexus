# Invoice Activity and Bill.com Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each sales invoice shows its Bill.com payments (each opening a payment details page) and an activity timeline; Bill.com payments sync into Nexus; status changes are recorded from now on.

**Architecture:** Migration 076 adds payment tables, a status-event table and triggers that log status changes. A new step in the full receivables sync reads changed Bill.com payments (same cursor pattern as the status step). A server-side assembler builds the payments list and timeline from existing tables plus the new ones; the invoice page renders two cards; a payment page shows details.

**Tech Stack:** Next.js 16 server components, Supabase, Vitest + fakeSupabase.

**Spec:** docs/superpowers/specs/2026-11-20-invoice-activity-and-payments-design.md

## Global Constraints

- Bill.com list paging: first page `sort=updatedTime:asc` + `filters=updatedTime:gte:"<ISO>"`; later pages only `page`+`max` (`billcomListQuery`). BDC_1144 = rate limit → incomplete, no error.
- Store only the last 4 digits of any account number.
- Status history records changes only (no event on first sighting).
- Payments step budget 30 s; checkpoint entity `billcom_received_payment`; 24 h look-back on the cursor.
- Migration is applied by the user; everything must degrade gracefully (no crash) before it is applied.

## Review Focus

1. A Nexus card charge must appear once (merged), never twice — including when the Bill.com payment id was not saved.
2. One payment applied to several invoices shows on each, with that invoice's applied amount (not the payment total).
3. A payment re-synced with changed applications replaces the old application rows (none left behind).
4. Cancelled payments: shown struck through, excluded from "paid by" past-due logic.
5. Timeline when tables are missing/empty (migration not yet applied, no Bill.com): page still renders.

---

### Task 1: Migration 076

**Files:** Create `nexus/supabase/migrations/076_invoice_activity_and_payments.sql`

- [ ] Tables `billcom_received_payments` (unique billcom_connection_id+billcom_payment_id), `billcom_received_payment_invoices` (fk cascade to payment), `sales_invoice_status_events`; indexes on (billcom_connection_id, billcom_invoice_id) and (bc_connection_id, bc_invoice_id, occurred_at); RLS select for org members.
- [ ] Trigger on `business_central_sales_invoices` after update of status when old.status is not null and distinct → insert event source 'bc'.
- [ ] Trigger on `billcom_invoice_status` after update of status, same rule → source 'billcom'.
- [ ] Commit. User applies.

### Task 2: Payment mapping and sync loop

**Files:** Create `nexus/src/lib/billcom/receivedPayments.ts`, test `receivedPayments.test.ts`

**Produces:**
- `interface BillcomReceivedPayment` (API shape from the probe)
- `toStoredPayment(p): { payment: StoredPaymentRow; applications: StoredApplicationRow[] }` — last4 only, numbers coerced.
- `syncBillcomReceivedPayments(deps: { listChanged(since, page), save(rows), readCheckpoint, writeCheckpoint, nowMs }, budgetMs): Promise<SyncEntityResult>` with entityType `'billcom_received_payment'`.

- [ ] Tests: mapping keeps last 4 only; applications listed; loop pages, saves, advances capped cursor, stops on budget, rate-limit → incomplete without error, other error → message.
- [ ] Implement; tests green; commit.

### Task 3: Wire the sync step

**Files:** Modify `receivablesSync.ts` (new `runBillcomPaymentsStep` after the status step), `types/database.ts` (SyncEntityType), `components/admin/SyncSection.tsx` (description lists Bill.com payments).

- [ ] `save` upserts payments (onConflict billcom_connection_id,billcom_payment_id), deletes then inserts that payment's applications.
- [ ] Test the save adapter with fakeSupabase (replaces applications). Commit.

### Task 4: Activity and payments assembler

**Files:** Create `nexus/src/lib/receivables/invoiceActivity.ts`, test.

**Produces:**
- `paymentTypeLabel(type, online, reference)`: ACH+online → "ePayment (online)", ACH → "ACH", CHECK → "Check #ref" / "Check", CASH → "Cash", CREDIT_CARD → "Card", OTHER → "Other".
- `getInvoicePaymentsAndActivity(supabase, { orgId, bcConnectionId, invoice, today }): Promise<{ payments: InvoicePaymentRow[]; activity: ActivityEvent[] }>` — never throws (missing tables → empty).
- Merge rule: card_payments.billcom_payment_id = payment id; else same billcom invoice + amount + date + CREDIT_CARD; unrecorded charges listed from card_payments.
- Past due event: due date + 1 if not fully paid by then (sum of non-cancelled applications dated ≤ due date < invoice total).

- [ ] Tests per Review Focus 1–5 plus ordering newest first. Implement; commit.

### Task 5: UI — invoice cards and payment page

**Files:** Create `components/receivables/InvoicePaymentsCard.tsx`, `InvoiceActivityCard.tsx`, `app/(protected)/receivables/payments/[paymentId]/page.tsx`, `components/receivables/PaymentDetail.tsx`, `lib/receivables/paymentDetail.ts`; modify invoice page to stream the two cards.

- [ ] Tests: rows link to `/receivables/payments/<id>`; cancelled struck through; activity entries render who/what; payment detail lists invoices with links and card-charge info.
- [ ] Implement; browser check; commit.

### Task 6: Verify and review

- [ ] Full suite, tsc, lint; fresh reviewer on the branch; fix Critical/Important; ask the user before pushing.
