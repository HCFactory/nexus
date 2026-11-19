-- Notes on sales invoices (Receivables → Sales invoices → an invoice). Same shape
-- as sales_order_notes; keyed by the BC invoice id, since many invoices are
-- created in BC and have no Nexus order. Re-runnable.
create table if not exists public.sales_invoice_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  bc_connection_id uuid not null references public.business_central_connections(id) on delete cascade,
  bc_invoice_id text not null,
  body text not null check (char_length(body) between 1 and 4000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create index if not exists sales_invoice_notes_invoice_idx
  on public.sales_invoice_notes (organization_id, bc_connection_id, bc_invoice_id, created_at);

-- Reads and writes go through the server (service role); members may read their organization's notes.
alter table public.sales_invoice_notes enable row level security;
drop policy if exists sales_invoice_notes_select on public.sales_invoice_notes;
create policy sales_invoice_notes_select on public.sales_invoice_notes
  for select using (
    organization_id in (select organization_id from public.users where id = auth.uid())
  );
