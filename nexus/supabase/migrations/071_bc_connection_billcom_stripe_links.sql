-- Each BC environment picks its own Bill.com and Stripe connection
-- (spec: docs/superpowers/specs/2026-11-18-per-environment-connections-design.md).
-- Nothing picked = Bill.com/Stripe off for that environment. Deleting a
-- connection clears the pick. The server checks the pick is in the same org.
alter table public.business_central_connections
  add column if not exists billcom_connection_id uuid references public.billcom_connections(id) on delete set null,
  add column if not exists stripe_connection_id uuid references public.stripe_connections(id) on delete set null;
