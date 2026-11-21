-- The Sales invoices list: each posted BC invoice with its stored Bill.com
-- payment status, so search, filters and paging run in the database across
-- every invoice (not just the newest 500 loaded into the browser).
--
-- billcom_group mirrors billcomPaymentDisplay (src/lib/billcom/paymentDisplay.ts):
--   unmatched = no stored match, or the number exists but total/customer differ
--   paid      = PAID_IN_FULL
--   owed      = money still due with a due date (Past due once that date passes;
--               the date check lives in the query because "today" changes)
--   open      = everything else (including VOID and unknown statuses)
-- billcom_owed_due_date is the due date only for owed invoices, so
-- "Past due" is one filter: billcom_owed_due_date < today.
--
-- security_invoker = true keeps the org-scoped row-level security of both
-- tables in force for anyone querying the view (see 042 for why).
-- Re-runnable.
create or replace view public.sales_invoice_list
with (security_invoker = true) as
select
  i.id,
  i.organization_id,
  i.bc_connection_id,
  i.bc_invoice_id,
  i.bc_invoice_number,
  i.external_document_number,
  i.customer_number,
  i.customer_name,
  i.posting_date,
  i.due_date,
  i.currency_code,
  i.total_amount_including_tax,
  i.status,
  concat_ws(' ', i.bc_invoice_number, i.customer_name, i.external_document_number) as search_text,
  s.match as billcom_match,
  s.status as billcom_status,
  s.due_amount as billcom_due_amount,
  s.due_date as billcom_due_date,
  case
    when s.match is distinct from 'found' then 'unmatched'
    when s.status = 'PAID_IN_FULL' then 'paid'
    when s.status is distinct from 'VOID' and coalesce(s.due_amount, 0) > 0 and s.due_date is not null then 'owed'
    else 'open'
  end as billcom_group,
  case
    when s.match = 'found' and s.status is distinct from 'PAID_IN_FULL' and s.status is distinct from 'VOID'
      and coalesce(s.due_amount, 0) > 0
    then s.due_date
  end as billcom_owed_due_date
from public.business_central_sales_invoices i
left join public.billcom_invoice_status s
  on s.bc_connection_id = i.bc_connection_id and s.bc_invoice_id = i.bc_invoice_id;

-- Newest-first paging per environment.
create index if not exists business_central_sales_invoices_list_idx
  on public.business_central_sales_invoices (organization_id, bc_connection_id, posting_date desc nulls last, bc_invoice_number desc);
