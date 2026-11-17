-- 067_stripe_saved_cards.sql
-- Stripe saved cards: per-organization Stripe connections (credentials in
-- Vault), the Stripe customer mapping, the saved-card label, setup links and
-- card payments.
--
-- Everything keys on stripe_connection_id because Stripe customer and payment
-- method ids only exist in the Stripe account that created them. Customers are
-- identified by organization + bc_customer_number (not the per-environment
-- business_central_customers row id).
--
-- No column holds a card number or CVV: only brand, last4, expiry and Stripe ids.
--
-- RLS is enabled with NO POLICY on every table, like billcom_connections (045):
-- every access goes through a service-role server action, which bypasses RLS.
-- stripe_connections also points at Vault secrets, and card_setup_links holds
-- token hashes, so a member-scoped policy would expose them via PostgREST.
--
-- This migration is re-runnable: it contains no `create policy`, which is the
-- one statement with no IF NOT EXISTS form (see migrations 039 and 041).

create table if not exists public.stripe_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  secret_key_secret_id uuid,
  webhook_secret_secret_id uuid,
  livemode boolean,
  stripe_account_id text,
  is_enabled boolean not null default false,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stripe_connections_org_idx
  on public.stripe_connections (organization_id);

-- At most one default connection per organization.
create unique index if not exists stripe_connections_one_default_per_org
  on public.stripe_connections (organization_id)
  where is_default;

create table if not exists public.stripe_customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stripe_connection_id uuid not null references public.stripe_connections(id) on delete cascade,
  bc_customer_number text not null,
  stripe_customer_id text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists stripe_customers_connection_customer_key
  on public.stripe_customers (stripe_connection_id, bc_customer_number);
create unique index if not exists stripe_customers_connection_stripe_customer_key
  on public.stripe_customers (stripe_connection_id, stripe_customer_id);

create table if not exists public.customer_cards (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stripe_connection_id uuid not null references public.stripe_connections(id) on delete cascade,
  bc_customer_number text not null,
  stripe_payment_method_id text not null,
  brand text,
  last4 text,
  exp_month integer,
  exp_year integer,
  saved_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid
);

create unique index if not exists customer_cards_connection_pm_key
  on public.customer_cards (stripe_connection_id, stripe_payment_method_id);

-- At most one active card per customer per Stripe connection.
create unique index if not exists customer_cards_one_active_per_customer
  on public.customer_cards (stripe_connection_id, bc_customer_number)
  where removed_at is null;

create table if not exists public.card_setup_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stripe_connection_id uuid not null references public.stripe_connections(id) on delete cascade,
  bc_customer_number text not null,
  token_hash text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  canceled_at timestamptz,
  completed_at timestamptz,
  emailed_to text,
  stripe_checkout_session_id text
);

create unique index if not exists card_setup_links_token_hash_key
  on public.card_setup_links (token_hash);
create index if not exists card_setup_links_customer_idx
  on public.card_setup_links (stripe_connection_id, bc_customer_number);

create table if not exists public.card_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stripe_connection_id uuid not null references public.stripe_connections(id) on delete cascade,
  bc_customer_number text not null,
  sales_order_id uuid,
  bc_invoice_id text not null,
  billcom_invoice_id text not null,
  billcom_customer_id text not null,
  invoice_number text not null,
  amount numeric not null,
  currency text not null default 'usd',
  card_id uuid not null references public.customer_cards(id),
  stripe_payment_intent_id text,
  status text not null check (status in ('processing', 'succeeded', 'failed')),
  failure_message text,
  billcom_state text not null default 'not_started'
    check (billcom_state in ('not_started', 'recorded', 'recorded_manually', 'failed')),
  billcom_payment_id text,
  billcom_error text,
  charged_by uuid,
  charged_at timestamptz not null default now(),
  billcom_recorded_at timestamptz,
  recorded_manually_by uuid
);

create unique index if not exists card_payments_payment_intent_key
  on public.card_payments (stripe_payment_intent_id);

-- Blocks a second charge while one is in flight or not yet reconciled in Bill.com.
create unique index if not exists card_payments_one_open_per_invoice
  on public.card_payments (billcom_invoice_id)
  where status = 'processing'
     or (status = 'succeeded' and billcom_state not in ('recorded', 'recorded_manually'));

create index if not exists card_payments_customer_idx
  on public.card_payments (stripe_connection_id, bc_customer_number);

alter table public.stripe_connections enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.customer_cards enable row level security;
alter table public.card_setup_links enable row level security;
alter table public.card_payments enable row level security;

