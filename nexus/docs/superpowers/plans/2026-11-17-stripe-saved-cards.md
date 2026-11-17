# Stripe Saved Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff send a customer a link to save a card in Stripe, then charge past-due invoices with one click; each payment is saved in Nexus first, then recorded as paid in Bill.com.

**Architecture:** A per-organization Stripe connection (keys in Supabase Vault, managed in Admin like Bill.com). A public Nexus route turns a hashed, expiring token into a fresh Stripe Checkout Session in `setup` mode; a shared idempotent function saves the resulting card from both the webhook and the return page. Charging creates an off-session PaymentIntent with the `card_payments` row id as the idempotency key, then calls Bill.com `POST /v3/invoices/record-payment`, with Retry and a manual "I marked it paid" fallback.

**Tech Stack:** Next.js 16 app router, TypeScript, Supabase (Postgres, Vault, service-role server actions), `stripe` Node SDK, Bill.com v3 API (existing client), Resend, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-16-stripe-saved-cards-design.md` (approved 2026-11-17). Read it alongside this plan.

## Global Constraints

- No card number, CVV or raw card data ever reaches Nexus code, logs or tables. Only `brand`, `last4`, `exp_month`, `exp_year`, and Stripe ids.
- Setup links expire **14 days** after creation; a new link cancels earlier unused links for the same customer.
- Raw setup token: 32 random bytes, base64url, only in the URL. The DB stores SHA-256 hex (`token_hash`).
- Cards and payments key on **organization + `bc_customer_number` + `stripe_connection_id`**, never `business_central_customers.id`.
- Every Stripe object gets metadata `{ organization_id, bc_customer_number }` (+ `card_setup_link_id` / `card_payment_id` where relevant).
- Charge amount = the Bill.com invoice's `dueAmount`, **re-read on the server at charge time**; cents = `Math.round(amount * 100)`; currency `usd`.
- Charge only when: permission `canChargeSavedCards`, active card in the current default Stripe connection, Bill.com invoice known (stored id, or by-number lookup with exactly one match), `dueAmount > 0`, `dueDate < today`.
- `billcom_state` values: `not_started` | `recorded` | `recorded_manually` | `failed`. `status` values: `processing` | `succeeded` | `failed`.
- Consent text on the Stripe page: `By saving this card you authorize {Organization name} to charge it for past-due invoices.`
- Confirm text: `Charge {Brand} •••• {last4} {$amount} for Invoice {number}?`
- Duplicate-charge message: `A charge for this invoice is already in progress or needs attention.`
- New tables follow `045_add_billcom_connections.sql`: RLS enabled, **no policies**, `revoke all ... from anon, authenticated`; Vault wrappers follow `046_billcom_credential_functions.sql` including the revoke/grant block.
- `'use server'` files export only async functions (types go in `src/types/`).
- Migrations are re-runnable (`if not exists`, no `create policy`). The user applies migrations; the plan does not run them against production.
- Per project practice, `npm run build` passing is not proof — the final task loads the app and walks the flow.

## Review Focus

1. **A setup link opened after it expired, was cancelled, was replaced, or was already used** → plain "This link is no longer valid — please contact us" page; no customer name, email or card shown, and no Stripe call. (Task 5 test `rejects expired/cancelled/completed tokens`.)
2. **Two clicks or two staff members charging the same invoice at once** → exactly one PaymentIntent; the second gets the duplicate-charge message. (Task 7 test `second concurrent charge is rejected by the unique index`.)
3. **The amount due changed after the page loaded** (customer paid part in Bill.com) → the charge uses the fresh `dueAmount`; if it is now 0 or the invoice is no longer past due, refuse with a reason. (Task 7 tests `uses fresh due amount` / `refuses when nothing is due`.)
4. **Webhook and return page save the same card at the same moment** → one active `customer_cards` row; the previous card is removed once. (Task 5 test `saving twice is idempotent`.)
5. **The default Stripe connection switches from test to live** → cards and Stripe customers from the other connection are not shown as chargeable and are never sent to the new account. (Task 6 test `ignores cards from another connection`; Task 7 test `refuses a card from a non-default connection`.)

---

### Task 1: Bill.com record-payment call (do first; sandbox check)

The spec makes this the first build task so we learn early whether token sessions may call it.

**Files:**
- Create: `src/lib/billcom/recordPayment.ts`
- Test: `src/lib/billcom/recordPayment.test.ts`

**Interfaces:**
- Consumes: `BillcomClient.request<T>(path, init?)` from `src/lib/billcom/client.ts`.
- Produces:
  ```ts
  export interface RecordCardPaymentInput {
    billcomInvoiceId: string; customerId: string; amount: number;
    paymentDate: string /* YYYY-MM-DD */; description: string;
  }
  export async function recordBillcomCardPayment(client: BillcomClient, input: RecordCardPaymentInput): Promise<{ paymentId: string | null }>;
  ```

- [ ] **Step 1: Write the failing tests**
  - `posts to /v3/invoices/record-payment with CREDIT_CARD`: fake client captures `(path, init)`; assert path `'/v3/invoices/record-payment'`, method `POST`, JSON body equals `{ customerId: 'cu1', paymentDate: '2026-11-17', paymentType: 'CREDIT_CARD', description: 'Stripe pi_123', invoices: [{ id: 'inv1', amount: 12.34 }] }`.
  - `returns the payment id`: response `{ id: '0rp1' }` → `{ paymentId: '0rp1' }`; response `{}` → `{ paymentId: null }`.
  - `propagates Bill.com errors`: client rejects with `BillcomApiError` → same error rethrown.
- [ ] **Step 2: Run** `npx vitest run src/lib/billcom/recordPayment.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** `recordBillcomCardPayment` as above. Amount sent as a number with 2 decimals (`Math.round(amount * 100) / 100`).
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Sandbox check (needs the user).** Ask the user to run the probe they already have, or to approve a one-off call: `record <sandboxConnectionId> <openSandboxInvoiceId>` from `/private/tmp/claude-501/-Users-macbook-Documents-AI-Dev-Projects-Artwork-Review-Tool/838d5329-0714-4f2e-a283-7bf6601a2b8a/scratchpad/billcom-record-payment-probe.mjs` ($0.01). Record the outcome (HTTP status, response shape, whether `customerId` is required, the id field name) in the spec under Constraints. If Bill.com refuses for token sessions, continue the plan unchanged — the manual button (Task 7) is the path — and note it for the user. If the user defers, continue and leave a BACKLOG note.
- [ ] **Step 6: Commit**
  ```bash
  git add src/lib/billcom/recordPayment.ts src/lib/billcom/recordPayment.test.ts
  git commit -m "feat(billcom): record an outside card payment on an invoice"
  ```

