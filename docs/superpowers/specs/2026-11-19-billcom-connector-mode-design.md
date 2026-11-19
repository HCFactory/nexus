# Bill.com "read and record payments" mode (alongside Bill.com's BC connector)

Status: approved 2026-11-19 ("just invoices and charge card for now").

## Why

Production keeps Bill.com's own BC connector: it copies BC customers and posted invoices into Bill.com and sends Bill.com payments back to BC. The user wants Nexus to read Bill.com (invoice payment status) and to use Stripe **Charge card** on Production invoices, which records the payment in Bill.com. Nexus must never create or change customers or invoices there.

## Discovery (production Bill.com, read-only, run by the user, 2026-11-19)

- **Invoice numbers:** Bill.com invoice number = BC External Doc. No., 100/100 (e.g. `W-116041`, `W-115661/ PO#002043`). No duplicates among 100.
- **Lookup by number:** `GET /v3/invoices?filters=invoiceNumber:eq:<n>` finds exactly the right invoice, 15/15.
- **Names and totals:** customer name and invoice total agree between Bill.com and BC, 15/15.
- **Customers:** Bill.com customers don't store the BC customer number (`accountNumber` empty on 99/100; no field holds it), so customers are not matched by number. The invoice names its Bill.com customer.

## What gets built

1. **Mode:** an environment with a Bill.com connection picked **and** `billcom_via_connector` ticked is in "read and record payments" mode.
2. **No writes except payments:** in this mode Nexus does no customer push on save or sync, no Push to Bill.com / Retry, and no invoice creation (already the case). The customers page and profile show no Bill.com push status.
3. **Invoice lookup:** by number directly, the External Doc. No. first and then the BC invoice no. It's a match only when Bill.com has exactly one invoice with that number **and** its total equals the BC total (to the cent) **and** its customer name equals the BC customer name (ignoring case, spaces and punctuation). Otherwise:
   - several invoices with the number: "ambiguous";
   - total or name differs: a new "doesn't match" state, which never charges.
4. **Invoice page Bill.com panel:** status, total, amount due and due date (unchanged UI), plus the new "doesn't match" message.
5. **Charge card:** records the payment on the found invoice, for the invoice's own Bill.com customer.

## Not changing

TEST (no connector tick) keeps Nexus-created invoices and customer push. Customer-level Bill.com info is later.

## Before Charge card goes live in Production

Merge the Stripe pre-live fixes (`fix/stripe-prelive`) and run their live check. Only then grant Charge saved cards.

## Calls I made (Claude's)

- Total check to the cent; name check normalized.
- A Bill.com read failure shows an error panel and never charges.
