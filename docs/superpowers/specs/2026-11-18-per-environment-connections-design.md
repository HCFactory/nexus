# Bill.com and Stripe connections per BC environment

Status: approved 2026-11-18 (short design; the user asked for it and picked "treat it as off").

## Why

The user: "can we make it so each environment uses different bill.com and stripe connection settings? but BC settings is per org?"

Today Nexus uses the organisation's **default** Bill.com and Stripe connection whatever BC environment is active. With Production active, a customer edit pushes the customer to the default Bill.com connection, the sandbox. And a live Stripe connection would also serve TEST.

## What gets built

1. **Two links per BC environment:** `business_central_connections.billcom_connection_id` and `.stripe_connection_id` (migration 071). Each is nullable, belongs to the same organisation, and is cleared if the linked connection is deleted.
2. **Admin → Business Central Environments → Edit:** two dropdowns, "Bill.com connection" and "Stripe connection", each listing the organisation's connections plus "None". The server refuses a connection that belongs to another organisation.
3. **Everywhere Nexus picks Bill.com or Stripe** uses the active BC environment's link:
   - **Bill.com:** customer push, invoicing, invoice pages, card payments' Bill.com step.
   - **Stripe:** customer card view and links, card payments.
   - **Nothing picked = off** (user decision). The existing "Bill.com is turned off" and "Stripe isn't set up" messages show. A linked connection that is disabled still counts as disabled.
4. **BC credentials stay per organisation** (unchanged).

## Not changing

- Stripe webhooks and card-setup pages already work from the connection stored on the link or payment, so they're unaffected.
- The connections' own "default" flag stays for now; it no longer decides anything.
- The "Bill.com invoices come from Bill.com's own BC connector" switch (069) stays. It skips Bill.com on invoicing even when a connection is linked.

## After deploy (user)

- On the Admin page, edit **TEST**: Bill.com = the sandbox connection, Stripe = the test-mode connection.
- Edit **Production**: Bill.com = None, Stripe = None, for now.
- Because the database is shared, set these in the local app **before** merging, so TEST keeps working the moment the code goes live.

## Approaches

- **Links on the BC environment (picked):** one place per environment; matches how 069's switch lives there.
- A BC environment column on each Bill.com/Stripe connection: same effect, but one Bill.com connection could then serve only one environment.
- Fall back to the org default when nothing is picked: the user chose "off" instead.
