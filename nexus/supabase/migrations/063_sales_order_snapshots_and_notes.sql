-- 063_sales_order_snapshots_and_notes.sql
-- BC value snapshots (for conflict detection) on orders and lines, plus
-- timestamped note entries replacing the single sales_orders.notes text.
-- Re-runnable: every statement is guarded. Members of the organization can
-- read; all writes go through service-role code.

alter table public.sales_orders
  add column if not exists bc_snapshot jsonb;
alter table public.sales_order_lines
  add column if not exists bc_snapshot jsonb;

create table if not exists public.sales_order_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create index if not exists sales_order_notes_order_idx
  on public.sales_order_notes (organization_id, bc_connection_id, sales_order_id, created_at);
alter table public.sales_order_notes enable row level security;
drop policy if exists sales_order_notes_select on public.sales_order_notes;
create policy sales_order_notes_select on public.sales_order_notes
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );

-- One-time copy of the old single notes text into an entry per order.
insert into public.sales_order_notes
  (organization_id, bc_connection_id, sales_order_id, body, created_by, created_at, updated_at)
select so.organization_id, so.bc_connection_id, so.id, left(so.notes, 4000),
       so.created_by, so.updated_at, so.updated_at
from public.sales_orders so
where so.notes <> ''
  and not exists (select 1 from public.sales_order_notes n where n.sales_order_id = so.id);
