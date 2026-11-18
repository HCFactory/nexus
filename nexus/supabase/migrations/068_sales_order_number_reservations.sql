-- New sales orders take BC's next order number when the New page opens
-- (spec: docs/superpowers/specs/2026-11-17-new-order-number-preview-design.md).

-- One row per number Nexus took from BC's counter. sales_order_id is set when
-- an order is saved with it; a row left null is a number nobody saved (a gap).
create table if not exists public.sales_order_number_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  number text not null,
  reserved_by uuid not null,
  reserved_at timestamptz not null default now(),
  sales_order_id uuid unique references public.sales_orders(id) on delete set null
);

create unique index if not exists sales_order_number_reservations_number_idx
  on public.sales_order_number_reservations (organization_id, bc_connection_id, number);

-- Written and read only by the server (service role); no member policy.
alter table public.sales_order_number_reservations enable row level security;

-- The number a new order took up front; BC creates the order with it.
alter table public.sales_orders add column if not exists reserved_order_number text;

create unique index if not exists sales_orders_reserved_order_number_idx
  on public.sales_orders (organization_id, bc_connection_id, reserved_order_number)
  where reserved_order_number is not null;