### Task 2: Database migration

**Files:**
- Create: `supabase/migrations/066_stripe_saved_cards.sql`
- Modify: `src/types/database.ts` (row types for the new tables)
- Create: `src/types/stripe.ts` (`StripeConnectionSummary`, `StripeTestResult`, `CardLabel = { id; brand; last4; expMonth; expYear; savedAt; stripePaymentMethodId; stripeConnectionId }`, `CustomerCardView`, `CardPaymentRow`, `BillcomLookup` (the return type of `findBillcomInvoiceForCharge`, Task 7), `ChargeEligibility`)

**Interfaces:**
- Produces tables (columns exactly as in the spec "Data" section, plus):
  - `stripe_connections`: `id`, `organization_id`, `display_name`, `secret_key_secret_id uuid`, `webhook_secret_secret_id uuid`, `livemode boolean`, `stripe_account_id text`, `is_enabled bool default false`, `is_default bool default false`, `created_at`, `updated_at`; unique index one default per org.
  - `stripe_customers`, `customer_cards`, `card_setup_links`, `card_payments` with `stripe_connection_id uuid not null references stripe_connections(id) on delete cascade`.
  - `card_payments` adds `bc_invoice_id text not null`, `billcom_customer_id text not null`, `invoice_number text not null`, `sales_order_id uuid null`, `recorded_manually_by uuid null`.
  - Indexes: unique `(stripe_connection_id, bc_customer_number)` on `stripe_customers`; unique `(stripe_connection_id, stripe_payment_method_id)` and partial unique `(stripe_connection_id, bc_customer_number) where removed_at is null` on `customer_cards`; unique `token_hash` on `card_setup_links`; unique `stripe_payment_intent_id` and partial unique `(billcom_invoice_id) where status = 'processing' or (status = 'succeeded' and billcom_state not in ('recorded','recorded_manually'))` on `card_payments`.
  - Check constraints for `status` and `billcom_state` values.
  - Vault RPCs: `set_stripe_secret_key(uuid,text)`, `get_stripe_secret_key(uuid)`, `set_stripe_webhook_secret(uuid,text)`, `get_stripe_webhook_secret(uuid)`, `delete_stripe_secrets(uuid)` — shaped exactly like 046, same revoke/grant block.