-- RLS with no policy already returns zero rows to anon and authenticated.
-- Revoke the default Supabase grants too, so the guarantee does not rest on
-- RLS alone (see 045).
revoke all on public.stripe_connections from anon, authenticated;
revoke all on public.stripe_customers from anon, authenticated;
revoke all on public.customer_cards from anon, authenticated;
revoke all on public.card_setup_links from anon, authenticated;
revoke all on public.card_payments from anon, authenticated;

-- Vault accessors, keyed by connection id. Shaped exactly like 046.

create or replace function public.set_stripe_secret_key(p_connection_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_name text := 'stripe_secret_key_' || p_connection_id::text;
begin
  select secret_key_secret_id into v_secret_id
  from public.stripe_connections
  where id = p_connection_id;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_secret);
  else
    select id into v_secret_id from vault.secrets where name = v_name;

    if v_secret_id is not null then
      perform vault.update_secret(v_secret_id, p_secret);
    else
      v_secret_id := vault.create_secret(
        p_secret, v_name,
        'Stripe secret key for connection ' || p_connection_id::text
      );
    end if;

    update public.stripe_connections
    set secret_key_secret_id = v_secret_id, updated_at = now()
    where id = p_connection_id;
  end if;

  return v_secret_id;
end;
$$;

create or replace function public.get_stripe_secret_key(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  select secret_key_secret_id into v_secret_id
  from public.stripe_connections
  where id = p_connection_id;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_secret;
end;
$$;

create or replace function public.set_stripe_webhook_secret(p_connection_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_name text := 'stripe_webhook_secret_' || p_connection_id::text;
begin
  select webhook_secret_secret_id into v_secret_id
  from public.stripe_connections
  where id = p_connection_id;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_secret);
  else
    select id into v_secret_id from vault.secrets where name = v_name;

    if v_secret_id is not null then
      perform vault.update_secret(v_secret_id, p_secret);
    else
      v_secret_id := vault.create_secret(
        p_secret, v_name,
        'Stripe webhook signing secret for connection ' || p_connection_id::text
      );
    end if;

    update public.stripe_connections
    set webhook_secret_secret_id = v_secret_id, updated_at = now()
    where id = p_connection_id;
  end if;

  return v_secret_id;
end;
$$;

create or replace function public.get_stripe_webhook_secret(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  select webhook_secret_secret_id into v_secret_id
  from public.stripe_connections
  where id = p_connection_id;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_secret;
end;
$$;

-- Deleting a connection row must not orphan its Vault entries. Called before
-- the row is removed, while the pointers are still readable.
create or replace function public.delete_stripe_secrets(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_key_id uuid;
  v_webhook_id uuid;
begin
  select secret_key_secret_id, webhook_secret_secret_id
  into v_secret_key_id, v_webhook_id
  from public.stripe_connections
  where id = p_connection_id;

  if v_secret_key_id is not null then
    delete from vault.secrets where id = v_secret_key_id;
  end if;

  if v_webhook_id is not null then
    delete from vault.secrets where id = v_webhook_id;
  end if;
end;
$$;

-- Lock the wrappers down: service role only. NOT optional: these are SECURITY
-- DEFINER and take a connection id, so any caller who can execute them could
-- read, overwrite or erase any connection's Stripe credentials.
--
-- Each role must be named. Supabase grants EXECUTE on new public functions
-- directly to `authenticated`, and revoking from PUBLIC does not remove that
-- direct grant (migration 059 fixed this gap for 046, whose comment had it
-- backwards). `create or replace function` also keeps existing grants, so any
-- future migration redefining these must restate this block.

revoke all on function public.set_stripe_secret_key(uuid, text) from public, anon, authenticated;
revoke all on function public.get_stripe_secret_key(uuid) from public, anon, authenticated;
revoke all on function public.set_stripe_webhook_secret(uuid, text) from public, anon, authenticated;
revoke all on function public.get_stripe_webhook_secret(uuid) from public, anon, authenticated;
revoke all on function public.delete_stripe_secrets(uuid) from public, anon, authenticated;

grant execute on function public.set_stripe_secret_key(uuid, text) to service_role;
grant execute on function public.get_stripe_secret_key(uuid) to service_role;
grant execute on function public.set_stripe_webhook_secret(uuid, text) to service_role;
grant execute on function public.get_stripe_webhook_secret(uuid) to service_role;
grant execute on function public.delete_stripe_secrets(uuid) to service_role;
