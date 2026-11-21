-- Bill.com payment status stored per BC sales invoice. Filled by the
-- Customers & Receivables sync (and refreshed when an invoice page opens or a
-- card is charged). Its own table so the BC invoice sync never overwrites it.
-- Re-runnable.
create table if not exists public.billcom_invoice_status (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_invoice_id text not null,
  billcom_connection_id uuid references public.billcom_connections(id) on delete set null,
  -- found = matched by number, total and customer; mismatch = the number exists but total/customer differ.
  match text not null check (match in ('found', 'mismatch')),
  billcom_invoice_id text,
  status text,
  total_amount numeric,
  due_amount numeric,
  due_date date,
  billcom_updated_time timestamptz,
  checked_at timestamptz not null default now(),
  unique (bc_connection_id, bc_invoice_id)
);

create index if not exists billcom_invoice_status_org_idx
  on public.billcom_invoice_status (organization_id, bc_connection_id);

alter table public.billcom_invoice_status enable row level security;
drop policy if exists billcom_invoice_status_select on public.billcom_invoice_status;
create policy billcom_invoice_status_select on public.billcom_invoice_status
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );
