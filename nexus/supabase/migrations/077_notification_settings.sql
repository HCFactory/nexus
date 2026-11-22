-- Staff notification emails, managed in Settings > Receivables.
--   backup_charge_emails  who is emailed when a backup card charge succeeds
--   card_saved_emails     who is emailed when a customer saves a card
--                         (null = never set: the old fixed address is used)
-- card_payments.charge_email_sent_at makes the charge email go out once.
--
-- Read and written only by server code (service role), like the Stripe tables
-- (see 067): RLS is on with no policy and the default grants are revoked.
-- Re-runnable.

create table if not exists public.org_notification_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  backup_charge_emails text[] not null default '{}',
  card_saved_emails text[],
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.org_notification_settings enable row level security;
revoke all on public.org_notification_settings from anon, authenticated;

alter table public.card_payments add column if not exists charge_email_sent_at timestamptz;
