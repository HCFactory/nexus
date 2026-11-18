# Stripe saved cards: card setup link + manual charge — design

Date: 2026-11-16
Status: draft, awaiting approval

## Intent

Staff want a customer's card on file so they can collect **past-due invoices** without chasing the customer. The customer enters the card themselves through a link; Nexus never sees or stores the card number. Staff then charge a past-due invoice with one click. The payment is recorded in Nexus first, then the Bill.com invoice is marked paid so Bill.com stops treating it as unpaid.

Why Stripe and not Bill.com: Bill.com's API can only save and charge **bank accounts**; cards can only be saved through Bill.com's own customer portal, which is tied to invoice emails. The user chose Stripe.

Why not store cards in Nexus: full PCI DSS (SAQ D) would apply — months of work, yearly scans and penetration tests, and Supabase is not a card-data store. With Stripe-hosted card entry, Nexus stays at SAQ A.

## Goals

1. On a customer's page, staff can **email** a card setup link to the customer or **copy** it (to text it).
2. The customer opens the link, enters a card on a Stripe-hosted page, agrees to be charged for past-due invoices, and sees a "card saved" page.
3. Nexus shows the saved card ("Visa •••• 4242, exp 08/28") on the customer page.
4. On a past-due invoice, staff with permission click **Charge card**, confirm the amount, and the card is charged through Stripe.
5. The payment is saved in Nexus, then recorded as paid in Bill.com. If the Bill.com step fails, Nexus shows it and offers Retry.

## Non-goals (for now)

- Automatic charging (user decision: manual only for now).
- Partial or custom amounts — the charge is the invoice's full Bill.com amount due.
- Refunds inside Nexus — done in the Stripe dashboard.
- Recording payments into Business Central — the planned Payments project (BACKLOG item 4) picks up Nexus payment records later.
- Bank accounts / ACH.
- A Nexus-hosted card form (approach B); can be swapped in later without changing the charge side.

## Anti-goals (failure even if it "works")

- A card number, CVV, or full card data reaching Nexus servers, logs, or database.
- A customer charged twice for the same invoice.
- A successful Stripe charge with the Bill.com invoice still open and nobody able to see that.
- A setup link that works forever or can't be cancelled.

## Constraints

- Nexus: Next.js 16 app router, Supabase (Postgres + RLS), multi-organization data model; Resend for email (`src/lib/email.ts`); public pages live under `src/app/(public)`.
- Bill.com: Nexus already uses the **v3 API** (`src/lib/billcom/client.ts`). Invoices are linked to sales orders via `sales_orders.billcom_invoice_id`; `readBillcomInvoiceStatus` (`src/lib/billcom/invoiceStatus.ts`) reads status and amount due. Recording an outside payment uses `POST /v3/invoices/record-payment` (`paymentDate`, `paymentType: CREDIT_CARD`, `invoices: [{ id, amount }]`); it does not move money.
- Nexus signs in to Bill.com with a sync token. Record-payment does not move funds, so it is not expected to need MFA. *User decision (2026-11-17):* skip the up-front sandbox test; the user may test manually later. *My call:* build so it works either way — the automatic Bill.com step plus a manual fallback (see Flow 3 step 6) — and make the Bill.com record-payment call the **first build task**, verified against the sandbox, so the answer arrives early without blocking the design.
- Customers in Nexus come from Business Central; "customer must exist in Nexus first" means the feature lives on the existing customer detail page only.
- Card network rules require the customer's consent before merchant-initiated (off-session) charges.

## Approaches considered

- **A. Stripe Checkout (setup mode), reached through a Nexus link — chosen.** The emailed/copied link points to Nexus; on click Nexus creates a fresh Checkout Session and redirects. Least code; Stripe handles card entry, validation, 3-D Secure, mobile. The Nexus link works around Checkout Sessions expiring within 24 hours and lets staff cancel links.
- **B. Nexus page with Stripe Payment Element.** Fully branded, still SAQ A, but more UI to build and maintain for mostly cosmetic gain.
- **C. Stripe Customer Portal.** Built for subscriptions; adds a sign-in step.

User picked A.

## Decided by the user

- Stripe holds the cards.
- Customer must already exist in Nexus; the customer page offers **Email link** and **Copy link** (to text it).
- Staff click **Charge card** manually; no automatic charging for now.
- A Stripe payment goes **into Nexus first**, then Nexus marks the Bill.com invoice paid.

## Design

### Configuration

