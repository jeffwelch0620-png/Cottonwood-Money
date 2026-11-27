-- Auth, membership and the actor link (Phase 0 step 5).
--
-- Identity comes from Supabase Auth: auth.uid() is the signed-in user and the JWT
-- carries tenant_id and aal (MFA level). A membership row is what turns
-- "a signed-in user who claims tenant X" into "a verified member of tenant X".
-- A principal (the actor recorded on entries) links to its login via auth_user_id.

-- Local shim for Supabase's auth schema. On Supabase these already exist and are left alone.
create schema if not exists auth;
do $$
begin
  if to_regclass('auth.users') is null then
    create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  end if;
  if to_regprocedure('auth.jwt()') is null then
    execute $f$
      create function auth.jwt() returns jsonb language sql stable as $b$
        select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                        nullif(current_setting('request.jwt.claims', true), ''))::jsonb
      $b$ $f$;
  end if;
  if to_regprocedure('auth.uid()') is null then
    execute $f$
      create function auth.uid() returns uuid language sql stable as $b$
        select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
      $b$ $f$;
  end if;
end $$;

grant usage on schema auth to ledger_owner;
grant execute on function auth.uid(), auth.jwt() to ledger_owner;

-- Session helpers (current tenant, member, principal) live here; see db/functions/05_auth.sql.
create schema if not exists app authorization ledger_owner;
revoke all on schema app from public;
grant usage on schema app to app_role;

-- Roles:
--   owner       manages members and principals; everything a controller can do except soft-close posting
--   controller  manages COA/periods, may post into soft-closed periods, seals periods
--   bookkeeper  posts and approves within location scope and approval limit
--   manager     same posting rights as bookkeeper, typically location-scoped
--   viewer      read only
--   service     machine login (agent or integration principal); never a person
create table membership (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id),
  tenant_id       uuid not null references tenant,
  role            text not null check (role in ('owner', 'controller', 'bookkeeper', 'manager', 'viewer', 'service')),
  location_ids    uuid[],                                         -- null = all locations
  approval_limit  numeric(19,4) check (approval_limit >= 0),      -- null = unlimited
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (user_id, tenant_id)
);
create index membership_tenant_idx on membership (tenant_id);

create function membership_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'MEMBERSHIP_IMMUTABLE: memberships are never deleted; set active = false';
  end if;
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.tenant_id <> old.tenant_id) then
    raise exception 'MEMBERSHIP_IMMUTABLE: user and tenant are fixed; deactivate and add a new membership';
  end if;
  if new.location_ids is not null and exists (
       select 1 from unnest(new.location_ids) l
        where not exists (select 1 from public.location x where x.id = l and x.tenant_id = new.tenant_id)) then
    raise exception 'LOCATION_NOT_IN_TENANT: every location in location_ids must belong to the tenant';
  end if;
  return new;
end $$;

create trigger membership_guard before insert or update or delete on membership
  for each row execute function membership_guard();

-- Link a principal to its login. One login = at most one principal per tenant.
alter table principal add column auth_user_id uuid references auth.users (id);
alter table principal add constraint principal_one_login_per_tenant unique (tenant_id, auth_user_id);

-- A principal's kind decides whether it can approve; it must never change.
create function principal_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'PRINCIPAL_IMMUTABLE: principals are never deleted';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.kind <> old.kind then
    raise exception 'PRINCIPAL_IMMUTABLE: id, tenant and kind are fixed';
  end if;
  if old.auth_user_id is not null and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'PRINCIPAL_IMMUTABLE: login identity is fixed once set';
  end if;
  return new;
end $$;

create trigger principal_guard before update or delete on principal
  for each row execute function principal_guard();

-- Grants. Tenants are created only through app.create_tenant(), never by direct INSERT.
grant select on membership to ledger_owner;
grant insert on tenant, principal, membership to ledger_owner;
grant select, insert, update on membership to app_role;
revoke insert on tenant from app_role;
