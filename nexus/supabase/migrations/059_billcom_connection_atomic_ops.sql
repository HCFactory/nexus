-- 059_billcom_connection_atomic_ops.sql
-- Makes deleting a Bill.com connection and changing the default connection
-- all-or-nothing, and lets re-entering a credential recover from a dangling
-- Vault pointer.
--
-- Why: deleteBillcomConnection used to call delete_billcom_secrets, then
-- delete the row in a second request. If the row delete failed, the row kept
-- pointers to deleted Vault secrets; set_billcom_dev_key then "updated" a
-- secret that no longer existed (a silent no-op), so re-entering the key in
-- Edit could never fix it. saveBillcomConnection cleared the other default
-- before writing the row, so a failed write left the org with no default.
--
-- Also closes a credential leak: 024 and 046 revoked the Vault secret
-- functions only from PUBLIC and anon. Supabase grants EXECUTE on new public
-- functions directly to `authenticated` too, and revoking from PUBLIC does not
-- remove a direct grant — so any logged-in user could call
-- get_billcom_password / get_billcom_dev_key / get_bc_client_secret through the
-- API and read the plaintext credentials. The block at the end revokes
-- `authenticated` from every secret function. The app only calls them with the
-- service-role client, so nothing in Nexus loses access.
--
-- Re-runnable: create-or-replace, drop-if-exists, and revoke/grant are all idempotent.

-- One transaction: drop the Vault secrets and the row together, or neither.
-- Scoped to the org so a caller can only delete its own connection.
-- Returns false when no such connection exists for that org.
create or replace function public.delete_billcom_connection(p_connection_id uuid, p_org_id uuid)
returns boolean
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
  where id = p_connection_id and organization_id = p_org_id
  for update;

  if not found then
    return false;
  end if;

  delete from public.billcom_connections
  where id = p_connection_id and organization_id = p_org_id;

  if v_dev_key_id is not null then
    delete from vault.secrets where id = v_dev_key_id;
  end if;
  if v_password_id is not null then
    delete from vault.secrets where id = v_password_id;
  end if;

  return true;
end;
$$;

-- One transaction: make this connection the org's only default. The partial
-- unique index allows one default per org, so the others are cleared first —
-- inside the same transaction, so a failure leaves the old default in place.
create or replace function public.set_default_billcom_connection(p_connection_id uuid, p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Lock every connection in the org first: two admins setting different
  -- defaults at once then run one after the other instead of the second
  -- failing on the unique index, and the target cannot be deleted mid-call.
  perform 1 from public.billcom_connections
  where organization_id = p_org_id
  for update;

  if not exists (
    select 1 from public.billcom_connections
    where id = p_connection_id and organization_id = p_org_id
  ) then
    raise exception 'Bill.com connection % not found', p_connection_id;
  end if;

  update public.billcom_connections
  set is_default = false, updated_at = now()
  where organization_id = p_org_id and id <> p_connection_id and is_default;

  update public.billcom_connections
  set is_default = true, updated_at = now()
  where id = p_connection_id and organization_id = p_org_id;
end;
$$;

-- Same as 046, except a pointer to a Vault secret that no longer exists is
-- treated as no pointer: a new secret is created and the row repointed.
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
  select c.dev_key_secret_id into v_secret_id
  from public.billcom_connections c
  where c.id = p_connection_id
    and exists (select 1 from vault.secrets s where s.id = c.dev_key_secret_id);

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
  select c.password_secret_id into v_secret_id
  from public.billcom_connections c
  where c.id = p_connection_id
    and exists (select 1 from vault.secrets s where s.id = c.password_secret_id);

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

-- Replaced by delete_billcom_connection above; nothing calls it any more.
drop function if exists public.delete_billcom_secrets(uuid);

-- Lock down: service role only, for every function that touches Vault secrets.
--
-- Replacing a function KEEPS its existing grants — including Supabase's
-- default direct grant to `authenticated`. Revoking from PUBLIC does not remove
-- that grant, so each role must be named. (046's comment had this backwards,
-- which is how the gap went unnoticed.)
revoke all on function public.delete_billcom_connection(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_default_billcom_connection(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_billcom_dev_key(uuid, text) from public, anon, authenticated;
revoke all on function public.set_billcom_password(uuid, text) from public, anon, authenticated;
revoke all on function public.get_billcom_dev_key(uuid) from public, anon, authenticated;
revoke all on function public.get_billcom_password(uuid) from public, anon, authenticated;
revoke all on function public.get_bc_client_secret(uuid) from public, anon, authenticated;
revoke all on function public.set_bc_client_secret(uuid, text) from public, anon, authenticated;

grant execute on function public.delete_billcom_connection(uuid, uuid) to service_role;
grant execute on function public.set_default_billcom_connection(uuid, uuid) to service_role;
grant execute on function public.set_billcom_dev_key(uuid, text) to service_role;
grant execute on function public.set_billcom_password(uuid, text) to service_role;
grant execute on function public.get_billcom_dev_key(uuid) to service_role;
grant execute on function public.get_billcom_password(uuid) to service_role;
grant execute on function public.get_bc_client_secret(uuid) to service_role;
grant execute on function public.set_bc_client_secret(uuid, text) to service_role;

-- Check afterwards (run separately). Expect NO rows: no secret function may be
-- executable by anon or authenticated.
--
--   select grantee, routine_name
--   from information_schema.routine_privileges
--   where routine_schema = 'public'
--     and grantee in ('anon', 'authenticated', 'PUBLIC')
--     and routine_name in (
--       'get_billcom_dev_key', 'get_billcom_password', 'set_billcom_dev_key',
--       'set_billcom_password', 'delete_billcom_connection',
--       'set_default_billcom_connection', 'get_bc_client_secret', 'set_bc_client_secret'
--     );
