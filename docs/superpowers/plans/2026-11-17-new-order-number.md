# New Order Number Up Front: Implementation Plan

**Goal:** Opening New sales order takes BC's next order number; the order keeps it, and the Invoice # shows it before saving.

**Spec:** `docs/superpowers/specs/2026-11-17-new-order-number-preview-design.md`

## Global Constraints

- Only a number reserved by the same user, and used by no order, can be saved. Each number belongs to one order (unique per org + connection).
- BC's counter only moves forward. Moves are guarded by the No. Series line etag, with a re-read and a new candidate on a clash (max 5 tries).
- Manual Nos. off: no number is taken; the error says `Turn on Manual Nos. for number series <code> in Business Central to give new orders their number up front.`
- Failure on the page: muted `Order number will be assigned when saved.` plus the reason; the page works as today.
- The Invoice # stays automatic (`invoice_number` null) unless typed by hand.

## Review Focus

1. Two users open New at the same moment → different numbers (a clash retries with a fresh read). Test: `takeNextNumber: a clash re-reads and takes the next one`.
2. The client sends a number it didn't reserve, or one already used → refused, nothing written. Tests in Task 3.
3. React dev double effects → one reservation per page open (ref guard). Test: `reserves once`.
4. Order saved, BC sync not yet done → list and page show the reserved number, not "Not yet in BC". Task 4 tests.
5. Reservation fails → page still saves as today, with no number sent. Task 4 test.

### Task 1: Migration 068 + types
- `nexus/supabase/migrations/068_sales_order_number_reservations.sql`:
  - table `sales_order_number_reservations` (id, organization_id, bc_connection_id, number, reserved_by, reserved_at, sales_order_id unique null → sales_orders on delete set null);
  - unique (organization_id, bc_connection_id, number);
  - RLS on with no policies (service client only);
  - `alter table sales_orders add column reserved_order_number text`, plus a unique partial index (organization_id, bc_connection_id, reserved_order_number).
- `src/types/salesOrders.ts`: add `reserved_order_number: string | null` to SalesOrderRow and the list row; `SalesOrderInput.reserved_order_number?: string | null`.

### Task 2: `src/lib/salesOrders/orderNumberReservation.ts`
- `findOrderSeries(transport, latestOrderNumber: string | null): Promise<string>`. With a latest number, filter `salesDocuments` by `documentType eq 'Order' and number eq '<n>'`. Otherwise list the orders and take the first non-empty `numberSeries`. If none is found: `Couldn't tell which number series BC uses for sales orders.`
- `requireManualNos(transport, seriesCode)`: reads the NoSeries page (`LIST_DEFINITIONS.noSeries.source`, select Code + Manual_Nos) and throws the constraint message when it's off.
- `takeNextNumber(noSeries: NoSeriesClient, seriesCode, today): Promise<string>`:
  - `getOpenLine` → candidate = `incrementNo(lastNoUsed, incrementByNo, startingNo)`;
  - range check → `advanceLine(line, candidate, today)`;
  - on `NoSeriesConflictError`, re-read and retry (max 5).
- Tests for each, including the clash retry, exhausted range and Manual Nos. off.

### Task 3: Actions + BC create
- `reserveSalesOrderNumber(): Promise<{ ok: true; number: string } | Fail>` in `salesOrders.ts`:
  - editScope;
  - latest `bc_order_number` of this org + connection;
  - series → manual check → take → insert reservation.
- `saveSalesOrder` create with `reserved_order_number`:
  - the reservation must exist for this org, connection and user, with `sales_order_id` null; otherwise `This order number can't be used. Reload the page to get a new one.`;
  - insert the order with it, then claim the reservation (`sales_order_id` null → id); if the claim finds no row, delete the order and refuse.
- `toBcCreate`: add `No` when `reserved_order_number` is set.
- The list select includes `reserved_order_number`.
- Tests: reserve without permission is refused; save with someone else's or a used reservation is refused with no writes; a valid one stores and claims; `toBcCreate` includes No.

### Task 4: Form + list
- New page: reserve once on mount (ref guard).
  - Title `New sales order W-100536`; Invoice # automatic from it; the save sends it.
  - On failure, the muted note.
- Saved order: everywhere the number shows (title, Order heading, Invoice #), use `bc_order_number || reserved_order_number`. Same in the list.
- Tests: reserves once; number in the title and Invoice #; save sends it; failure note and save without it; the list shows the reserved number.

### Task 5: Live check on TEST
- Needs the user to: apply 068 and tick Manual Nos. on WHSL.
- Open New → number shown → save with Customer PO → BC order has that number, Invoice # `W-1005xx / PO`.
- A second New shows the next number.
- Record the results in the spec; commit.
