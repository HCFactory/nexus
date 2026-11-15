-- 064_sales_order_invoicing.sql
-- Invoice progress and results on sales orders (create invoice from an order).
-- Re-runnable: every statement is guarded. Writes go through service-role code.

alter table public.sales_orders
  add column if not exists invoice_state text not null default 'none',
  add column if not exists invoice_error text,
  add column if not exists bc_posted_invoice_id text,
  add column if not exists bc_posted_invoice_number text,
  add column if not exists posted_at timestamptz,
  add column if not exists invoice_date date,
  add column if not exists invoice_due_date date,
  add column if not exists posted_total_excl_tax numeric,
  add column if not exists posted_total_tax numeric,
  add column if not exists posted_total_incl_tax numeric,
  add column if not exists billcom_invoice_id text,
  add column if not exists billcom_invoiced_at timestamptz,
  add column if not exists invoice_started_by uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_orders_invoice_state_check'
      and conrelid = 'public.sales_orders'::regclass
  ) then
    alter table public.sales_orders
      add constraint sales_orders_invoice_state_check
      check (invoice_state in ('none','posting','post_failed','posted','billcom_sending','billcom_failed','done'));
  end if;
end $$;

create index if not exists sales_orders_invoice_state_idx
  on public.sales_orders (organization_id, bc_connection_id, invoice_state);
