-- 045_add_billcom_connections.sql
-- One row per Bill.com environment per organization.
--
-- Credentials live on this row rather than in a shared per-org table (the
-- pattern business_central_credentials uses) because Bill.com requires
-- separate developer keys per environment — sandbox keys do not work against
-- production, so a shared credential set would be empty structure.
--
-- RLS is enabled with NO SELECT POLICY, deliberately departing from
-- business_central_items and item_templates. session_id is a live bearer
-- credential: anyone holding it can act as this connection against Bill.com
-- until it idles out. A member-scoped policy would expose it through PostgREST
-- to every user in the organization. Nothing needs client-side reads here —
-- every access goes through a service-role server action, which bypasses RLS.
--
-- This migration is re-runnable: it contains no `create policy`, which is the
-- one statement with no IF NOT EXISTS form (see migrations 039 and 041).

create table if not exists public.billcom_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  environment text not null check (environment in ('sandbox', 'production')),
  api_base_url text not null,
  username text not null,
  billcom_organization_id text not null,
  dev_key_secret_id uuid,
  password_secret_id uuid,
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  session_id text,
  session_last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billcom_connections_org_idx
  on public.billcom_connections (organization_id);

-- At most one default connection per organization, mirroring
-- idx_bc_connections_one_default_per_org.
create unique index if not exists billcom_connections_one_default_per_org
  on public.billcom_connections (organization_id)
  where is_default;

alter table public.billcom_connections enable row level security;

-- RLS with no policy already makes this table return zero rows to anon and
-- authenticated. Revoke the default Supabase grants as well, so the guarantee
-- does not rest on RLS alone: one future `create policy` or `disable row level
-- security` would otherwise publish session_id — a live bearer credential — to
-- every member of the organization through PostgREST.
revoke all on public.billcom_connections from anon, authenticated;
