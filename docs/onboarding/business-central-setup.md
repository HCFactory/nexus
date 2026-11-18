# Setting up a new Business Central environment (and Bill.com, Stripe) for Nexus

A checklist for connecting Nexus to a new BC environment, such as a new company's production. It's written from the Hawaii Candy Factory production setup (2026-11-18). Do the steps in order. Each step says where it's done: **BC**, **Nexus**, **Bill.com**, **Stripe** or **Vercel**.

## 1. App registration (Azure / Entra), done once per tenant

- Nexus signs in to BC with one app registration: Tenant ID, Client ID and a client secret. These are entered once per organisation in **Nexus → Admin → Business Central**.
- **BC:** add the app under **Microsoft Entra Applications**, set it to **Enabled**, and give it the **D365 FULL ACCESS** permission set in every company Nexus uses.
- Client secrets expire. When the "credentials incorrect" errors start, create a new secret and paste it into Admin. Leaving the box blank keeps the stored secret.

## 2. Web services to publish (BC → Web Services → New)

Nexus reads and writes through these pages. For each one: Object Type **Page**, the page below, the **Service Name exactly as written** (it's case-sensitive), and tick **Published**.

Match the page by its **name**. The number is what BC uses in the standard version and only shows up in Nexus's error messages. If a number shows a different page name, search for the page by name instead.

| Service Name | BC page | Page no. | Used for |
|---|---|---|---|
| `Customer_Card_Excel` | Customer Card | 21 | Customer create/edit, extra customer fields (CC email) |
| `Item_Card_Excel` | Item Card | 30 | Item "sales blocked" status |
| `ShipToAddresses` | Ship-to Address | 300 | Customer ship-to addresses |
| `CustomerLedgerEntries` | Customer Ledger Entries | 25 | Receivables (open balances, payments) |
| `CustomerTemplates` | **Customer Templ. Card** | 1382 | New customers from a template; payment term and tax area delete checks |
| `NoSeries` | No. Series | 456 | Customer numbering; Manual Nos. check for order numbers |
| `NoSeriesLines` | No. Series Lines | 457 | Next customer, item and order numbers |
| `CustomerPriceGroups` | Customer Price Groups | 7 | Reference list |
| `TaxAreaLines` | Tax Area Lines | 465 | Reference list |
| `TaxJurisdictions` | Tax Jurisdictions | 466 | Reference list |
| `TaxDetails` | Tax Details | 468 | Reference list |
| `CustomerPostingGroups` | Customer Posting Groups | 110 | Reference list |
| `GenBusinessPostingGroups` | Gen. Business Posting Groups | 312 | Reference list |
| `SalesOrder` | Sales Order | 42 | Sales orders |
| `SalesOrderSalesLines` | Sales Order Subform | 46 | Sales order lines |
| `Sales_Price_List_Excel` | Sales Price List | 7015 | Price list sync |
| `Sales_Price_List_ExcelLines` | Price List Lines | 7018 | Price list sync |

Payment terms, shipment methods, tax areas, customers, invoices and sales documents come through BC's standard API and need no publishing.

**How to check:** compare BC's Web Services list in the new environment with the one in TEST. Every Service Name above should be there, published, and pointing at a page with the same **Object Name** as in TEST.

## 3. BC settings

- **Customer number series** used by your customer templates must be **Normal**, with "Allow Gaps in Nos." off. Otherwise Nexus refuses to create customers from that template. In HCF production, check CUST, WHSL-CUST, FUND-CUST, CUST-PERS and CUSTCONTR.
- **Sales order number series** (WHSL in HCF): tick **Manual Nos.** so Nexus can give a new order its number when the page opens. Without it, orders get their number on Save.
- **General Ledger Setup → Allow Posting From/To** must cover today. Check any **User Setup** line for the Nexus app user too. Otherwise Create invoice can't post.

## 4. Nexus admin (Admin page)

1. **Business Central:** Tenant ID, Client ID, client secret and Company ID. These are per organisation.
2. **Business Central Environments → New Environment:** a display name and BC's environment name (e.g. `Production`). Click **Verify**.
3. **Edit the environment:**
   - **Bill.com connection:** pick one, or **None** to keep Bill.com off for this environment.
   - **Stripe connection:** pick one, or **None** to keep Stripe off.
   - **"Bill.com invoices come from Bill.com's own BC connector":** tick it if Bill.com's own BC connector copies invoices in this environment. Nexus then posts invoices in BC only, so they don't land in Bill.com twice.
4. **Switch to the environment** (top-right menu → environment name) and open **Customers → Sync now**.

## 5. The first sync

- Each sync runs for about a minute, then stops where it got to. Large lists show **"Incomplete — click Sync again to continue"**. That's normal: keep clicking **Sync now** until everything says Complete. The first HCF production sync took several runs: 3,644 customers, more than 5,000 invoices.
- **A "404 … Publish page N as an OData web service named X" line** means a web service from section 2 is missing. Publish it and sync again.
- **"Customer card fields: The operation was aborted due to timeout"** means BC was slow returning the extra customer fields for a large customer list. Sync again. If it keeps happening, tell the developer: Nexus should read that list in smaller chunks.
- Then sync **Shipment methods**, and check one customer and one invoice against BC.

## 6. Bill.com (only if this environment uses Nexus → Bill.com)

- **Bill.com:** create an API sign-in token (**Settings → Sync & Integrations → Tokens → New**). Passwords don't work for the API.
- **Nexus → Admin → Bill.com → New Connection:**
  - **Username:** the token's name.
  - **Password:** the token.
  - **Dev key:** from Bill.com.
- **Test connection,** then pick the connection on the BC environment (section 4).
- **Duplicate customers:** if Bill.com's own BC connector already copied customers into Bill.com, picking a Bill.com connection queues **every** customer for push on the next sync, and that can create duplicates. Turn the connector's customer sync off first and plan how to match existing Bill.com customers.

## 7. Stripe (saving and charging cards)

1. **Stripe dashboard, live mode:**
   - **Developers → API keys:** copy the **Secret key** (`sk_live_…`).
2. **Nexus (on the live site, so the webhook address is right) → Admin → Stripe → New Connection:**
   - Enter a display name and the secret key. Leave the webhook secret blank for now.
   - Save, leave it **disabled**, and copy the webhook address shown on its row (ends in `/api/stripe/webhook/<id>`).
3. **Stripe → Workbench → Webhooks → Add destination:**
   - **Events from:** Your account.
   - **Payload style:** **Snapshot**. Thin doesn't work with Nexus.
   - **Events:** `checkout.session.completed` only.
   - **Destination type:** Webhook endpoint.
   - **Endpoint URL:** paste the address from step 2.
   - Create it, then reveal and copy the **Signing secret** (`whsec_…`).
4. **Nexus:**
   - Edit the connection and paste the signing secret.
   - **Test connection** should show live mode.
5. **Before turning it on:**
   - **Email:** verify a sending domain in Resend and set `CUSTOMER_EMAIL_FROM` in **Vercel**. Card-setup emails and the "card saved" staff email need it.
   - **Site address:** `NEXT_PUBLIC_APP_URL` in **Vercel** must be the real site address.
   - **Turn it on:** enable the connection, pick it on the BC environment (section 4), and do one real card save to confirm the webhook arrives.
   - **Who can charge:** give **Charge saved cards** only to the people who should charge cards.
   - **Charging needs Bill.com:** Charge card records the payment against a Nexus-made Bill.com invoice, so it needs section 6.
6. **Optional: card links on the company's own address** (e.g. `payment.hawaiicandyfactory.com`):
   - **Vercel → Settings → Domains → Add:** add the address, then add the DNS record Vercel shows (usually CNAME `payment` → `cname.vercel-dns.com`).
   - **Vercel → Environment Variables:** set `CARD_SETUP_BASE_URL` = `https://payment.hawaiicandyfactory.com` and redeploy.
   - **What it does:** on that address only the card setup pages are served. Anything else is a plain "Not found": no redirect, no login page, nothing that names Nexus. The card pages' tab title is "Save your card".
   - **What stays the same:** links already sent on the old address keep working, and the Stripe webhook stays on the main address.

## 7b. Email (Resend), for card links and the "card saved" notice

1. **Resend → Domains → Add Domain:** use a subdomain (e.g. `mail.hawaiicandyfactory.com`) so normal company email isn't affected.
2. Add the DNS records Resend shows (MX and SPF on `send.…`, DKIM `resend._domainkey.…`), then click **Verify**.
3. **Vercel → Environment Variables (Production):**
   - **`RESEND_API_KEY`:** your Resend API key.
   - **`CUSTOMER_EMAIL_FROM`:** e.g. `Hawaii Candy Factory <payments@mail.hawaiicandyfactory.com>`.
   - **`CARD_SAVED_NOTIFY_EMAIL`:** optional. **One** address that gets the "card saved" notice; if left out it goes to `fundraisers@hawaiicandyfactory.com`.
4. Redeploy. Vercel only applies new settings on the next deploy.

## 7c. Moving the main app to a new address (e.g. `nexus.nomshsf.com`)

- **Vercel:** add the domain and set `NEXT_PUBLIC_APP_URL` to it, then redeploy.
- **Supabase → Authentication → URL Configuration:** set the Site URL and add the new address to the Redirect URLs, so sign-in and password-reset links work.
- **Keep the old domain attached** so the Stripe webhook and links already sent keep working. If you ever remove it, first update the webhook endpoint URL in Stripe.

## 8. After setup

- Keep the developer's backlog (`BACKLOG.md`) up to date with anything that failed or was skipped.