- *My call, following the existing pattern* (BC and Bill.com credentials live in the database / Supabase Vault per organization and are managed in Settings, not env vars): a per-organization **Stripe connection** — secret key and webhook signing secret stored in Vault, entered by an admin in Settings, with a "Test connection" check (retrieve the Stripe account). Test-mode and live keys are just different connections.
- Webhook URL per connection: `POST /api/stripe/webhook/{connectionId}` so the handler knows which signing secret to verify with. Settings shows the URL to paste into Stripe.
- `NEXT_PUBLIC_APP_URL` (exists) builds link URLs.
- Every Stripe object carries `metadata.organization_id` and `metadata.bc_customer_number`.
- *My call (builder check), matching Bill.com's `resolveBillcomConnection`:* connections have `is_enabled` / `is_default`; exactly one enabled default per organization is "the" Stripe connection. Every new table stores `stripe_connection_id`, and every unique key includes it, because Stripe customer/card ids only exist in the account that created them. Link creation, the webhook (by URL), and charging all use that connection id. When the default connection changes (e.g. test → live), cards saved under another connection are not shown as chargeable; the customer page says "No card on file in the current Stripe account" and staff send a new link.

### Customer identity

*My call (builder check):* customer detail rows (`business_central_customers.id`) exist once per Business Central environment, and Bill.com links key on `bc_customer_number`. Cards therefore key on **organization + `bc_customer_number` + `stripe_connection_id`**, not the per-environment row id. Below, "customer" means that key. The customer page and invoice page both look up the card by customer number.

### Data (new migration)

`stripe_connections` — per organization, secret key + webhook secret in Vault, `is_enabled`, `is_default`, `livemode` (from the account check), `created_at`.

`stripe_customers` — one row per customer that has a Stripe customer.
- `organization_id`, `stripe_connection_id`, `bc_customer_number`, `stripe_customer_id`, `created_at`; unique (`stripe_connection_id`, `bc_customer_number`) and (`stripe_connection_id`, `stripe_customer_id`).

`customer_cards` — the saved card label; at most one active per customer.
- `id`, `organization_id`, `stripe_connection_id`, `bc_customer_number`, `stripe_payment_method_id`, `brand`, `last4`, `exp_month`, `exp_year`, `saved_at`, `removed_at`, `removed_by`.
- Unique (`stripe_connection_id`, `stripe_payment_method_id`); partial unique index: one row with `removed_at is null` per (`stripe_connection_id`, `bc_customer_number`).

`card_setup_links`
- `id`, `organization_id`, `stripe_connection_id`, `bc_customer_number`, `token_hash` (SHA-256 of a 32-byte random token; the raw token is only in the URL), `created_by`, `created_at`, `expires_at` (created + 14 days), `canceled_at`, `completed_at`, `emailed_to` (nullable), `stripe_checkout_session_id` (latest, nullable).

`card_payments`
- `id`, `organization_id`, `stripe_connection_id`, `bc_customer_number`, `sales_order_id` (nullable), `bc_invoice_id`, `billcom_invoice_id`, `amount` (numeric, dollars), `currency` ('usd'), `card_id`, `stripe_payment_intent_id` (unique, nullable until created), `status` (`processing` | `succeeded` | `failed`), `failure_message`, `billcom_state` (`not_started` | `recorded` | `recorded_manually` | `failed`), `billcom_payment_id`, `billcom_error`, `charged_by`, `charged_at`, `billcom_recorded_at`.
- Partial unique index: at most one row per `billcom_invoice_id` where `status = 'processing'` or (`status = 'succeeded'` and `billcom_state not in ('recorded','recorded_manually')`). This blocks a second charge while one is in flight or unreconciled.

RLS: staff in the organization can read; writes go through server actions using the service role, matching existing patterns.

### Permissions

- Sending/copying links and removing a card: existing "Create and edit customers" permission.
- *My call:* new per-user permission **"Charge saved cards"** (off by default, toggled on the admin page like the others). Charging moves money, so it should not ride on customer edit rights.

### Flow 1 — send the setup link (customer detail page)

New "Card on file" card on the customer detail page:
- No card: "No card on file." Buttons **Email link** and **Copy link**.
- Card saved: "Visa •••• 4242, exp 08/28 · saved Nov 16, 2026." Buttons **Send new link** (to replace), **Remove card** (confirm).
- If an unexpired link exists: "Link sent Nov 16 · expires Nov 30" and **Cancel link**.

Email link: confirm dialog pre-filled with the customer's email (editable, required). Sends via Resend: short note from the organization, the link, "expires in 14 days". *My call* on wording; no card data in the email.
Copy link: creates the link and copies the URL to the clipboard; shows "Copied — expires Nov 30."
Creating a new link cancels any earlier unused link for that customer.

### Flow 2 — customer saves the card (public)

Route `src/app/(public)/card-setup/[token]` (no sign-in).
1. Hash the token, look up the link. Expired, cancelled, completed, or unknown → plain "This link is no longer valid — please contact us" page (no customer details shown).
2. Find or create the Stripe customer (name + email from the Nexus customer, metadata ids); store in `stripe_customers`.
3. Create a Checkout Session: `mode: 'setup'`, `customer`, `currency: 'usd'`, `payment_method_types: ['card']`, `success_url: /card-setup/{token}/done?session_id={CHECKOUT_SESSION_ID}`, `cancel_url: /card-setup/{token}`, consent text via `custom_text` (e.g. "By saving this card you authorize {Organization} to charge it for past-due invoices."), metadata `{ organization_id, bc_customer_number, card_setup_link_id }`. Store the session id on the link. Redirect (303) to the session URL.
4. Saving the card happens in **one shared function** called from both:
   - the webhook (`POST /api/stripe/webhook/{connectionId}`, signature verified, event `checkout.session.completed` with `mode = setup`), and
   - the `done` page (retrieves the session by id as a fallback in case the webhook is slow).
   It retrieves the SetupIntent → payment method, writes `customer_cards` (marking any previous active card removed and detaching it in Stripe), sets it as the Stripe customer's default, and marks the link `completed_at`. Idempotent on `stripe_payment_method_id`.
