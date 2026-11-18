# "BC only" invoicing for environments where Bill.com's connector copies invoices

Status: approved 2026-11-17 (short design; the user picked "Add a 'BC only' mode").

## Why

The user keeps Bill.com's own BC connector on in production for now: it copies BC invoices into Bill.com and sends payments back to BC. If Nexus also created the Bill.com invoice, every invoice would be in Bill.com twice. Nexus's Create invoice therefore has to post in BC only in production, and leave Bill.com to the connector. TEST keeps the full flow (TEST has no connector).

## Today

- Create invoice refuses to start when Bill.com is off or the customer isn't linked. When it runs, it posts in BC, then creates the Bill.com invoice.
- The Bill.com connection is per organisation. With production BC active, Nexus would push invoices to whatever Bill.com connection is the default (today the sandbox).
- Change invoice already skips Bill.com when Nexus has no Bill.com client.

## What gets built

1. **A switch per BC connection** (Settings → BC environments, edit): "Bill.com invoices come from Bill.com's own BC connector". Default off. Stored in `business_central_connections.billcom_via_connector` (migration 069).
2. **When it's on, for that BC environment:**
   - **Create invoice:** no Bill.com checks before starting; posts in BC; the order goes straight to Invoiced (no Bill.com step, nothing sent to Bill.com).
   - **Change invoice:** cancels and re-posts in BC only. No Bill.com check or update; BC itself refuses to cancel a paid invoice.
   - **Status text:** "Invoiced" instead of "Invoiced · In Bill.com", on the order and in the list. The same applies to any invoiced order with no Bill.com invoice.
   - **Bill.com client:** Nexus doesn't build one for this environment at all, so nothing can reach Bill.com from invoicing there.
3. **When it's off:** nothing changes (TEST).

## Non-goals

- What the connector then does in Bill.com (copying the posted invoice, a cancelled invoice and its credit memo, payments) is the connector's behaviour. It isn't checked here.
- Stripe Charge card needs a Nexus-made Bill.com invoice, so it isn't available on these orders. Stripe stays off for now anyway.

## Approaches

- **Switch on the BC connection (picked):** the connector is tied to a BC environment, so the setting lives there.
- Turn Bill.com off in Nexus and let Create invoice run without it: Bill.com is per org, so this would also turn off the full flow in TEST.
- Merge now and invoice in BC by hand: offered; the user chose this mode instead.

## Calls I made (Claude's)

- The switch label and default (off).
- Invoiced orders with no Bill.com invoice show "Invoiced", whatever the reason.
