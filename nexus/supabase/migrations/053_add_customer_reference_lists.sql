-- 053_add_customer_reference_lists.sql
-- Local copies of Business Central customer reference lists (payment terms,
-- price groups, tax areas/jurisdictions/lines/details, locations, posting
-- groups). Re-runnable: every statement is guarded with if (not) exists.
-- Members of the organization can read; writes go through service-role code.
-- Note: BC uses '' for "no tax group", so empty strings are valid values.

create table if not exists public.business_central_payment_terms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  due_date_calculation text,
  discount_date_calculation text,
  discount_percent numeric not null default 0,
  calculate_discount_on_credit_memos boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_pay_terms_org_conn_idx
  on public.business_central_payment_terms (organization_id, bc_connection_id);
alter table public.business_central_payment_terms enable row level security;
drop policy if exists bc_pay_terms_select on public.business_central_payment_terms;
create policy bc_pay_terms_select on public.business_central_payment_terms
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_customer_price_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  allow_invoice_disc boolean,
  allow_line_disc boolean,
  price_includes_vat boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_price_groups_org_conn_idx
  on public.business_central_customer_price_groups (organization_id, bc_connection_id);
alter table public.business_central_customer_price_groups enable row level security;
drop policy if exists bc_price_groups_select on public.business_central_customer_price_groups;
create policy bc_price_groups_select on public.business_central_customer_price_groups
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_tax_areas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  tax_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_tax_areas_org_conn_idx
  on public.business_central_tax_areas (organization_id, bc_connection_id);
alter table public.business_central_tax_areas enable row level security;
drop policy if exists bc_tax_areas_select on public.business_central_tax_areas;
create policy bc_tax_areas_select on public.business_central_tax_areas
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_tax_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  report_to_jurisdiction text,
  tax_account_sales text,
  tax_account_purchases text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_tax_juris_org_conn_idx
  on public.business_central_tax_jurisdictions (organization_id, bc_connection_id);
alter table public.business_central_tax_jurisdictions enable row level security;
drop policy if exists bc_tax_juris_select on public.business_central_tax_jurisdictions;
create policy bc_tax_juris_select on public.business_central_tax_jurisdictions
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_tax_area_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  tax_area_code text not null,
  tax_jurisdiction_code text not null,
  calculation_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, tax_area_code, tax_jurisdiction_code)
);

create index if not exists bc_tax_area_lines_org_conn_idx
  on public.business_central_tax_area_lines (organization_id, bc_connection_id);
alter table public.business_central_tax_area_lines enable row level security;
drop policy if exists bc_tax_area_lines_select on public.business_central_tax_area_lines;
create policy bc_tax_area_lines_select on public.business_central_tax_area_lines
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_tax_details (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  tax_jurisdiction_code text not null,
  tax_group_code text not null,
  tax_type text not null,
  effective_date date not null,
  maximum_amount_qty numeric not null default 0,
  tax_below_maximum numeric not null default 0,
  tax_above_maximum numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, tax_jurisdiction_code, tax_group_code, tax_type, effective_date)
);

create index if not exists bc_tax_details_org_conn_idx
  on public.business_central_tax_details (organization_id, bc_connection_id);
alter table public.business_central_tax_details enable row level security;
drop policy if exists bc_tax_details_select on public.business_central_tax_details;
create policy bc_tax_details_select on public.business_central_tax_details
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  address_line_1 text,
  address_line_2 text,
  city text,
  state text,
  postal_code text,
  country text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_locations_org_conn_idx
  on public.business_central_locations (organization_id, bc_connection_id);
alter table public.business_central_locations enable row level security;
drop policy if exists bc_locations_select on public.business_central_locations;
create policy bc_locations_select on public.business_central_locations
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_customer_posting_groups (
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

create index if not exists bc_cust_posting_groups_org_conn_idx
  on public.business_central_customer_posting_groups (organization_id, bc_connection_id);
alter table public.business_central_customer_posting_groups enable row level security;
drop policy if exists bc_cust_posting_groups_select on public.business_central_customer_posting_groups;
create policy bc_cust_posting_groups_select on public.business_central_customer_posting_groups
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

create table if not exists public.business_central_general_business_posting_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_id text,
  bc_etag text,
  bc_last_modified_at timestamptz,
  last_synced_at timestamptz,
  code text not null,
  display_name text not null default '',
  default_vat_business_posting_group text,
  auto_insert_default boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, code)
);

create index if not exists bc_gen_bus_posting_groups_org_conn_idx
  on public.business_central_general_business_posting_groups (organization_id, bc_connection_id);
alter table public.business_central_general_business_posting_groups enable row level security;
drop policy if exists bc_gen_bus_posting_groups_select on public.business_central_general_business_posting_groups;
create policy bc_gen_bus_posting_groups_select on public.business_central_general_business_posting_groups
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );
