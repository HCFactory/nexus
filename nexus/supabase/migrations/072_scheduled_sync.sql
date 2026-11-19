-- Automatic syncs (Supabase pg_cron -> /api/cron/sync) and a log of sync runs.
-- Re-runnable.

-- Which BC environments sync on a schedule. Off by default; ticked on Production.
alter table public.business_central_connections
  add column if not exists auto_sync boolean not null default false;

-- One row per sync run (manual or scheduled), read by Admin -> Sync.
create table if not exists public.bc_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  kind text not null check (kind in ('light', 'full', 'lists')),
  trigger text not null check (trigger in ('manual', 'scheduled')),
  triggered_by uuid references public.users(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  complete boolean,
  error text,
  results jsonb
);

create index if not exists bc_sync_runs_latest_idx
  on public.bc_sync_runs (bc_connection_id, kind, started_at desc);

-- Server only (service role); no policies for anon or signed-in users.
alter table public.bc_sync_runs enable row level security;
