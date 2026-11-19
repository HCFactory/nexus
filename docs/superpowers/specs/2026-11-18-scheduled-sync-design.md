# Sync section in Admin, light customer sync, automatic syncs

Status: approved 2026-11-18 by the user ("matches what i want").

## Why

People still create customers in BC, and Bill.com syncs with BC directly for now, so Nexus has to pick up BC changes without anyone clicking. The user also wants the heavy sync moved to Admin and a quick customer-only sync on the Customers page that non-admins can use.

## What gets built

1. **Admin → Sync** (above User Management, admins only). One row per sync. Each row shows the last run (time, manual or automatic, Complete / In progress / error) and has a **Sync now** that runs rounds until complete.
   - **Customers & Receivables (full):** customers, card fields, ship-tos, sales invoices, invoice lines, customer ledger entries, sales price lists, Bill.com queue. This is everything the old Customers button did. Automatic every **2 hours**.
   - **Customer lists:** every Customer lists page in dependency order. Manual only.
2. **Customers page → Sync now = light sync:** customers (delta), card fields, ship-tos. Shown to anyone who can view customers. Automatic every **15 minutes**.
3. **Automatic syncs only where enabled:** a **Sync automatically** tick box per BC environment (Admin → BC Environments → Edit), default off. The user ticks Production.
4. **Trigger:** Supabase `pg_cron` + `pg_net` POST to `/api/cron/sync?kind=light|full` with `Authorization: Bearer <CRON_SECRET>`. Vercel Hobby only allows daily cron. The route syncs every environment with `auto_sync`; full runs repeat rounds until complete or ~4 minutes.
5. **Run log:** table `bc_sync_runs` records each run (kind, trigger, start, end, complete, error, results). The Admin rows read the latest per kind.

## Rules

- One sync at a time per environment: the existing `sync_in_progress_*` lock. A scheduled run that finds it held skips quietly; a manual one shows "Sync already in progress".
- Syncs only read from BC.
- The cron route is public in middleware but refuses without the secret (401), and refuses if `CRON_SECRET` is unset.

## User steps after deploy

Apply migration 072, add `CRON_SECRET` in Vercel, enable `pg_cron` and `pg_net`, put the secret in Supabase Vault, run the schedule SQL (in `docs/onboarding/business-central-setup.md`), and tick Sync automatically on Production.

## Approaches

- **Supabase pg_cron calling a secured route (picked):** free, every 15 minutes, in the same Supabase.
- Vercel Cron: daily only on Hobby.
- GitHub Actions schedule: works, but it's another system, and its timing is loose under load.

## Calls I made (Claude's)

- Row names "Customers & Receivables" and "Customer lists".
- Customer lists stay manual. Items sync stays on the Items page.
- The environment is chosen by a tick box, not by matching the name "Production".

## After review (2026-11-18)

- **Atomic lock:** the lock is taken in one guarded update (`sync_in_progress_since is null or timeout < now`), and a run releases only its own lock. Before, a saved copy of the connection was checked, so an automatic round could take over a manual run.
- **Time limit:** scheduled runs stay under 270 s. A round only starts if a worst-case round still fits (full 160 s, light 90 s). An environment that doesn't fit waits for the next schedule.
- **Stale rows:** a run unfinished after 15 minutes shows "Did not finish".
- **Quick-sync cooldown:** once a quick sync finishes, the next can start only after 60 s. Follow-up rounds of an unfinished one aren't held back.
- **`last_pulled_at`:** only the full sync sets it.
- **Stop:** shows "Stopping…" until the current round ends.
