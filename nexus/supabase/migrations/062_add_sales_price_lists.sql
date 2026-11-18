-- 062_add_sales_price_lists.sql
-- Read-only copy of BC sales price list lines (for customer price group
-- pricing), and a nullable sales order line discount (null = BC decides).
-- Re-runnable: every statement is guarded. Members of the organization can
-- read; all writes go through service-role code.

create table if not exists public.business_central_sales_price_list_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  price_list_code text not null,
  line_no int not null,
  list_status text not null default '',
  source_type text not null default '',
  source_no text not null default '',
  item_number text not null default '',
  unit_of_measure_code text not null default '',
  minimum_quantity numeric not null default 0,
  starting_date date,
  ending_date date,
  unit_price numeric not null default 0,
  line_discount_percent numeric not null default 0,
  amount_type text not null default '',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, bc_connection_id, price_list_code, line_no)
);

create index if not exists bc_sales_price_list_lines_item_idx
  on public.business_central_sales_price_list_lines (organization_id, bc_connection_id, item_number);
alter table public.business_central_sales_price_list_lines enable row level security;
drop policy if exists bc_sales_price_list_lines_select on public.business_central_sales_price_list_lines;
create policy bc_sales_price_list_lines_select on public.business_central_sales_price_list_lines
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

-- Line discount: null means "not typed, BC decides". The 0-100 check stays.
alter table public.sales_order_lines alter column discount_percent drop not null;
alter table public.sales_order_lines alter column discount_percent drop default;
alter table public.sales_order_lines add column if not exists bc_line_discount_percent numeric;
