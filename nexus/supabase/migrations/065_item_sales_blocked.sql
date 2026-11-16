-- BC's "Sales Blocked" item flag (Item Card), separate from "Blocked".
-- Sales orders hide items that are sales blocked. Filled by the item sync.
alter table public.business_central_items
  add column if not exists sales_blocked boolean not null default false;
