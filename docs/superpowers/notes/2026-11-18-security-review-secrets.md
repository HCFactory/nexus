# Security review: API and secret keys (2026-11-18)

**Question:** can any API/secret key be read or reached by a logged-in user, a visitor, the browser, or logs?

**Answer:** no key can be read. One database function let people create purchase orders without signing in, and one log setting printed keys typed in Admin. Both are fixed (migration 070 + `next.config.ts`).

## Checked and fine

- **Where keys live:** the BC client secret, Bill.com dev key and password, and Stripe secret key and webhook secret are stored only in Supabase Vault, encrypted. No table holds a key in plain text. Card-setup links store only a hash of the token.
- **Who can read keys:** the functions that read or write Vault secrets (`get_/set_bc_client_secret`, `get_/set_billcom_*`, `get_/set_stripe_*`) are callable by the server's service role only (024, 046, 059, 067).
- **Connection tables:** `billcom_connections` and `stripe_connections` are fully closed to anon and logged-in users. `business_central_credentials` is readable by org members but holds no secret: tenant id, client id, company id, and a Vault pointer.
- **Server actions:** the admin screens get only "a secret is stored: yes/no" (`getBcCredentials`, `listBillcomConnections`, `listStripeConnections`). Saving keys needs admin. Code that reads keys is `server-only`.
- **Browser:** only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public by design) and `NEXT_PUBLIC_APP_URL` reach the browser. No browser code reads other env vars.
- **Git:** `.env.local` was never committed; `.env.example` has placeholders only.
- **Stripe webhook:** verifies Stripe's signature (`constructEvent`) before trusting an event.
- **Functions logged-in users may call** (Friends & Family orders, item linking): each checks `auth.uid()` and the organisation.

## Fixed

1. **`create_environment_purchase_order` was callable without signing in, for any organisation.** It took the organisation id and creator as plain inputs and was never revoked. Someone with the public anon key and an organisation and environment id could create purchase orders and fake the creator. Migration 070 now requires a signed-in member of that organisation (or the server), checks the environment belongs to it, records the caller as creator, and revokes anon.
2. **The server log printed arguments to server actions**, including keys typed in Admin (seen with the Stripe test key on 2026-11-17). This is Next.js's `logging.serverFunctions`, on by default. It's now `false`.

## Retracted

- **`delete_billcom_secrets`** was first reported as callable by any logged-in user. Wrong: migration 059 had already dropped the function (applying 070 failed with "does not exist"). The first check listed functions without noticing later `drop function` statements.

## Still to do (user)

- Apply migration **070** in Supabase.
- Roll the Stripe **test** secret key (it was printed in the local log on 2026-11-17), and re-enter it in Admin.
