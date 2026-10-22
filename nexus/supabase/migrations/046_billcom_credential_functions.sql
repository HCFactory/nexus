-- 046_billcom_credential_functions.sql
-- Vault accessors for Bill.com credentials, keyed by connection id rather than
-- organization id (credentials are per-environment). Shaped exactly like
-- set_bc_client_secret / get_bc_client_secret.
--
-- Re-runnable: create or replace function is idempotent.

create or replace function public.set_billcom_dev_key(p_connection_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_name text := 'billcom_dev_key_' || p_connection_id::text;
begin
  select dev_key_secret_id into v_secret_id
  from public.billcom_connections
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
        'Bill.com developer key for connection ' || p_connection_id::text
      );
    end if;

    update public.billcom_connections
    set dev_key_secret_id = v_secret_id, updated_at = now()
    where id = p_connection_id;
  end if;

  return v_secret_id;
end;
$$;

create or replace function public.get_billcom_dev_key(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  select dev_key_secret_id into v_secret_id
  from public.billcom_connections
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

create or replace function public.set_billcom_password(p_connection_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_name text := 'billcom_password_' || p_connection_id::text;
begin
  select password_secret_id into v_secret_id
  from public.billcom_connections
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
        'Bill.com password for connection ' || p_connection_id::text
      );
    end if;

    update public.billcom_connections
    set password_secret_id = v_secret_id, updated_at = now()
    where id = p_connection_id;
  end if;

  return v_secret_id;
end;
$$;

create or replace function public.get_billcom_password(p_connection_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  select password_secret_id into v_secret_id
  from public.billcom_connections
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
create or replace function public.delete_billcom_secrets(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev_key_id uuid;
  v_password_id uuid;
begin
  select dev_key_secret_id, password_secret_id
  into v_dev_key_id, v_password_id
  from public.billcom_connections
  where id = p_connection_id;

  if v_dev_key_id is not null then
    delete from vault.secrets where id = v_dev_key_id;
  end if;

  if v_password_id is not null then
    delete from vault.secrets where id = v_password_id;
  end if;
end;
$$;

-- Lock the wrappers down: only the service-role client may call them.
--
-- This is NOT optional. Postgres grants EXECUTE to PUBLIC on a newly created
-- function, and Supabase exposes public-schema functions as PostgREST RPC
-- endpoints callable by anon/authenticated. These functions are SECURITY
-- DEFINER and take a connection id as a parameter, so without this block any
-- caller could read, overwrite or erase the Bill.com credentials of ANY
-- connection in the system — defeating the point of storing them in Vault.
--
-- `create or replace function` does not preserve prior grants, so any future
-- migration that redefines these must restate this block. Migrations 024 and
-- 025 set the same precedent for set_bc_client_secret/get_bc_client_secret.

revoke all on function public.set_billcom_dev_key(uuid, text) from public, anon;
revoke all on function public.get_billcom_dev_key(uuid) from public, anon;
revoke all on function public.set_billcom_password(uuid, text) from public, anon;
revoke all on function public.get_billcom_password(uuid) from public, anon;
revoke all on function public.delete_billcom_secrets(uuid) from public, anon;

grant execute on function public.set_billcom_dev_key(uuid, text) to service_role;
grant execute on function public.get_billcom_dev_key(uuid) to service_role;
grant execute on function public.set_billcom_password(uuid, text) to service_role;
grant execute on function public.get_billcom_password(uuid) to service_role;
grant execute on function public.delete_billcom_secrets(uuid) to service_role;
