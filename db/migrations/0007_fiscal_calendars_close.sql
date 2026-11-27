-- Fiscal calendars and the close workflow (Phase 0 step 6).
--
-- Periods are generated per fiscal year by ledger.create_fiscal_year from the entity's
-- calendar settings; the app can no longer INSERT or UPDATE periods directly. Status moves
-- through ledger.close_period / seal_period (forward) and the two-person reopen
-- (ledger.request_reopen + approve_reopen), each writing an audit event.

-- 1. Entity calendar settings --------------------------------------------------------------
alter table entity
  add column fy_end_month  smallint not null default 12 check (fy_end_month between 1 and 12),
  add column week_end_dow  smallint not null default 0  check (week_end_dow between 0 and 6), -- 0 = Sunday
  add column fy_week_rule  text     not null default 'nearest' check (fy_week_rule in ('nearest', 'last'));

comment on column entity.fy_end_month is 'Fiscal year ends in this month (calendar_month) or near its last day (445, 13_period)';
comment on column entity.week_end_dow is 'Week-based calendars: weekday the fiscal week ends on (0 = Sunday)';
comment on column entity.fy_week_rule is 'Week-based calendars: year ends on week_end_dow nearest to, or last on/before, the month end';

-- Calendar settings are fixed once the entity has periods.
create function entity_guard() returns trigger language plpgsql as $$
begin
  if (new.fiscal_calendar, new.fy_end_month, new.week_end_dow, new.fy_week_rule)
     is distinct from (old.fiscal_calendar, old.fy_end_month, old.week_end_dow, old.fy_week_rule)
     and exists (select 1 from public.period where entity_id = old.id) then
    raise exception 'CALENDAR_FIXED: fiscal calendar settings cannot change once the entity has periods';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id then
    raise exception 'ENTITY_IMMUTABLE: id and tenant are fixed';
  end if;
  return new;
end $$;

create trigger entity_guard before update on entity
  for each row execute function entity_guard();

-- 2. Period position in its fiscal year ------------------------------------------------------
alter table period
  add column fiscal_year int,
  add column period_no   smallint check (period_no between 1 and 13);
-- Enforced for every new row (NOT VALID only skips pre-existing rows, of which there are none in production).
alter table period add constraint period_has_fiscal_position
  check (fiscal_year is not null and period_no is not null) not valid;
create unique index period_fiscal_position on period (entity_id, fiscal_year, period_no);

-- 3. Periods move backward only through the approved reopen ---------------------------------
create or replace function period_guard() returns trigger language plpgsql as $$
declare
  rank_old int := array_position(array['open','soft','hard','sealed'], old.status);
  rank_new int := array_position(array['open','soft','hard','sealed'], new.status);
begin
  if tg_op = 'DELETE' then
    raise exception 'PERIOD_IMMUTABLE: periods are never deleted';
  end if;
  if new.entity_id <> old.entity_id or new.start_date <> old.start_date or new.end_date <> old.end_date
     or new.fiscal_year is distinct from old.fiscal_year or new.period_no is distinct from old.period_no then
    raise exception 'PERIOD_IMMUTABLE: period dates, position and entity are fixed';
  end if;
  if rank_new < rank_old then
    if old.status = 'sealed' then
      raise exception 'PERIOD_SEALED: a sealed period never reopens; post a prior-period adjustment';
    end if;
    -- Only ledger.approve_reopen (runs as ledger_owner) marks the period it is reopening.
    if current_user <> 'ledger_owner'
       or current_setting('ledger.reopen_period', true) is distinct from old.id::text then
      raise exception 'PERIOD_BACKWARD: % -> % is not allowed (reopen requires the reopen workflow)', old.status, new.status;
    end if;
  end if;
  if old.seal_hash is not null and new.seal_hash is distinct from old.seal_hash then
    raise exception 'PERIOD_IMMUTABLE: seal hash cannot change';
  end if;
  if new.status = 'sealed' and old.status <> 'sealed' and current_user <> 'ledger_owner' then
    raise exception 'PERIOD_SEAL_DIRECT: use ledger.seal_period()';
  end if;
  if new.status = 'sealed' and new.seal_hash is null then
    raise exception 'PERIOD_SEAL_DIRECT: a sealed period needs a seal hash';
  end if;
  return new;
end $$;

-- 4. Reopen requests (two people: requester, then a different approver) ----------------------
set role ledger_owner;

create table ledger.period_reopen (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  entity_id      uuid not null,
  period_id      uuid not null,
  from_status    text not null check (from_status in ('soft', 'hard')),
  target_status  text not null check (target_status in ('open', 'soft')),
  reason         text not null check (length(trim(reason)) > 0),
  requested_by   uuid not null,
  requested_at   timestamptz not null default now(),
  state          text not null default 'pending' check (state in ('pending', 'approved', 'rejected')),
  decided_by     uuid,
  decided_at     timestamptz,
  foreign key (entity_id, period_id)    references public.period (entity_id, id),
  foreign key (tenant_id, requested_by) references public.principal (tenant_id, id),
  foreign key (tenant_id, decided_by)   references public.principal (tenant_id, id),
  check ((state = 'pending') = (decided_by is null))
);
create unique index one_pending_reopen on ledger.period_reopen (period_id) where state = 'pending';

-- A request is decided once, then frozen.
create function ledger.reopen_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.state <> 'pending'
     or (new.id, new.tenant_id, new.entity_id, new.period_id, new.from_status, new.target_status,
         new.reason, new.requested_by, new.requested_at)
        is distinct from
        (old.id, old.tenant_id, old.entity_id, old.period_id, old.from_status, old.target_status,
         old.reason, old.requested_by, old.requested_at) then
    raise exception 'IMMUTABLE: reopen requests are decided once and never edited';
  end if;
  return new;
end $$;

create trigger reopen_guard before update or delete on ledger.period_reopen
  for each row execute function ledger.reopen_guard();
create trigger reopen_no_truncate before truncate on ledger.period_reopen
  for each statement execute function ledger.forbid_change();

reset role;

-- 5. Grants: periods are now written only by the ledger functions ---------------------------
revoke insert, update on period from app_role;
grant insert on period to ledger_owner;
grant select on ledger.period_reopen to app_role;
