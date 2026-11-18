# Stripe pre-live fixes

Status: approved 2026-11-18 (short design; the user said "go ahead").

## Why

Backlog #12 lists fixes to make before live Stripe keys. Each is rare, but each could charge a customer twice or record a payment twice in Bill.com.

## What gets built (`nexus/src/lib/stripe/chargeInvoice.ts`)

1. **Charged after "Mark not charged":** when Stripe reports success on a row already marked failed, the row becomes `succeeded` + Bill.com `failed`, with a note to check Stripe. That state keeps the one-open-charge-per-invoice index engaged, so the invoice can't be charged again until staff press Retry or "I marked it paid in Bill.com". Nothing is recorded in Bill.com automatically. If another charge for the invoice is already open (unique violation), the row stays `failed` with a "may have been charged twice — refund one" note.
2. **(a)** Check status marks a Bill.com attempt interrupted only if `billcom_attempt_at` is still the one it read.
3. **(b)** Retry refuses when `billcom_payment_id` is already on the row.
4. **(c)** Before recording, Retry looks up the invoice in Bill.com by its id. It records only while Bill.com shows at least this payment's amount still due on that invoice. Otherwise, or if Bill.com can't be checked, it refuses and nothing is recorded.
5. **(d)** When saving "recorded" fails after Bill.com recorded, Nexus still tries to save `billcom_payment_id` on the row (state unchanged).

No migration. No new screens: the existing Retry and "I marked it paid in Bill.com" controls cover every new state.

## Approaches

- **Guards in the charge flow (picked):** small changes where each risk starts.
- Auto-record the late charge in Bill.com: rejected, because a double charge would also be recorded twice.
- A new card-payment state for the late charge: needs a migration and UI. The existing "charged, not in Bill.com" state already blocks further charges.
