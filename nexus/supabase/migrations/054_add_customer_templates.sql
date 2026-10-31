-- 054_add_customer_templates.sql
-- Local copies of Business Central customer templates and number series.
-- Re-runnable: every statement is guarded with if (not) exists.
-- Members of the organization can read; writes go through service-role code.

create table if not exists public.business_central_customer_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  contact_type text not null default '',
  no_series text not null default '',
  customer_posting_group text not null default '',
  gen_bus_posting_group text not null default '',
  customer_price_group text not null default '',
  payment_terms_code text not null default '',
  tax_area_code text not null default '',
  tax_liable boolean not null default false,
  tax_identification_type text not null default '',
  application_method text not null default '',
  location_code text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_cust_templates_org_conn_idx
  on public.business_central_customer_templates (organization_id, bc_connection_id);
alter table public.business_central_customer_templates enable row level security;
drop policy if exists bc_cust_templates_select on public.business_central_customer_templates;
create policy bc_cust_templates_select on public.business_central_customer_templates
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_no_series (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_no_series_org_conn_idx
  on public.business_central_no_series (organization_id, bc_connection_id);
alter table public.business_central_no_series enable row level security;
drop policy if exists bc_no_series_select on public.business_central_no_series;
create policy bc_no_series_select on public.business_central_no_series
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );
