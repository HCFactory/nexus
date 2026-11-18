# Invoice Numbering and Invoice Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receivables invoices are listed by Invoice # (BC External Document No.) and open into a Nexus invoice page with lines and a live Bill.com status panel.

**Architecture:** The page reads Nexus's existing copy of posted BC invoices and lines (`business_central_sales_invoices`, `business_central_sales_invoice_lines`), filling gaps from BC on demand through one shared mirror module that the invoice process also uses right after posting. The Bill.com panel is an async server component behind `<Suspense>` that reads one Bill.com invoice live.

**Tech Stack:** Next.js 16 App Router (server components, Suspense), React 19, Supabase (service client, org + connection scoped), Vitest + jsdom, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-11-15-invoice-page-design.md`

## Global Constraints

- TEST BC and the Bill.com sandbox only. All reads; this plan never posts, creates or edits anything in BC or Bill.com.
- Every Supabase query is scoped by `organization_id` AND `bc_connection_id` (service client bypasses RLS).
- Viewing needs the existing receivables view permission (`canViewReceivables`, as `getSalesInvoicesPageData` uses).
- Column labels exactly: `Invoice #` (from `external_document_number`, `—` when blank) then `BC Invoice No.` (from `bc_invoice_number`).
- No PDF link: Bill.com v3 has none (discovery below).
- Stage specific paths only; never `git add -A`; never stage `droid-telegram-bot`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run commands from `nexus/`.

## Discovery (done, read-only, 2026-11-15)

- `GET /v3/invoices/{id}` returns `invoiceNumber, invoiceDate, dueDate, customerId, totalAmount, dueAmount, status ("OPEN"), payments[], invoicePdfId ("00000000000000000000")`.
- `/v3/invoices/{id}/pdf`, `/link`, `/documents` → 404. No PDF/web link: omit it.
- The sandbox has no invoices copied by Bill.com's own BC connector, so their numbering can't be checked: look up by Invoice # first, then by BC Invoice No.; no match → "Not found in Bill.com".

## Rulings in this plan

- **URL key is the BC invoice id** (`/receivables/invoices/<bc_invoice_id>`), not the Nexus row id the spec named: the sales order knows `bc_posted_invoice_id` but not the Nexus row id, and a missing Nexus row can then be filled from BC. If wrong: one route param.
- **Status label:** `OPEN`→`Open`, `PARTIALLY_PAID`→`Partially paid`, `PAID_IN_FULL`→`Paid`, `VOID`→`Void`; any other value title-cased (`SCHEDULED`→`Scheduled`). If wrong: one map.

## Review Focus

1. An invoice id from another org or connection, or unknown in BC → the page is a 404, never another org's data.
2. Bill.com turned off, failing, or the customer not linked → the panel shows a short message; header and lines still render.
3. An invoice whose External Document No. is blank → `—` in the list and on the page; search still finds it by BC Invoice No.
4. Stored lines missing (new invoice, line sync not run) → lines are fetched from BC once, stored, and shown; an invoice BC reports with zero lines shows "No lines".
5. A Bill.com lookup by number must match the exact invoice number of that customer only (never a prefix match).

Each item's test is in the owning task.

---

### Task 1: Shared invoice mirror (BC → Nexus copy)

**Files:**
- Create: `nexus/src/lib/businessCentral/invoiceMirror.ts`, `nexus/src/lib/businessCentral/invoiceMirror.test.ts`
- Modify: `nexus/src/lib/salesOrders/invoiceDeps.ts` (replace the inline upsert in `mirrorPostedInvoice` with the module; also copy lines)

**Interfaces:**
- Consumes: `mapBcSalesInvoiceToDb` (`salesInvoiceMapper.ts`), `mapBcSalesInvoiceLineToDb` (`salesInvoiceLineMapper.ts`), `BcClient.listResourcePage(resource, { filter, top })`.
- Produces:
  ```ts
  export interface InvoiceMirrorDeps {
    supabase: SupabaseClient
    listResourcePage: <T>(resource: string, opts: { filter?: string; top?: number }) => Promise<T[]>
    orgId: string; connectionId: string; environment: string; companyId: string
    now: () => string
  }
  export async function mirrorSalesInvoice(deps: InvoiceMirrorDeps, raw: BcSalesInvoice): Promise<void>
  export async function mirrorSalesInvoiceLines(deps: InvoiceMirrorDeps, bcInvoiceId: string): Promise<number> // lines stored
  export async function fetchAndMirrorSalesInvoice(deps: InvoiceMirrorDeps, bcInvoiceId: string): Promise<boolean> // false when BC has no such posted invoice
  ```
  Upserts use the same conflict targets as the Receivables sync: invoices `organization_id,bc_connection_id,bc_company_id,bc_invoice_id`; lines `organization_id,bc_connection_id,bc_company_id,bc_line_id`. Lines are read with filter `documentId eq <id>` (unquoted GUID), `top: 500`. `fetchAndMirrorSalesInvoice` reads `salesInvoices` with filter `id eq <id>` and skips drafts (`isPostedInvoice`).