- [ ] **Step 1: Write the migration** following 045/046 patterns and the constraints above.
- [ ] **Step 2: Lint the SQL by eye against 045/046** (no `create policy`, all `if not exists`, revoke block present for every function and table).
- [ ] **Step 3: Add the TypeScript row types** and `src/types/stripe.ts`.
- [ ] **Step 4: Run** `npx tsc --noEmit` — expect no new errors.
- [ ] **Step 5: Ask the user to apply 066** to the TEST/dev database (their usual SQL editor flow). Do not continue to Task 3's live checks until applied; unit tests can proceed.
- [ ] **Step 6: Commit**
  ```bash
  git add supabase/migrations/066_stripe_saved_cards.sql src/types/database.ts src/types/stripe.ts
  git commit -m "feat(db): tables and Vault accessors for Stripe saved cards"
  ```

### Task 3: Stripe connection — library, admin actions, Admin card

**Files:**
- Modify: `package.json` / `package-lock.json` (`npm install stripe` — pin the exact installed version)
- Create: `src/lib/stripe/connection.ts`, `src/lib/stripe/connection.test.ts`
- Create: `src/app/actions/stripe.ts`, `src/app/actions/stripe.test.ts`
- Create: `src/components/stripe/StripeConnectionsCard.tsx`, `src/components/stripe/StripeConnectionsCard.test.tsx`
- Modify: `src/app/(protected)/admin/page.tsx` (mount the card next to `BillcomConnectionsCard`)

**Interfaces:**
- Produces (`src/lib/stripe/connection.ts`, `import 'server-only'`):
  ```ts
  export interface StripeScope { supabase: SupabaseClient; orgId: string; connectionId: string; stripe: Stripe }
  export async function resolveDefaultStripeConnection(supabase: SupabaseClient, orgId: string): Promise<{ id: string; enabled: boolean; livemode: boolean } | null>;
  export async function createStripeForConnection(supabase: SupabaseClient, orgId: string, connectionId: string): Promise<Stripe>; // throws if disabled or key missing
  export async function getWebhookSecret(supabase: SupabaseClient, connectionId: string): Promise<string | null>;
  ```
- Produces (`src/app/actions/stripe.ts`, admin-only via a local `requireAdmin` like `billcom.ts`): `listStripeConnections()`, `saveStripeConnection(input: { id?: string; displayName: string; secretKey?: string; webhookSecret?: string; isDefault: boolean })`, `setStripeConnectionEnabled(id, enabled)`, `deleteStripeConnection(id)`, `testStripeConnection(id): Promise<StripeTestResult>` (calls `stripe.accounts.retrieve()`, stores `livemode` + `stripe_account_id`).

- [ ] **Step 1: Write failing tests** (mock style of `src/app/actions/billcom.test.ts`):
  - `non-admin is refused` for every action (`'You do not have permission to manage Stripe connections'`).
  - `save stores keys via Vault RPCs and never on the row`: assert rpc calls `set_stripe_secret_key` / `set_stripe_webhook_secret`; no insert/update `values` contain a key string.
  - `foreign connection id fails closed` (`Stripe connection X was not found.`).
  - `secret key must start with sk_test_ or sk_live_; webhook secret with whsec_` → validation errors.
  - `test stores livemode and account id`.
  - `createStripeForConnection throws when disabled` without calling Vault.
  - Card component: lists connections, shows `Test`/`Live` badge, shows webhook URL `${NEXT_PUBLIC_APP_URL}/api/stripe/webhook/{id}` with a copy button, key inputs are password-type and never prefilled.
