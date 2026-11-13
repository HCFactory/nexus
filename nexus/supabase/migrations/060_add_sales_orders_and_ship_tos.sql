-- 060_add_sales_orders_and_ship_tos.sql
-- Sales orders (header + lines), customer ship-to addresses, and BC shipment
-- methods. Also adds contact/shipping columns to business_central_customers.
-- Re-runnable: every statement is guarded. Members of the organization can
-- read; all writes go through service-role code.

alter table public.business_central_customers
  add column if not exists contact_no text not null default '',
  add column if not exists mobile_phone_no text not null default '',
  add column if not exists ship_to_code text not null default '',
  add column if not exists shipment_method_code text not null default '';

-- Shipment methods (BC reference list, same shape as customer posting groups)
create table if not exists public.business_central_shipment_methods (
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

create index if not exists bc_shipment_methods_org_conn_idx
  on public.business_central_shipment_methods (organization_id, bc_connection_id);
alter table public.business_central_shipment_methods enable row level security;
drop policy if exists bc_shipment_methods_select on public.business_central_shipment_methods;
create policy bc_shipment_methods_select on public.business_central_shipment_methods
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

-- Customer ship-to addresses
create table if not exists public.customer_ship_to_addresses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  customer_number text not null,
  code text not null check (char_length(code) <= 10 and code = upper(code)),
  name text not null default '',
  address text not null default '',
  address_2 text not null default '',
  city text not null default '',
  state text not null default '',
  post_code text not null default '',
  country text not null default '',
  contact text not null default '',
  phone text not null default '',
  email text not null default '',
  tax_area_code text not null default '',
  location_code text not null default '',
  shipment_method_code text not null default '',
  tax_liable boolean not null default false,
  bc_etag text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, customer_number, code)
);

create index if not exists customer_ship_to_org_conn_idx
  on public.customer_ship_to_addresses (organization_id, bc_connection_id, customer_number);
alter table public.customer_ship_to_addresses enable row level security;
drop policy if exists customer_ship_to_select on public.customer_ship_to_addresses;
create policy customer_ship_to_select on public.customer_ship_to_addresses
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

-- Sales orders
create table if not exists public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft','final','pulled','shipped','invoiced')),
  customer_id uuid not null references public.business_central_customers(id),
  customer_number text not null,
  order_date date not null,
  requested_delivery_date date,
  invoice_number text,
  customer_po text not null default '',
  notes text not null default '',
  -- billing
  bill_name text not null default '',
  bill_address text not null default '',
  bill_address_2 text not null default '',
  bill_city text not null default '',
  bill_state text not null default '',
  bill_post_code text not null default '',
  bill_country text not null default '',
  bill_contact_no text not null default '',
  bill_phone text not null default '',
  bill_mobile text not null default '',
  bill_email text not null default '',
  bill_email_cc text not null default '',
  -- ship-to ('' code means one-off or billing)
  ship_to_code text not null default '',
  ship_to_name text not null default '',
  ship_to_address text not null default '',
  ship_to_address_2 text not null default '',
  ship_to_city text not null default '',
  ship_to_state text not null default '',
  ship_to_post_code text not null default '',
  ship_to_country text not null default '',
  ship_to_contact text not null default '',
  ship_to_phone text not null default '',
  -- terms
  payment_terms_code text not null default '',
  tax_area_code text not null default '',
  gen_bus_posting_group text not null default '',
  customer_posting_group text not null default '',
  shipment_method_code text not null default '',
  location_code text not null default '',
  tax_liable boolean not null default false,
  -- BC read-back
  bc_order_number text,
  bc_etag text,
  bc_create_marker text,
  bc_due_date date,
  bc_document_date date,
  bc_posting_date date,
  total_excl_tax numeric,
  total_tax numeric,
  total_incl_tax numeric,
  -- sync
  sync_state text not null default 'pending'
    check (sync_state in ('pending','synced','failed','conflict')),
  sync_error text,
  sync_attempts int not null default 0,
  claimed_until timestamptz,
  last_synced_at timestamptz,
  local_version int not null default 1,
  synced_version int not null default 0,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_orders_sync_idx
  on public.sales_orders (organization_id, bc_connection_id, sync_state);
create index if not exists sales_orders_date_idx
  on public.sales_orders (organization_id, bc_connection_id, order_date desc);
alter table public.sales_orders enable row level security;
drop policy if exists sales_orders_select on public.sales_orders;
create policy sales_orders_select on public.sales_orders
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

-- Sales order lines
create table if not exists public.sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  position int not null,
  item_number text not null,
  description text not null default '',
  unit_of_measure_code text not null default '',
  quantity numeric not null check (quantity > 0),
  unit_price numeric,
  discount_percent numeric not null default 0 check (discount_percent between 0 and 100),
  removed boolean not null default false,
  bc_line_no int,
  bc_etag text,
  bc_unit_price numeric,
  amount_incl_tax numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_order_lines_order_idx
  on public.sales_order_lines (sales_order_id, position);
alter table public.sales_order_lines enable row level security;
drop policy if exists sales_order_lines_select on public.sales_order_lines;
create policy sales_order_lines_select on public.sales_order_lines
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );
