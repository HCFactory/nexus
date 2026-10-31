-- 055_add_customer_editing_fields.sql
-- Extra Business Central customer fields needed for editing customers from
-- Nexus. Re-runnable: every statement uses add column if not exists.
-- Note: BC uses '' (empty string) for "no value", so these text columns are
-- not null with default ''. bc_card_etag is the etag of the OData
-- Customer_Card_Excel record (customer writes go there); it differs from
-- bc_etag, which holds the API v2 etag.

alter table public.business_central_customers
  add column if not exists email_cc text not null default '',
  add column if not exists payment_terms_code text not null default '',
  add column if not exists tax_area_code text not null default '',
  add column if not exists tax_identification_type text not null default '',
  add column if not exists customer_price_group text not null default '',
  add column if not exists customer_posting_group text not null default '',
  add column if not exists gen_bus_posting_group text not null default '',
  add column if not exists application_method text not null default '',
  add column if not exists location_code text not null default '',
  add column if not exists credit_limit numeric not null default 0,
  add column if not exists bc_card_etag text;
