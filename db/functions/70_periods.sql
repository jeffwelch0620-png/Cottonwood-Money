-- Fiscal calendars and the close workflow.
--
--   ledger.fy_end(entity, year)            last day of fiscal year `year` for the entity's calendar
--   ledger.create_fiscal_year(entity, y)   generates the year's periods (12 or 13)
--   ledger.close_period(period, status)    forward move to soft/hard, in date order
--   ledger.request_reopen / approve_reopen / reject_reopen   two-person reopen (never sealed)
--
-- Order rule for every status change: an earlier period's status is always >= a later one's
-- (open < soft < hard < sealed). Close and reopen take the entity's posting lock, so a post
-- can never land in a period that closed while the post was in flight.
set role ledger_owner;

create or replace function ledger.status_rank(s text) returns int
language sql immutable as $$
  select array_position(array['open','soft','hard','sealed'], s)
$$;

-- Fiscal year `y` ends:
--   calendar_month : last day of fy_end_month in year y
--   445, 13_period : on week_end_dow nearest to (or last on/before) that day -> 52- or 53-week years
create or replace function ledger.fy_end(e public.entity, y int) returns date
language plpgsql immutable as $$
declare
  anchor date := (make_date(y, e.fy_end_month, 1) + interval '1 month' - interval '1 day')::date;
  back   int  := (extract(dow from anchor)::int - e.week_end_dow + 7) % 7;
begin
  if e.fiscal_calendar = 'calendar_month' then
    return anchor;
  end if;
  if e.fy_week_rule = 'last' or back <= 3 then
    return anchor - back;
  end if;
  return anchor - back + 7;
end $$;

-- The caller must be a person with the owner or controller role in the session's tenant.
create or replace function ledger._closer() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_principal uuid := app.current_principal();
  v_kind text;
begin
  if app.current_tenant() is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  select kind into v_kind from public.principal where id = v_principal;
  if v_kind is distinct from 'user' then
    raise exception 'APPROVER_NOT_USER: only a person can manage periods';
  end if;
  if not app.has_role('owner', 'controller') then
    raise exception 'ROLE_FORBIDDEN: only an owner or controller can manage periods';
  end if;
  return v_principal;
end $$;

create or replace function ledger.create_fiscal_year(p_entity uuid, p_year int) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor  uuid := ledger._closer();
  e        public.entity;
  v_start  date;
  v_end    date;
  v_weeks  int;
  v_plan   int[];
  v_ps     date;
  v_pe     date;
  v_min    int;
  v_max    int;
  i        int;
begin
  select * into e from public.entity where id = p_entity and tenant_id = app.current_tenant();
  if not found then
    raise exception 'UNKNOWN_ENTITY: entity % is not in your tenant', p_entity;
  end if;
  if p_year is null or p_year not between 1900 and 2999 then
    raise exception 'BAD_INPUT: fiscal year must be between 1900 and 2999';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || p_entity::text, 0));

  select min(fiscal_year), max(fiscal_year) into v_min, v_max from public.period where entity_id = p_entity;
  if p_year between v_min and v_max then
    raise exception 'FISCAL_YEAR_EXISTS: fiscal year % already has periods', p_year;
  end if;
  if v_min is not null and p_year not in (v_min - 1, v_max + 1) then
    raise exception 'FISCAL_YEAR_GAP: fiscal years must be contiguous (next is % or %)', v_min - 1, v_max + 1;
  end if;

  v_start := ledger.fy_end(e, p_year - 1) + 1;
  v_end   := ledger.fy_end(e, p_year);

  if e.fiscal_calendar = 'calendar_month' then
    for i in 1..12 loop
      v_ps := (v_start + make_interval(months => i - 1))::date;
      v_pe := (v_start + make_interval(months => i))::date - 1;
      insert into public.period (tenant_id, entity_id, start_date, end_date, fiscal_year, period_no)
      values (e.tenant_id, e.id, v_ps, v_pe, p_year, i);
    end loop;
  else
    v_weeks := (v_end - v_start + 1) / 7;
    if (v_end - v_start + 1) not in (364, 371) then
      raise exception 'CALENDAR_ERROR: week-based fiscal year % has % days', p_year, v_end - v_start + 1;
    end if;
    v_plan := case e.fiscal_calendar
                when '445' then array[4,4,5, 4,4,5, 4,4,5, 4,4,5]
                else array_fill(4, array[13]) end;
    -- A 53-week year puts the extra week in the last period.
    v_plan[cardinality(v_plan)] := v_plan[cardinality(v_plan)] + (v_weeks - 52);
    v_ps := v_start;
    for i in 1..cardinality(v_plan) loop
      v_pe := v_ps + v_plan[i] * 7 - 1;
      insert into public.period (tenant_id, entity_id, start_date, end_date, fiscal_year, period_no)
      values (e.tenant_id, e.id, v_ps, v_pe, p_year, i);
      v_ps := v_pe + 1;
    end loop;
    if v_pe <> v_end then
      raise exception 'CALENDAR_ERROR: periods end % but fiscal year ends %', v_pe, v_end;
    end if;
  end if;

  perform audit.append(e.tenant_id, 'user', v_actor, 'fiscal_year.create', 'entity', e.id,
    jsonb_build_object('fiscal_year', p_year, 'calendar', e.fiscal_calendar,
                       'start', v_start, 'end', v_end, 'weeks', (v_end - v_start + 1) / 7.0));
  return jsonb_build_object('entity_id', e.id, 'fiscal_year', p_year, 'start_date', v_start,
                            'end_date', v_end, 'periods',
                            (select count(*) from public.period where entity_id = e.id and fiscal_year = p_year));
end $$;

create or replace function ledger.close_period(p_period uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := ledger._closer();
  pr public.period;
begin
  if p_status not in ('soft', 'hard') then
    raise exception 'BAD_INPUT: close_period moves to soft or hard; use seal_period to seal';
  end if;
  select * into pr from public.period where id = p_period and tenant_id = app.current_tenant();
  if not found then raise exception 'NO_PERIOD: %', p_period; end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || pr.entity_id::text, 0));
  select * into pr from public.period where id = p_period for update;

  if ledger.status_rank(p_status) <= ledger.status_rank(pr.status) then
    raise exception 'PERIOD_BACKWARD: period is already %; moving to % needs the reopen workflow', pr.status, p_status;
  end if;
  if exists (select 1 from public.period
              where entity_id = pr.entity_id and end_date < pr.start_date
                and ledger.status_rank(status) < ledger.status_rank(p_status)) then
    raise exception 'CLOSE_ORDER: every earlier period must be at least % first', p_status;
  end if;

  update public.period set status = p_status where id = p_period;
  perform audit.append(pr.tenant_id, 'user', v_actor, 'period.close', 'period', p_period,
    jsonb_build_object('from', pr.status, 'to', p_status, 'fiscal_year', pr.fiscal_year, 'period_no', pr.period_no));
  return jsonb_build_object('period_id', p_period, 'status', p_status);
end $$;

create or replace function ledger.request_reopen(p_period uuid, p_target text, p_reason text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := ledger._closer();
  pr public.period;
  v_id uuid;
begin
  select * into pr from public.period where id = p_period and tenant_id = app.current_tenant();
  if not found then raise exception 'NO_PERIOD: %', p_period; end if;
  if pr.status = 'sealed' then
    raise exception 'PERIOD_SEALED: a sealed period never reopens; post a prior-period adjustment';
  end if;
  if p_target not in ('open', 'soft') or ledger.status_rank(p_target) >= ledger.status_rank(pr.status) then
    raise exception 'BAD_INPUT: period is %; reopen target must be lower (open or soft)', pr.status;
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'MISSING_FIELD: a reopen needs a reason';
  end if;
  if exists (select 1 from public.period
              where entity_id = pr.entity_id and start_date > pr.end_date
                and ledger.status_rank(status) > ledger.status_rank(p_target)) then
    raise exception 'REOPEN_ORDER: a later period is closed beyond %; reopen the later period first', p_target;
  end if;
  begin
    insert into ledger.period_reopen (tenant_id, entity_id, period_id, from_status, target_status, reason, requested_by)
    values (pr.tenant_id, pr.entity_id, p_period, pr.status, p_target, p_reason, v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'REOPEN_PENDING: this period already has a pending reopen request';
  end;
  perform audit.append(pr.tenant_id, 'user', v_actor, 'period.reopen_request', 'period', p_period,
    jsonb_build_object('request_id', v_id, 'from', pr.status, 'to', p_target, 'reason', p_reason));
  return v_id;
end $$;

create or replace function ledger.approve_reopen(p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := ledger._closer();
  r  ledger.period_reopen;
  pr public.period;
begin
  select * into r from ledger.period_reopen where id = p_request and tenant_id = app.current_tenant();
  if not found then raise exception 'NO_REQUEST: reopen request % not found', p_request; end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || r.entity_id::text, 0));
  select * into r from ledger.period_reopen where id = p_request for update;
  if r.state <> 'pending' then
    raise exception 'REQUEST_DECIDED: request is already %', r.state;
  end if;
  if r.requested_by = v_actor then
    raise exception 'SELF_APPROVAL: the requester cannot approve their own reopen';
  end if;

  select * into pr from public.period where id = r.period_id for update;
  if pr.status <> r.from_status then
    raise exception 'REOPEN_STALE: period moved from % to % since the request', r.from_status, pr.status;
  end if;
  if exists (select 1 from public.period
              where entity_id = pr.entity_id and start_date > pr.end_date
                and ledger.status_rank(status) > ledger.status_rank(r.target_status)) then
    raise exception 'REOPEN_ORDER: a later period is closed beyond %; reopen the later period first', r.target_status;
  end if;

  perform set_config('ledger.reopen_period', pr.id::text, true);
  update public.period set status = r.target_status where id = pr.id;
  perform set_config('ledger.reopen_period', '', true);

  update ledger.period_reopen set state = 'approved', decided_by = v_actor, decided_at = now() where id = r.id;
  perform audit.append(pr.tenant_id, 'user', v_actor, 'period.reopen', 'period', pr.id,
    jsonb_build_object('request_id', r.id, 'from', r.from_status, 'to', r.target_status,
                       'reason', r.reason, 'requested_by', r.requested_by, 'approved_by', v_actor));
  return jsonb_build_object('period_id', pr.id, 'status', r.target_status);
end $$;

-- Any owner or controller (including the requester, to withdraw) can reject.
create or replace function ledger.reject_reopen(p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := ledger._closer();
  r ledger.period_reopen;
begin
  select * into r from ledger.period_reopen where id = p_request and tenant_id = app.current_tenant() for update;
  if not found then raise exception 'NO_REQUEST: reopen request % not found', p_request; end if;
  if r.state <> 'pending' then
    raise exception 'REQUEST_DECIDED: request is already %', r.state;
  end if;
  update ledger.period_reopen set state = 'rejected', decided_by = v_actor, decided_at = now() where id = r.id;
  perform audit.append(r.tenant_id, 'user', v_actor, 'period.reopen_reject', 'period', r.period_id,
    jsonb_build_object('request_id', r.id));
  return jsonb_build_object('request_id', r.id, 'state', 'rejected');
end $$;

reset role;
