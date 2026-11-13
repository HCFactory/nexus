-- 057_add_billcom_customer_links.sql
-- Links a Business Central customer to its Bill.com customer for the one-way
-- Nexus/BC -> Bill.com customer push. Re-runnable: every statement is guarded.
-- Members of the organization can read; writes go through service-role code.

create table if not exists public.billcom_customer_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  billcom_connection_id uuid not null references public.billcom_connections(id) on delete cascade,
  business_central_customer_id uuid references public.business_central_customers(id) on delete set null,
  bc_customer_number text not null,
  billcom_customer_id text,
  status text not null default 'pending'
    check (status in ('pending', 'synced', 'failed', 'needs_attention')),
  last_pushed_hash text,
  last_pushed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, billcom_connection_id, bc_customer_number)
);

create index if not exists billcom_customer_links_status_idx
  on public.billcom_customer_links (organization_id, bc_connection_id, billcom_connection_id, status);

alter table public.billcom_customer_links enable row level security;
drop policy if exists billcom_customer_links_select on public.billcom_customer_links;
create policy billcom_customer_links_select on public.billcom_customer_links
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );
