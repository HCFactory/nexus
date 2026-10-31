# Customers → Bill.com — Design

Project #4 of 4 in the BC / Bill.com customer sync work (projects 1–3 done: reference lists, templates, Customers ↔ BC — see their specs in `docs/superpowers/specs/2026-10-2*/30-*`).

## Intent

Customers are now created and edited in Nexus (which writes BC) or directly in BC (which Nexus pulls on Sync). The user wants every BC customer to exist in Bill.com too, kept up to date automatically, so invoices can later be pushed to Bill.com (piece E) against the right customer.

Success: after a one-time initial push, every BC customer has exactly one matching Bill.com customer (inactive if blocked); creating or changing a customer in Nexus — or in BC, after a Sync — updates Bill.com without anyone touching Bill.com; blocked customers are inactive in Bill.com.

## Decisions (the user's)

- **Direction:** one-way, Nexus/BC → Bill.com. Bill.com is never read back into Nexus/BC except to match.
- **Matching key:** Bill.com customer **Account number** = BC customer number. Existing Bill.com customers already carry it.
- **Initial push:** customers already in Bill.com (by Account number) are linked **and updated** to match BC; customers not in Bill.com are created with Account number = BC customer number.
- **Afterwards:** a customer created in Nexus is created in Bill.com; any change — made in Nexus, or made in BC and pulled by Sync — is pushed to Bill.com.
- **Blocked = Invoice or All** → the Bill.com customer is made **inactive** (and active again if unblocked).
- No payment terms are sent (dropped earlier; piece E will send BC-calculated due dates).

## Fields sent to Bill.com *(my call — the user agreed the list in conversation)*

Name, invoice email, invoice email CC (if Bill.com has a CC/secondary-email field; else omit and note it), phone, billing address (line 1, line 2, city, state, ZIP, country), Account number, active/inactive. Nothing else.

## Behaviour

- **Link storage:** Nexus records, per BC customer, the Bill.com customer id (`0cu…`), the last-pushed values/hash, last push time and last push error. Scoped per organization + BC connection + Bill.com connection (environment).
- **When pushes happen** *(my call)*: right after a successful Nexus create/edit/delete of a customer, and after a customer Sync pulls changes from BC (only customers whose pushed fields changed). A push failure never fails the BC save — the customer is marked "Bill.com push failed" with the error, and is retried on the next push (and from a per-customer "Retry" / page-level "Push to Bill.com" button for admins).
- **Initial push:** an admin-only "Push all customers to Bill.com" action; safe to run more than once (it links by Account number first, so it never duplicates). Shows a summary: linked, created, updated, failed.
- **Delete in Nexus** *(my call)*: the Bill.com customer is made inactive (Bill.com keeps invoice history), not deleted.
- **Duplicates in Bill.com:** if two Bill.com customers share an Account number, do not guess — mark the BC customer "needs attention" with both ids and skip it.
- **Bill.com customers with no BC match** are left alone.
- **Rate limits:** Bill.com allows few concurrent requests (3 per the spike notes); the initial push of ~1,970 customers must throttle and be resumable (a timed-out run continues where it stopped on the next run).
- **Environments:** use the default enabled Bill.com connection (piece D). Development and live testing use the Bill.com **sandbox** only; never production.

## Decisions from design review

User's answers:
1. **Blanks overwrite.** Bill.com always matches BC exactly for the pushed fields, including clearing a Bill.com value when BC's is blank.
2. **Preview first.** The initial push first shows a preview — counts of linked / created / updated / made inactive / needs attention, plus a sample of field changes — and writes nothing until the admin presses Confirm.
3. **Blocked = Invoice or All → inactive** in Bill.com; blank or Ship → active.
4. **Already-blocked customers are created too**, as inactive, so Bill.com holds every BC customer.

*My calls* (the user can overrule):
5. **Address:** BC's single address goes to Bill.com's **billing** address; the shipping address is left untouched.
6. **Name clash on create** (Bill.com rejects a duplicate name): don't rename — mark the customer "needs attention" with Bill.com's message and skip.
7. **After linking, the Bill.com id is authoritative**; Account number is only used to find the match the first time. Matching searches inactive Bill.com customers too, so an inactive one holding the number is linked (and reactivated if BC says active), never duplicated.
8. **Pushes are queued, not inline:** a customer save or a Sync marks changed customers "pending push"; pending customers are pushed in small throttled batches — right after the save for a single customer, and by a "Push to Bill.com" run (button, and automatically after Sync from the browser) for many. A run that runs out of time stops cleanly and the next run continues from the pending list. No server cron.
9. **Email CC:** if Bill.com's customer has no CC/secondary email field, it's left out and noted in the UI; no contacts.
10. **Sandbox writes** during development and the live test only after the user's OK each time; tests use recorded/fake responses.

## Constraints

- Build on the existing connector `nexus/src/lib/billcom/` (session auth, `client.request()`, errors) — piece D was built for exactly this; its known follow-ups in BACKLOG item 2 (401 handling, `touch()` read per call, disabled-error class) should be fixed if they bite this work.
- Bill.com v3 API: customers endpoints (list/search by account number, create, update, set inactive) must be confirmed against the sandbox first — field names (account number, email CC, address shape, active flag), filtering, page size, error shapes (v3 errors are an array `[{ code, message, … }]`). Ask the user before writing to the sandbox.
- Permissions: pushes triggered by a customer save run with the saving user's permission (`canEditCustomers`); the initial push and bulk retry are admin-only.
- Another session commits to `main`; recheck the migration number (055 latest on 2026-10-30).
- User is a beginner: plain-language UI and errors.

## Non-goals

- Invoices, payments, payment terms (piece E/F).
- Reading Bill.com changes back into Nexus/BC.
- Contacts, bank accounts, multiple addresses.
- Bill.com production until the user switches it on.

## Left to the builder

- Where the Bill.com status shows (customer list column/badge, customer detail panel).
- Schema for the link table.
- Exact throttling/batching.