5. Done page: "Thanks — your card ending 4242 is saved." No other details.

### Flow 3 — charge a past-due invoice (invoice page)

On the sales invoice page (`src/lib/receivables/salesInvoicePage.ts` + its page), next to the Bill.com status panel:
- Show **Charge card** when: user has "Charge saved cards", customer has an active card, the Bill.com invoice is known, amount due > 0, and the invoice is past due (due date before today). *My call:* past-due only, per the request.
- *User decision:* this applies to **any posted invoice on the invoice page**, not only ones from a Nexus sales order. The Bill.com invoice comes from `sales_orders.billcom_invoice_id` when there is one, otherwise from the existing by-number lookup in `getSalesInvoiceBillcomPanel` — but only when it finds **exactly one** match. No match or `ambiguous` → no button, with the reason. `card_payments.sales_order_id` is therefore nullable, and the row also stores `bc_invoice_id` (the BC posted invoice id the page is keyed on).
- Otherwise show why not, briefly ("No card on file — send a setup link from the customer page").

On click:
1. Server re-reads the Bill.com amount due (don't trust the page).
2. Confirm dialog: "Charge Visa •••• 4242 **$1,234.56** for Invoice 1043 / PO-77?" → Confirm.
3. Server inserts `card_payments` (`processing`, `billcom_state = not_started`). The unique index rejects a duplicate → "A charge for this invoice is already in progress or needs attention."
4. Create a PaymentIntent: `amount` in cents, `currency: 'usd'`, `customer`, `payment_method`, `off_session: true`, `confirm: true`, `receipt_email` = customer email (*my call*: Stripe sends the receipt), metadata ids + invoice number, **idempotency key = `card_payments.id`**.
5. Result:
   - `succeeded` → row `succeeded`, store intent id.
   - Declined / `requires_action` (bank wants 3-D Secure) → row `failed` with Stripe's message (e.g. "Card declined — insufficient funds", "The bank needs the customer to approve this charge — send a new setup link"). Nothing goes to Bill.com.
   - Network error/unknown → leave `processing`; the page shows "Checking with Stripe…" and a **Check status** action that retrieves the intent by idempotency/metadata and settles the row. No re-charge.
6. On success, record in Bill.com: `POST /v3/invoices/record-payment` with today's date, `paymentType: CREDIT_CARD`, the invoice id and amount, a description containing the Stripe payment id. Success → `billcom_state = recorded`, store Bill.com payment id. Failure → `billcom_state = failed`, error stored; page shows "Charged in Stripe — Bill.com not updated" with **Retry Bill.com** and **I marked it paid in Bill.com** (confirm dialog; sets `billcom_state = recorded_manually`, stores who and when). The manual button is the fallback if Bill.com refuses record-payment for token sessions; if that turns out to be permanent, the automatic call can be switched off and staff use the manual button every time. `billcom_state` values: `not_started` | `recorded` | `recorded_manually` | `failed`; the duplicate-charge index treats both recorded states as settled.
7. The invoice page lists card payments for that invoice (date, amount, card, who, Stripe status, Bill.com status).

### Error handling summary

| Case | What staff see | Data |
|---|---|---|
| Card declined | Stripe's reason; Charge button available again | `failed` |
| Bank requires approval | "Customer must approve — send a new setup link" | `failed` |
| Stripe unreachable mid-charge | "Checking with Stripe…" + Check status | stays `processing` |
| Bill.com record fails | "Charged — Bill.com not updated" + Retry | `succeeded` / `billcom failed` |
| Second click / second staff member | "Already in progress or needs attention" | blocked by index |

### Testing

- Unit tests (vitest) for: token hashing/validation, card-saving function idempotency, charge eligibility rules, Bill.com record-payment payload, state transitions.
- Stripe test mode with test cards: `4242 4242 4242 4242` (success), `4000 0025 0000 3155` (requires authentication), `4000 0000 0000 9995` (declined).
- Webhook locally via Stripe CLI (`stripe listen --forward-to localhost:3000/api/stripe/webhook/<connectionId>`).
- Bill.com sandbox: confirm record-payment works with the sync-token login and the invoice shows paid.
- Load the app and walk the full flow (per project practice, `npm run build` alone is not proof).

## Left to the builder

- Exact UI placement/styling within the existing dark design system.
- Email copy details.
- Whether the Stripe SDK (`stripe` npm package) or raw fetch is used — SDK expected.
- Migration number (next after 065).
