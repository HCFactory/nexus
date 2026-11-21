-- Invoice activity log and Bill.com payments.
--   billcom_received_payments          one row per Bill.com payment received
--   billcom_received_payment_invoices  which invoices each payment paid (and how much)
--   sales_invoice_status_events        BC / Bill.com status changes, from now on
-- Status changes are logged by triggers, so every writer (syncs, invoice page
-- refresh, invoice changes) is covered. The first time a status is seen
-- (insert, or old value null) nothing is logged.
-- Re-runnable.

create table if not exists public.billcom_received_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  billcom_connection_id uuid not null references public.billcom_connections(id) on delete cascade,
  billcom_payment_id text not null,
  billcom_customer_id text,
  payment_date date,
  amount numeric,
  unapplied_amount numeric,
  convenience_fee numeric,
  receivables_type text,
  online_payment boolean,
  reference_number text,
  status text,
  deposit_bank_name text,
  -- Last 4 digits only; the full account number is never stored.
  deposit_account_last4 text,
  billcom_created_time timestamptz,
  billcom_updated_time timestamptz,
  synced_at timestamptz not null default now(),
  unique (billcom_connection_id, billcom_payment_id)
);

create table if not exists public.billcom_received_payment_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_id uuid not null references public.billcom_received_payments(id) on delete cascade,
  billcom_connection_id uuid not null references public.billcom_connections(id) on delete cascade,
  billcom_invoice_id text not null,
  amount numeric,
  payment_date date,
  status text,
  received_payment_id text
);
create index if not exists billcom_received_payment_invoices_invoice_idx
  on public.billcom_received_payment_invoices (billcom_connection_id, billcom_invoice_id);
create index if not exists billcom_received_payment_invoices_payment_idx
  on public.billcom_received_payment_invoices (payment_id);

create table if not exists public.sales_invoice_status_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_invoice_id text not null,
  source text not null check (source in ('bc', 'billcom')),
  from_status text,
  to_status text,
  -- Null when the change came from outside Nexus (a sync noticed it).
  changed_by uuid,
  occurred_at timestamptz not null default now()
);
create index if not exists sales_invoice_status_events_invoice_idx
  on public.sales_invoice_status_events (bc_connection_id, bc_invoice_id, occurred_at desc);

-- Row-level security: org members may read; writes go through service-role code.
alter table public.billcom_received_payments enable row level security;
alter table public.billcom_received_payment_invoices enable row level security;
alter table public.sales_invoice_status_events enable row level security;

drop policy if exists billcom_received_payments_select on public.billcom_received_payments;
create policy billcom_received_payments_select on public.billcom_received_payments
  for select using (organization_id in (select organization_id from public.users where id = auth.uid()));
drop policy if exists billcom_received_payment_invoices_select on public.billcom_received_payment_invoices;
create policy billcom_received_payment_invoices_select on public.billcom_received_payment_invoices
  for select using (organization_id in (select organization_id from public.users where id = auth.uid()));
drop policy if exists sales_invoice_status_events_select on public.sales_invoice_status_events;
create policy sales_invoice_status_events_select on public.sales_invoice_status_events
  for select using (organization_id in (select organization_id from public.users where id = auth.uid()));

-- BC status changes.
create or replace function public.log_bc_invoice_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status is not null and new.status is distinct from old.status and new.bc_connection_id is not null then
    insert into public.sales_invoice_status_events (organization_id, bc_connection_id, bc_invoice_id, source, from_status, to_status)
    values (new.organization_id, new.bc_connection_id, new.bc_invoice_id, 'bc', old.status, new.status);
  end if;
  return new;
end $$;
drop trigger if exists bc_invoice_status_change on public.business_central_sales_invoices;
create trigger bc_invoice_status_change
  after update of status on public.business_central_sales_invoices
  for each row execute function public.log_bc_invoice_status_change();

-- Bill.com status changes.
create or replace function public.log_billcom_invoice_status_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status is not null and new.status is distinct from old.status then
    insert into public.sales_invoice_status_events (organization_id, bc_connection_id, bc_invoice_id, source, from_status, to_status)
    values (new.organization_id, new.bc_connection_id, new.bc_invoice_id, 'billcom', old.status, new.status);
  end if;
  return new;
end $$;
drop trigger if exists billcom_invoice_status_change on public.billcom_invoice_status;
create trigger billcom_invoice_status_change
  after update of status on public.billcom_invoice_status
  for each row execute function public.log_billcom_invoice_status_change();
