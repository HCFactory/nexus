# New sales order takes its number when it opens (sales order changes, item #3)

Status: approved 2026-11-17 (short design; decisions made through questions in chat).

## Why

The user's words: "when new sales order is clicked, it uses the next sales order number once in the new sales order page before even saving. I want it to have the invoice # right away. Before syncing to BC."

User decisions:
- **Lock it in**: take the actual next number when the page opens, not just show it. The user first chose "show only", then changed to this. An abandoned New page leaves a gap, which the user accepted.
- **Turn on Manual Nos.** on the order number series in BC, so BC accepts an order created with its number. TEST now; production at go-live.

## How it works today

A new order has no number until Save. The background sync creates the BC order and BC assigns the next number. The Invoice # default (`<order #> / <Customer PO>`) stays blank until then.

## What BC TEST shows (read-only check, 2026-11-17)

- Every BC sales order (82) has `numberSeries = WHSL` (`salesDocuments`).
- No. Series WHSL: Normal, increment 1, `Manual_Nos: false` (the user will turn it on). Its line (page 457 `NoSeriesLines`, already published for item numbering) has `Last_No_Used W-100535`.

## What gets built

1. **Take the number when New opens.** The page opens at once; then Nexus asks BC for the next number:
   - the series is the one on BC's latest sales order (`salesDocuments.numberSeries`);
   - Nexus reads that series' open line and moves `Last_No_Used` forward by one, guarded by BC's etag, retrying on a clash so two people never get the same number;
   - it records the number as reserved by this user (new table).
   - Title: "New sales order W-100536". Invoice # shows `W-100536 / <Customer PO>` at once and follows the PO as it's typed. It stays the automatic value, not saved as hand-typed.
   - If the number can't be taken (Manual Nos. off, page 457 not published, BC down), the page works as today and shows one muted line: "Order number will be assigned when saved." plus the reason.
2. **Save.** The new order keeps its reserved number:
   - the server accepts only a number this user reserved and no order has used;
   - each number can belong to only one order (unique);
   - the sync creates the BC order with `No = W-100536`.
3. **Display.** Before the BC sync finishes, the order page, the orders list and the Invoice # use the reserved number instead of "Not yet in BC".
4. **BC refuses the number** (Manual Nos. turned off again, or someone typed that number in BC): the sync fails with BC's message, shown on the order like any sync failure. Nothing silently switches to another number.

## Non-goals

- No reuse of abandoned numbers. Gaps are accepted.
- No change for orders created in BC.

## Approaches

- **Take the number from BC's counter at open, create the order with it (picked).** Needs Manual Nos. on.
- Show only (read the counter, don't take it): the user's first pick, later changed.
- Create an empty BC order on open: leaves empty orders in BC. Not picked.

## Calls I made (Claude's)

- The series comes from BC's latest sales order, not a setting. TEST has one series; if several were ever used, the latest order's wins.
- A reservation belongs to the user who opened the page. Another user can't save with it.
- Opening New twice (two tabs, or a reload) takes two numbers. Each is a gap if not saved.
- Migration 068 (the user applies it): table `sales_order_number_reservations` and column `sales_orders.reserved_order_number`.

## Live check (TEST BC, 2026-11-17)

Setup: migration 068 applied, and Manual Nos. ticked on WHSL by the user.

- **New page:** opening New showed "New sales order W-100536" and Invoice # "W-100536". Typing PO ZZNUM-1 made it "W-100536 / ZZNUM-1".
- **Save:** order on TEST1 Zaha Mart with P-1001 × 1. After Save, the page showed W-100536, then "In BC".
- **BC:** order W-100536, sell-to TEST1, External Doc No. "W-100536 / ZZNUM-1", total 2.80. WHSL `Last_No_Used` = W-100536, so one page open took exactly one number (no double take from React's dev double effects).
- **Next New:** opening New again showed W-100537. It wasn't saved, so W-100537 is a gap, as agreed.
- **List:** W-100536 shows with Invoice # "W-100536 / ZZNUM-1".
- **Found while testing:** BC leaves `numberSeries` blank on an order created with its own number. The series is therefore now read from the latest order BC numbered itself (`reserved_order_number` null), not just the latest order.
- **Test data:** order W-100536 (Customer PO ZZNUM-1) is open in TEST BC. Delete it when it's no longer useful.
