-- Change invoice: one record per change of a Nexus-created invoice
-- (spec: docs/superpowers/specs/2026-11-17-change-invoice-design.md).

create table if not exists public.sales_invoice_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  state text not null default 'pending'
    check (state in ('pending','cancelling','cancel_failed','cancelled','posting','post_failed',
                     'posted','billcom_updating','billcom_failed','done','discarded')),
  error text,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  changed_by uuid,
  changed_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  old_bc_invoice_id text not null,
  old_bc_invoice_number text not null,
  old_total numeric,
  cancelled_at timestamptz,
  draft_bc_invoice_id text,
  new_bc_invoice_id text,
  new_bc_invoice_number text,
  new_total numeric,
  lines_before jsonb not null,
  lines_after jsonb not null
);

create index if not exists sales_invoice_changes_order_idx
  on public.sales_invoice_changes (organization_id, bc_connection_id, sales_order_id, created_at);

create index if not exists sales_invoice_changes_old_invoice_idx
  on public.sales_invoice_changes (organization_id, bc_connection_id, old_bc_invoice_id);

-- At most one open change per order.
create unique index if not exists sales_invoice_changes_one_open_idx
  on public.sales_invoice_changes (sales_order_id)
  where state not in ('done','discarded');

alter table public.sales_invoice_changes enable row level security;
drop policy if exists sales_invoice_changes_select on public.sales_invoice_changes;
create policy sales_invoice_changes_select on public.sales_invoice_changes
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

-- The order is 'changing' while a change is open.
alter table public.sales_orders drop constraint if exists sales_orders_invoice_state_check;
alter table public.sales_orders
  add constraint sales_orders_invoice_state_check
  check (invoice_state in ('none','posting','post_failed','posted','billcom_sending','billcom_failed','done','changing'));