- [ ] **Step 2: Run** `npx vitest run src/lib/stripe src/app/actions/stripe.test.ts src/components/stripe` — expect FAIL.
- [ ] **Step 3: Implement** the library, actions and card, mirroring `billcom.ts` / `BillcomConnectionsCard.tsx` structure.
- [ ] **Step 4: Run** the same command — expect PASS; run `npm test` — no regressions.
- [ ] **Step 5: Commit**
  ```bash
  git add package.json package-lock.json src/lib/stripe/connection.ts src/lib/stripe/connection.test.ts src/app/actions/stripe.ts src/app/actions/stripe.test.ts src/components/stripe "src/app/(protected)/admin/page.tsx"
  git commit -m "feat(stripe): per-organization Stripe connection in Admin"
  ```

### Task 4: Permission "Charge saved cards"

**Files:**
- Modify: `src/types/database.ts` (`PermissionOverrides.chargeSavedCards?: boolean`)
- Modify: `src/lib/auth/permissions.ts` (`canChargeSavedCards` in `ResolvedUserAccess`, `ACCESS_KEYS`, `OVERRIDE_TO_ACCESS_KEY`; base value `false` for everyone including admins)
- Modify: `src/components/admin/UserList.tsx` (toggle labelled `Charge saved cards`, next to customer permissions)
- Test: `src/lib/auth/permissions.test.ts`

- [ ] **Step 1: Write failing tests:** `canChargeSavedCards is false by default for admin and user`; `override true enables it`; `override false keeps it off`.
- [ ] **Step 2: Run** `npx vitest run src/lib/auth/permissions.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the three edits plus the UserList toggle.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git add` the four files; message `feat(auth): Charge saved cards permission`.

### Task 5: Setup links, public page, card saving, webhook

**Files:**
- Create: `src/lib/stripe/setupLinks.ts`, `src/lib/stripe/setupLinks.test.ts`
- Create: `src/lib/stripe/saveCard.ts`, `src/lib/stripe/saveCard.test.ts`
- Create: `src/app/(public)/card-setup/[token]/page.tsx`
- Create: `src/app/(public)/card-setup/[token]/done/page.tsx`
- Create: `src/app/api/stripe/webhook/[connectionId]/route.ts`, `route.test.ts`
- Modify (only if needed): `src/middleware.ts` matcher so `/card-setup/*` and `/api/stripe/webhook/*` are reachable without a session — check first.

**Interfaces:**
- Produces (`setupLinks.ts`):
  ```ts
  export const SETUP_LINK_DAYS = 14;
  export function newSetupToken(): { token: string; tokenHash: string };
  export function hashSetupToken(token: string): string;
  export function setupLinkUrl(token: string): string; // `${NEXT_PUBLIC_APP_URL}/card-setup/${token}`
  export async function createSetupLink(supabase, a: { orgId; connectionId; bcCustomerNumber; createdBy; emailedTo: string | null }): Promise<{ id: string; url: string; expiresAt: string }>; // cancels earlier unused links first
  export async function findUsableSetupLink(supabase, token: string, now?: Date): Promise<SetupLinkRow | null>; // null if unknown/expired/cancelled/completed
  export async function cancelSetupLinks(supabase, a: { orgId; connectionId; bcCustomerNumber }): Promise<void>;
  ```
- Produces (`saveCard.ts`):
  ```ts
  export async function ensureStripeCustomer(scope: StripeScope, a: { bcCustomerNumber: string; name: string; email: string | null }): Promise<string>;
  export async function saveCardFromCheckoutSession(scope: StripeScope, checkoutSessionId: string): Promise<{ brand: string; last4: string } | null>;
  ```
  `saveCardFromCheckoutSession`: retrieve session (expand `setup_intent.payment_method`); ignore unless `mode === 'setup'` and status `complete` and metadata org matches scope; upsert `customer_cards` on `(stripe_connection_id, stripe_payment_method_id)`; if a different active card exists, set its `removed_at` and `stripe.paymentMethods.detach` it; set `invoice_settings.default_payment_method`; set link `completed_at`. A unique-violation on the active-card index is treated as "already saved".
- Public page: server component; `findUsableSetupLink` → else render invalid page; `ensureStripeCustomer`; `stripe.checkout.sessions.create({ mode: 'setup', customer, currency: 'usd', payment_method_types: ['card'], success_url, cancel_url, custom_text: { submit: { message: consentText } }, metadata })`; store session id; `redirect(session.url)`.
- Webhook: `export async function POST(req, { params })` — read raw body (`await req.text()`), `stripe.webhooks.constructEvent(body, sig, secret)`; 400 on bad signature; handle `checkout.session.completed` → `saveCardFromCheckoutSession`; 200 for everything else.