- [ ] **Step 1: Write the failing tests** in `invoiceMirror.test.ts` (use `fakeSupabase`):
  - `mirrorSalesInvoice upserts the mapped row with the Receivables conflict target`
  - `mirrorSalesInvoiceLines reads lines by documentId and upserts each mapped line; returns the count` (asserts filter `documentId eq g-1`, 2 rows written)
  - `mirrorSalesInvoiceLines with no lines writes nothing and returns 0`
  - `fetchAndMirrorSalesInvoice returns false for an unknown id and for a Draft, true and stores the row for a posted one`
- [ ] **Step 2:** `npx vitest run src/lib/businessCentral/invoiceMirror.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the three functions in `invoiceMirror.ts`; throw `Error(message)` on a Supabase error.
- [ ] **Step 4: Use it in `buildInvoiceDeps`:** `mirrorPostedInvoice` calls `mirrorSalesInvoice` then `mirrorSalesInvoiceLines(raw.id)`. Behaviour of `invoiceProcess.ts` is unchanged (still best effort, errors logged).
- [ ] **Step 5:** `npx vitest run src/lib/businessCentral src/lib/salesOrders && npx tsc --noEmit -p .` → PASS.
- [ ] **Step 6: Commit** `invoiceMirror.ts`, its test, `invoiceDeps.ts`: `feat(receivables): shared invoice mirror; copy lines right after posting`.

### Task 2: Bill.com invoice status lookup

**Files:**
- Create: `nexus/src/lib/billcom/invoiceStatus.ts`, `nexus/src/lib/billcom/invoiceStatus.test.ts`

**Interfaces:**
- Consumes: `BillcomClient.request<T>(path)`, `findBillcomInvoice` is NOT reused (it returns a summary without status); same paging rules (`max=100`, `nextPage`, 50 pages cap).
- Produces:
  ```ts
  export interface BillcomInvoiceStatus {
    id: string; invoiceNumber: string; status: string /* raw */; statusLabel: string
    totalAmount: number | null; dueAmount: number | null; dueDate: string | null
  }
  export function billcomStatusLabel(status: string): string
  export async function readBillcomInvoiceStatus(
    client: BillcomClient,
    q: { billcomInvoiceId?: string | null; billcomCustomerId?: string | null; invoiceNumbers: string[] },
  ): Promise<BillcomInvoiceStatus | null>
  ```
  Order: by id (`GET /v3/invoices/{id}`) when given; else, with a customer id, list `filters=customerId:eq:<id>` and take the first invoice whose `invoiceNumber` equals one of `invoiceNumbers` in order (exact, trimmed match; blanks ignored); else null.

- [ ] **Step 1: Failing tests:**
  - `billcomStatusLabel maps OPEN, PARTIALLY_PAID, PAID_IN_FULL, VOID and title-cases others` (`SCHEDULED`→`Scheduled`)
  - `reads by id when billcomInvoiceId is given` (one GET to `/v3/invoices/00eX`, fields mapped, `dueAmount: 45.23`)
  - `looks up by Invoice # first, then BC Invoice No., exact match only` (results contain `W-1 / PO` and `INV-9`; numbers `['W-1', 'INV-9']` → returns `INV-9`, never `W-1 / PO`)
  - `returns null with no id and no customer, and when nothing matches`
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS.
- [ ] **Step 5: Commit** both files: `feat(billcom): read an invoice's status and amount due`.

### Task 3: Invoice page data

**Files:**
- Create: `nexus/src/app/actions/salesInvoicePage.ts`, `nexus/src/app/actions/salesInvoicePage.test.ts`

