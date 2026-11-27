-- Admin console support (Phase 0 step 8).
--   1. Journal-entry drafts: one principal proposes (people or agents), a different person
--      approves, and only then is the entry posted through ledger._post.
--   2. Membership guard v2: role/limit/active changes are audit events, and a tenant can never
--      be left without an active owner.
--   3. Setup audit trail: every insert/update on entity, location, account, principal is an
--      audit event (who, what changed).

-- 1. Drafts ---------------------------------------------------------------------------------
set role ledger_owner;

create table ledger.je_draft (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  entity_id     uuid not null,
  payload       jsonb not null,                 -- the entry as proposed (no approver)
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  state         text not null default 'pending' check (state in ('pending', 'posted', 'rejected')),
  decided_by    uuid,
  decided_at    timestamptz,
  reason        text,
  entry_id      uuid,
  foreign key (tenant_id, entity_id)  references public.entity (tenant_id, id),
  foreign key (tenant_id, created_by) references public.principal (tenant_id, id),
  foreign key (tenant_id, decided_by) references public.principal (tenant_id, id),
  foreign key (tenant_id, entry_id)   references ledger.journal_entry (tenant_id, id),
  check ((state = 'pending') = (decided_by is null)),
  check ((state = 'posted') = (entry_id is not null))
);
create index je_draft_pending_idx on ledger.je_draft (tenant_id, state, created_at);

-- A draft is decided once, then frozen; its payload never changes.
create function ledger.draft_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.state <> 'pending'
     or (new.id, new.tenant_id, new.entity_id, new.payload, new.created_by, new.created_at)
        is distinct from (old.id, old.tenant_id, old.entity_id, old.payload, old.created_by, old.created_at) then
    raise exception 'IMMUTABLE: drafts are decided once and never edited; propose a new draft';
  end if;
  return new;
end $$;

create trigger draft_guard before update or delete on ledger.je_draft
  for each row execute function ledger.draft_guard();
create trigger draft_no_truncate before truncate on ledger.je_draft
  for each statement execute function ledger.forbid_change();

-- 2 + 3. Audit triggers run as ledger_owner (the only role that may append to audit) -----------
create function ledger.audit_row_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid;
  v_kind  text;
  v_diff  jsonb;
  v_tenant uuid;
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
begin
  begin
    v_actor := app.current_principal();
  exception when others then
    v_actor := null;
  end;
  select kind into v_kind from public.principal where id = v_actor;
  v_tenant := case when tg_table_name = 'tenant' then (v_new->>'id')::uuid else (v_new->>'tenant_id')::uuid end;
  if tg_op = 'UPDATE' then
    select coalesce(jsonb_object_agg(k, jsonb_build_object('from', v_old->k, 'to', v_new->k)), '{}')
      into v_diff
      from jsonb_object_keys(v_new) k where v_new->k is distinct from v_old->k;
    if v_diff = '{}' then return null; end if;
  else
    v_diff := v_new;
  end if;
  perform audit.append(v_tenant, coalesce(v_kind, 'system'), v_actor,
                       tg_table_name || '.' || lower(tg_op), tg_table_name, (v_new->>'id')::uuid, v_diff);
  return null;
end $$;

reset role;

create trigger audit_change after insert or update on membership
  for each row execute function ledger.audit_row_change();
create trigger audit_change after insert or update on entity
  for each row execute function ledger.audit_row_change();
create trigger audit_change after insert or update on location
  for each row execute function ledger.audit_row_change();
create trigger audit_change after insert or update on account
  for each row execute function ledger.audit_row_change();
create trigger audit_change after insert or update on principal
  for each row execute function ledger.audit_row_change();

-- Membership guard v2: adds the last-owner rule. Serialized per tenant so two owners
-- demoting each other at the same moment cannot both succeed.
create or replace function membership_guard() returns trigger language plpgsql as $$
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
  if tg_op = 'UPDATE' and old.role = 'owner' and old.active and (new.role <> 'owner' or not new.active) then
    perform pg_advisory_xact_lock(hashtextextended('owners:' || old.tenant_id::text, 0));
    if not exists (select 1 from public.membership
                    where tenant_id = old.tenant_id and role = 'owner' and active and id <> old.id) then
      raise exception 'LAST_OWNER: a tenant must keep at least one active owner';
    end if;
  end if;
  return new;
end $$;

grant select on ledger.je_draft to app_role;
grant insert on account to ledger_owner;   -- ledger.load_coa_template