- [ ] **Step 1: Write failing tests:**
  - `newSetupToken gives 43-char base64url token and matching sha256 hex`.
  - `rejects expired/cancelled/completed tokens` (three cases → `null`); `accepts a fresh token`.
  - `createSetupLink cancels earlier unused links` (assert update on `card_setup_links` with `canceled_at` before insert) and `expiresAt` = now + 14 days.
  - `saveCardFromCheckoutSession saves brand/last4/expiry only` (assert inserted values keys ⊆ allowed list; no `number`/`cvc`).
  - `saving twice is idempotent` (second call → no second insert, no second detach).
  - `replacing a card removes and detaches the old one`.
  - `ignores sessions from another organization` (metadata mismatch → `null`, no writes).
  - Webhook: `bad signature → 400`; `checkout.session.completed → saves card, 200`; `other event → 200, no save`; `unknown connection id → 404`.
- [ ] **Step 2: Run** `npx vitest run src/lib/stripe src/app/api/stripe` — expect FAIL.
- [ ] **Step 3: Implement** the files above. Invalid-link page text: `This link is no longer valid — please contact us.` Done page: `Thanks — your card ending {last4} is saved.` (falls back to `Thanks — your card is saved.` if not yet saved).
- [ ] **Step 4: Run** — expect PASS; `npm test` — no regressions.
- [ ] **Step 5: Commit**
  ```bash
  git add src/lib/stripe/setupLinks.ts src/lib/stripe/setupLinks.test.ts src/lib/stripe/saveCard.ts src/lib/stripe/saveCard.test.ts "src/app/(public)/card-setup" src/app/api/stripe
  git commit -m "feat(stripe): card setup link page, card saving and webhook"
  ```

### Task 6: Customer page — "Card on file" card + email/copy link

**Files:**
- Create: `src/app/actions/customerCards.ts`, `src/app/actions/customerCards.test.ts`
- Modify: `src/lib/email.ts` (add `sendCardSetupEmail`)
- Create: `src/components/customers/CardOnFileCard.tsx`, `CardOnFileCard.test.tsx`
- Modify: `src/app/(protected)/customers/[id]/page.tsx`, `src/components/customers/CustomerDetail.tsx` (load + render the card)
- Modify: `.env.example` (`CUSTOMER_EMAIL_FROM=`)

**Interfaces:**
- Produces (`customerCards.ts`, `'use server'`; links/remove need `canEditCustomers`; view needs `canViewCustomers`):
  ```ts
  export async function getCustomerCardView(bcCustomerNumber: string): Promise<CustomerCardView>;
  // CustomerCardView = { stripe: 'off' | 'ready'; card: { brand; last4; expMonth; expYear; savedAt } | null; openLink: { createdAt; expiresAt; emailedTo: string | null } | null; canEdit: boolean }
  export async function createCardSetupLink(bcCustomerNumber: string, opts: { email: string | null }): Promise<{ url: string; expiresAt: string }>;
  export async function cancelCardSetupLink(bcCustomerNumber: string): Promise<void>;
  export async function removeCustomerCard(bcCustomerNumber: string): Promise<void>; // sets removed_at/by, detaches in Stripe
  ```
- Produces (`email.ts`): `export async function sendCardSetupEmail(p: { to: string; organizationName: string; customerName: string; url: string; expiresAt: string }): Promise<void>` — **throws** on missing `RESEND_API_KEY`, missing `CUSTOMER_EMAIL_FROM`, or a Resend error (unlike `sendEmail`, staff must know it failed). Subject: `Add a card for {organizationName}`. Body: short note, the link, `This link expires on {date}.` No card data.