**Interfaces:**
- Consumes: Task 1 `fetchAndMirrorSalesInvoice`, `mirrorSalesInvoiceLines`; Task 2 `readBillcomInvoiceStatus`; `requirePermission(canViewReceivables, …)`, `resolveActiveBcConnection`, `createBcClientForOrg`, `resolveBillcomConnection`, `createBillcomClientForConnection`.
- Produces (a `'use server'` file: async exports only):
  ```ts
  export async function getSalesInvoicePage(bcInvoiceId: string): Promise<{
    invoice: BusinessCentralSalesInvoice
    lines: BusinessCentralSalesInvoiceLine[]           // ordered by sequence
    salesOrder: { id: string; bcOrderNumber: string | null } | null
  } | null>                                            // null → page calls notFound()
  export async function getSalesInvoiceBillcomPanel(bcInvoiceId: string): Promise<
    | { kind: 'found'; status: BillcomInvoiceStatus }
    | { kind: 'off' } | { kind: 'not_linked' } | { kind: 'not_found' } | { kind: 'error'; message: string }
  >
  ```
  `getSalesInvoicePage`: row by `bc_invoice_id` in scope; missing → `fetchAndMirrorSalesInvoice` then re-read; still missing → null. No stored lines → `mirrorSalesInvoiceLines` once, re-read. `salesOrder` from `sales_orders` where `bc_posted_invoice_id = bcInvoiceId` (scoped).
  `getSalesInvoiceBillcomPanel`: Bill.com connection missing/disabled/client error → `off`; `sales_orders.billcom_invoice_id` when present → by id; else customer link (`billcom_customer_links` by `bc_customer_number`, `status = 'synced'`) missing → `not_linked`; else lookup with `[external_document_number, bc_invoice_number]`; null → `not_found`; thrown Bill.com error → `error` with its message.

- [ ] **Step 1: Failing tests** (mock auth/clients the way `businessCentralReceivables.billcom.test.ts` does):
  - `returns null for an invoice of another org or connection` (Review Focus 1)
  - `fills a missing row and missing lines from BC once` (mirror functions called once each; second call reads stored data without BC)
  - `links the sales order that posted it`
  - `Bill.com panel: off when Bill.com is disabled; not_linked without a customer link; found by the order's billcom_invoice_id; error keeps the message` (Review Focus 2)
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS; `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** both files: `feat(receivables): invoice page data and Bill.com panel lookup`.

### Task 4: Invoice page, list numbering, View invoice link

**Files:**
- Create: `nexus/src/app/(protected)/receivables/invoices/[bcInvoiceId]/page.tsx`, `nexus/src/components/receivables/SalesInvoiceDetail.tsx`, `nexus/src/components/receivables/BillcomInvoicePanel.tsx`, `nexus/src/components/receivables/SalesInvoiceDetail.test.tsx`
- Modify: `nexus/src/components/receivables/SalesInvoicesClient.tsx` (columns, row link, search), `nexus/src/components/salesOrders/InvoiceControls.tsx` (View invoice href; drop `RECEIVABLES_NOTE` title), their tests.

**Interfaces:**
- Consumes: Task 3 exports.
- Produces: route `/receivables/invoices/<bc_invoice_id>`.

Layout (spec sketch): header `Invoice <Invoice # or BC Invoice No.>` with `BC Invoice No. <no>` beside it; customer, invoice date, due date, BC status; `Sales order <no> →` link to `/sales-orders/<id>` when present; Bill.com panel (`<Suspense fallback="Loading Bill.com…">`): `Bill.com: <statusLabel> · <dueAmount> due of <totalAmount>`; messages `Bill.com is turned off.`, `This customer isn't linked to Bill.com.`, `Not found in Bill.com.`, `Couldn't reach Bill.com: <message>`. Lines table: Item (`line_object_number`), Description, Qty, Unit price, Disc %, Amount (`amount_excluding_tax`); empty → `No lines`; footer Subtotal (`total_amount_excluding_tax`), Tax (`total_tax_amount`), Total (`total_amount_including_tax`). Back link `← Invoices`. Labels styled like the sales order labels (`text-black dark:text-white`).

- [ ] **Step 1: Failing tests:**
  - `SalesInvoiceDetail.test.tsx`: shows Invoice #, BC Invoice No., lines and totals; shows `—`/BC number when External Document No. is blank (Review Focus 3); `No lines` when empty; Sales order link href `/sales-orders/so-1`.
  - `BillcomInvoicePanel` (same test file, rendered with each panel result): `Open · $45.23 due of $45.23`, and each message string above.
  - `SalesInvoicesClient` test: headings `Invoice #` then `BC Invoice No.`; a row links to `/receivables/invoices/<bc_invoice_id>`; searching a BC Invoice No. finds a row with a blank Invoice # (Review Focus 3).
  - `InvoiceControls` test: View invoice href is `/receivables/invoices/inv-guid` (the order's `bc_posted_invoice_id`).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** `npx vitest run && npx tsc --noEmit -p . && npm run lint` → PASS.
- [ ] **Step 5: Check in the app** (dev server already running on :3000): open Receivables › Invoices; INV-100412 row shows Invoice # `W-100532`; click it → page shows 1 item line (P-1001, qty 10, 4.50, 45.00), total 45.23, Bill.com `Open · $45.23 due`, Sales order link. From order W-100532 click View invoice → same page.
- [ ] **Step 6: Commit** the listed files: `feat(receivables): invoice page with Bill.com status; list by Invoice #`.
