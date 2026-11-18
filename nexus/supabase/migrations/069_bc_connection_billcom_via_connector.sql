-- "BC only" invoicing: this BC environment's invoices reach Bill.com through
-- Bill.com's own BC connector, so Nexus posts in BC and never creates or checks
-- Bill.com invoices for it (spec: docs/superpowers/specs/2026-11-17-billcom-via-connector-design.md).
alter table public.business_central_connections
  add column if not exists billcom_via_connector boolean not null default false;
