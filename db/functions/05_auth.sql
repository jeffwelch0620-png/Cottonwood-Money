-- Session identity. Every function here derives identity from the JWT claims of the
-- current request (auth.uid(), auth.jwt()) and verifies it against membership.
-- Nothing here accepts an actor or tenant as a parameter.
set role ledger_owner;

-- The tenant the JWT claims, or null if the claim is missing or malformed.
create or replace function app.jwt_tenant() returns uuid
language plpgsql stable set search_path = pg_catalog, public, pg_temp as $$
begin
  return nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
exception when others then
  return null;
end $$;

-- The caller's verified membership: right user, claimed tenant, active, and MFA (aal2)
-- for people. Machine logins (role 'service') cannot do MFA and are exempt.
create or replace function app.current_member() returns public.membership
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select m.* from public.membership m
   where m.user_id = auth.uid()
     and m.tenant_id = app.jwt_tenant()
     and m.active
     and (m.role = 'service' or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
$$;

create or replace function app.current_tenant() returns uuid
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select (app.current_member()).tenant_id
$$;

-- The caller's principal (the actor that gets recorded on entries and audit events).
create or replace function app.current_principal() returns uuid
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select p.id from public.principal p
   where p.tenant_id = app.current_tenant() and p.auth_user_id = auth.uid()
$$;

create or replace function app.has_role(variadic p_roles text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((app.current_member()).role = any(p_roles), false)
$$;

-- null = all locations (only meaningful together with a non-null current_tenant()).
create or replace function app.allowed_locations() returns uuid[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select (app.current_member()).location_ids
$$;

-- Sign-up: the signed-in (MFA) user creates a tenant and becomes its owner and first principal.
create or replace function app.create_tenant(p_name text, p_display_name text default null) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_principal uuid;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED: sign in first';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'MFA_REQUIRED: complete multi-factor sign-in first';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'MISSING_FIELD: tenant name is required';
  end if;
  insert into public.tenant (name) values (p_name) returning id into v_tenant;
  insert into public.membership (user_id, tenant_id, role) values (v_uid, v_tenant, 'owner');
  insert into public.principal (tenant_id, kind, name, auth_user_id)
       values (v_tenant, 'user', coalesce(p_display_name, 'Owner'), v_uid) returning id into v_principal;
  perform audit.append(v_tenant, 'user', v_principal, 'tenant.create', 'tenant', v_tenant,
                       jsonb_build_object('name', p_name));
  return v_tenant;
end $$;

reset role;
