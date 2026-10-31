-- 057_add_billcom_link_claim.sql
-- Short lease on a Bill.com customer link so two push runs never process the
-- same customer at once (prevents duplicate Bill.com creates). Re-runnable.

alter table public.billcom_customer_links
  add column if not exists claimed_until timestamptz;