- [ ] **Step 1: Write failing tests:**
  - `ignores cards from another connection` (only default connection's active card is returned).
  - `stripe off when no enabled default connection`.
  - `createCardSetupLink with email sends the email and stores emailed_to`; `without email returns url only`.
  - `email failure surfaces an error and leaves no usable link` (link cancelled on send failure).
  - `invalid email rejected` (`Enter a valid email address.`).
  - `permission: view-only user cannot create/cancel/remove`.
  - Component: no card → `No card on file.` + `Email link` + `Copy link`; card → `Visa •••• 4242, exp 08/28` + `Send new link` + `Remove card`; open link → `Link sent Nov 16 · expires Nov 30` + `Cancel link`; Copy writes URL to `navigator.clipboard` and shows `Copied — expires Nov 30`; Email opens a dialog prefilled with the customer email; `stripe: 'off'` → `Stripe isn't set up — an admin can add it in Admin.`
- [ ] **Step 2: Run** `npx vitest run src/app/actions/customerCards.test.ts src/components/customers/CardOnFileCard.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement.** Customer email default comes from the customer detail already loaded by the page.
- [ ] **Step 4: Run** — expect PASS; `npm test` — no regressions.
- [ ] **Step 5: Commit** `git add` the files above; message `feat(customers): card on file — email or copy a setup link`.

### Task 7: Charging — logic and actions

**Files:**
- Create: `src/lib/stripe/chargeInvoice.ts`, `src/lib/stripe/chargeInvoice.test.ts`
- Create: `src/app/actions/cardPayments.ts`, `src/app/actions/cardPayments.test.ts`

**Interfaces:**
- Consumes: `recordBillcomCardPayment` (Task 1); `readBillcomInvoiceStatus` (`src/lib/billcom/invoiceStatus.ts`; the Bill.com invoice id is `status.id`); `getSalesInvoicePage` / the by-number lookup logic in `getSalesInvoiceBillcomPanel` (extract the lookup into an exported `findBillcomInvoiceForCharge(input: BillcomPanelInput)` in `src/lib/receivables/salesInvoicePage.ts` returning `{ kind: 'found'; status; billcomCustomerId } | { kind: 'not_linked' | 'not_found' | 'ambiguous' | 'off' }`); `createStripeForConnection` (Task 3).
- Produces (`chargeInvoice.ts`):
  ```ts
  export function chargeEligibility(a: { canCharge: boolean; card: CardLabel | null; billcom: BillcomLookup; today: string }): ChargeEligibility;
  // ChargeEligibility = { ok: true; amount: number; dueDate: string } | { ok: false; reason: string }
  export async function chargeInvoice(deps: ChargeDeps, a: { bcInvoiceId: string; userId: string }): Promise<CardPaymentRow>;
  export async function retryBillcomRecord(deps: ChargeDeps, cardPaymentId: string): Promise<CardPaymentRow>;
  export async function markRecordedManually(deps: ChargeDeps, cardPaymentId: string, userId: string): Promise<CardPaymentRow>;
  export async function checkChargeStatus(deps: ChargeDeps, cardPaymentId: string): Promise<CardPaymentRow>; // settles 'processing' via stripe.paymentIntents.search on metadata card_payment_id
  ```
  `ChargeDeps` bundles supabase, orgId, Stripe scope, Bill.com client, `now()` — injected so tests need no network.
- Reasons (exact): `No card on file — send a setup link from the customer page.` · `This invoice isn't in Bill.com yet.` · `More than one Bill.com invoice matches this number.` · `Nothing is due on this invoice.` · `This invoice isn't past due yet.` · `Stripe isn't set up.` · `You don't have permission to charge cards.`
- Produces (`cardPayments.ts`, `'use server'`, all require `canChargeSavedCards` except the read): `getInvoiceChargeView(bcInvoiceId)` → `{ eligibility; card; payments: CardPaymentRow[] }`, `chargeInvoiceCard(bcInvoiceId)`, `retryCardPaymentBillcom(id)`, `markCardPaymentRecordedManually(id)`, `checkCardPaymentStatus(id)`.

- [ ] **Step 1: Write failing tests** (`chargeInvoice.test.ts`, fakes for Stripe/Bill.com/supabase):
  - `chargeEligibility` table test covering every reason above and the ok case.
  - `uses fresh due amount`: page saw $100, Bill.com re-read says $60 → PaymentIntent amount `6000`.
  - `refuses when nothing is due` (fresh `dueAmount` 0 → throws reason, no insert).
  - `cents rounding`: `1234.56` → `123456`.
  - `creates PaymentIntent off_session+confirm with idempotency key = card_payments.id and receipt_email`.
  - `success → status succeeded then Bill.com recorded` (order: insert processing → Stripe → update succeeded → record-payment → update recorded).
  - `Bill.com failure → succeeded + billcom failed, error stored`.
  - `card declined → status failed with Stripe message, no Bill.com call`.
  - `authentication_required → failed with "The bank needs the customer to approve this charge — send a new setup link."`.
  - `network error → stays processing`; `checkChargeStatus settles it from Stripe`.
  - `second concurrent charge is rejected by the unique index` (insert returns `23505` → throws duplicate-charge message, no Stripe call).
  - `refuses a card from a non-default connection`.
  - `retryBillcomRecord only from billcom failed`; `markRecordedManually sets recorded_manually + who/when`.
  - Actions: `permission enforced on every mutating action`.
- [ ] **Step 2: Run** `npx vitest run src/lib/stripe/chargeInvoice.test.ts src/app/actions/cardPayments.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**, including the `findBillcomInvoiceForCharge` extraction (keep `getSalesInvoiceBillcomPanel` behaviour identical; its existing tests must still pass).
- [ ] **Step 4: Run** — expect PASS; `npm test` — no regressions.
- [ ] **Step 5: Commit** `git add` the files above plus `src/lib/receivables/salesInvoicePage.ts`; message `feat(receivables): charge a past-due invoice to the saved card`.

### Task 8: Invoice page — Charge card panel

**Files:**
- Create: `src/components/receivables/CardChargePanel.tsx`, `CardChargePanel.test.tsx`
- Modify: `src/app/(protected)/receivables/invoices/[bcInvoiceId]/page.tsx` (stream it in a `Suspense` like `BillcomSide`)
- Modify: `src/components/receivables/SalesInvoiceDetail.tsx` (slot for the panel)

- [ ] **Step 1: Write failing tests:**
  - eligible → `Charge card` button; click → confirm dialog with exact confirm text; Confirm calls `chargeInvoiceCard`.
  - not eligible → reason text, no button.
  - payments list rows: date, amount, `Visa •••• 4242`, who, Stripe status, Bill.com status.
  - `billcom failed` row → `Charged in Stripe — Bill.com not updated` + `Retry Bill.com` + `I marked it paid in Bill.com` (with confirm).
  - `processing` row → `Checking with Stripe…` + `Check status`.
  - button disabled while a request is in flight (no double submit).
- [ ] **Step 2: Run** `npx vitest run src/components/receivables/CardChargePanel.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement** in the existing dark design system.
- [ ] **Step 4: Run** — expect PASS; `npm test`; `npm run lint`; `npm run build` — all pass.
- [ ] **Step 5: Commit** `git add` the files above; message `feat(receivables): Charge card panel on the invoice page`.

### Task 9: End-to-end check in the running app

Needs the user for keys and sending-domain setup.

- [ ] **Step 1: Prerequisites (user):** migration 066 applied; Stripe **test-mode** keys; a Resend verified sending domain and `CUSTOMER_EMAIL_FROM` set (e.g. `billing@yourdomain.com`) — without it, Email link fails with a clear error and Copy link still works.
- [ ] **Step 2:** `npm run dev`; in Admin add the Stripe test connection, Test it (shows `Test`), set default; run `stripe listen --forward-to localhost:3000/api/stripe/webhook/<connectionId>` and paste its `whsec_` into the connection.
- [ ] **Step 3:** Give a test user `Charge saved cards`. On a customer page: Copy link → open in a private window → card `4242 4242 4242 4242` → done page shows `ending 4242` → customer page shows the card. Reopen the same link → invalid page.
- [ ] **Step 4:** On a past-due invoice whose customer has the card: Charge card → confirm → Stripe test payment appears; row shows Bill.com recorded (or failed + manual button if Task 1 found token sessions refused); Bill.com sandbox invoice shows paid.
- [ ] **Step 5:** Repeat with `4000 0000 0000 9995` (declined message) and `4000 0025 0000 3155` saved then charged (approval-needed message).
- [ ] **Step 6:** Update `BACKLOG.md` (feature shipped to the branch; follow-ups: auto-charge, refunds, BC recording via Payments project, production Stripe keys + live webhook) and commit:
  ```bash
  git add ../BACKLOG.md
  git commit -m "docs(backlog): Stripe saved cards status and follow-ups"
  ```
