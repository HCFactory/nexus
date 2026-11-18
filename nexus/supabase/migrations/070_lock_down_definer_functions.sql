-- Security review 2026-11-18: two SECURITY DEFINER functions were callable by
-- more people than intended. Supabase grants EXECUTE on new public functions to
-- anon and authenticated by default, so "revoke from public" alone is not enough.
-- Re-runnable.

-- 1. delete_billcom_secrets erased a Bill.com connection's Vault secrets by id.
--    046 revoked it from public/anon but not authenticated, so any logged-in
--    user could wipe any connection's Bill.com credentials. The app never calls
--    it (delete_billcom_connection does the work), so only the server keeps it.
revoke all on function public.delete_billcom_secrets(uuid) from public, anon, authenticated;
grant execute on function public.delete_billcom_secrets(uuid) to service_role;

-- 2. create_environment_purchase_order created a purchase order in whatever
--    organization was passed, with whatever creator was passed, and had never
--    been revoked from anon. It now requires a signed-in member of that
--    organization (or the server) and records the caller as the creator.
create or replace function public.create_environment_purchase_order(
  p_organization_id uuid,
  p_bc_connection_id uuid,
  p_order_date date,
  p_created_by uuid
)
returns purchase_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sequence integer;
  v_prefix text;
  v_padding integer;
  v_order_number text;
  v_order purchase_orders;
  v_attempts integer := 0;
  v_created_by uuid := p_created_by;
begin
  if auth.role() is distinct from 'service_role' then
    if auth.uid() is null
       or not exists (select 1 from users where id = auth.uid() and organization_id = p_organization_id) then
      raise exception 'Not allowed to create purchase orders for this organization';
    end if;
    v_created_by := auth.uid();
  end if;

  if p_bc_connection_id is null then
    raise exception 'Business Central environment is required';
  end if;
  if not exists (
    select 1 from business_central_connections
    where id = p_bc_connection_id and organization_id = p_organization_id
  ) then
    raise exception 'Business Central environment not found for this organization';
  end if;

  insert into purchase_order_sequences (organization_id, bc_connection_id, current_sequence)
  values (p_organization_id, p_bc_connection_id, 0)
  on conflict (organization_id, bc_connection_id) do nothing;

  select coalesce(order_prefix, 'PO'), coalesce(order_padding, 5)
  into v_prefix, v_padding
  from org_order_settings
  where organization_id = p_organization_id;

  v_prefix := coalesce(v_prefix, 'PO');
  v_padding := coalesce(v_padding, 5);

  loop
    v_attempts := v_attempts + 1;
    if v_attempts > 25 then
      raise exception 'Could not allocate an environment purchase order number after % attempts', v_attempts - 1;
    end if;

    select current_sequence
    into v_sequence
    from purchase_order_sequences
    where organization_id = p_organization_id
      and bc_connection_id = p_bc_connection_id
    for update;

    v_sequence := coalesce(v_sequence, 0) + 1;
    v_order_number := v_prefix || '-' || lpad(v_sequence::text, v_padding, '0');

    update purchase_order_sequences
    set current_sequence = v_sequence,
        updated_at = now()
    where organization_id = p_organization_id
      and bc_connection_id = p_bc_connection_id;

    begin
      insert into purchase_orders (
        organization_id,
        bc_connection_id,
        order_number,
        order_sequence,
        order_date,
        created_by
      ) values (
        p_organization_id,
        p_bc_connection_id,
        v_order_number,
        v_sequence,
        p_order_date,
        v_created_by
      )
      returning * into v_order;

      return v_order;
    exception when unique_violation then
      continue;
    end;
  end loop;
end;
$$;

revoke all on function public.create_environment_purchase_order(uuid, uuid, date, uuid) from public, anon;
grant execute on function public.create_environment_purchase_order(uuid, uuid, date, uuid) to authenticated, service_role;
