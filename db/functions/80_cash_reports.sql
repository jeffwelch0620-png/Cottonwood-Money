-- Cash/accrual views, payment application, and reports (Phase 0 step 7).
--
-- Accrual is the stored ledger. Cash is computed line by line from account.cash_view and
-- payment applications, so the basis is a parameter, not a second set of books.
--
-- Per entry (debit-positive sums):  S = settle lines, A = always lines,
--   F = never lines that fund S (sign opposite to S), R = other never lines (riders, e.g. sales tax)
--   S + A + F + R = 0,   G = -(S + R) = A + F,   alpha = A / G
--   document  <=>  S <> 0, F <> 0, 0 <= alpha < 1
-- Cash view of a document:
--   entry date        : A lines in full, S and R lines x alpha
--   each settlement x : S and R lines x (x / |G|), F lines x (x / |F|)
-- Each of those groups sums to zero, so the cash view balances on every date. Non-documents
-- (daily sales, payments, depreciation, ...) appear in full on their entry date.
-- Rounding: cumulative allocation per line (round(line x cumulative weight) minus the previous),
-- residual of each group on the document's largest settle line. A fully settled document
-- therefore re-dates exactly its own amounts.
set role ledger_owner;

create or replace function ledger._entry_shape(p_entity uuid)
returns table (entry_id uuid, s numeric, a numeric, f numeric, r numeric, g numeric, alpha numeric, is_doc boolean)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with l as (
    select jl.entry_id, jl.debit - jl.credit amt, ac.cash_view cv
      from ledger.journal_line jl join public.account ac on ac.id = jl.account_id
     where jl.entity_id = p_entity),
  s as (
    select l.entry_id, coalesce(sum(l.amt) filter (where l.cv = 'settle'), 0) s from l group by l.entry_id),
  t as (
    select l.entry_id, s.s,
           coalesce(sum(l.amt) filter (where l.cv = 'always'), 0) a,
           coalesce(sum(l.amt) filter (where l.cv = 'never' and s.s <> 0 and sign(l.amt) = -sign(s.s)), 0) f,
           coalesce(sum(l.amt) filter (where l.cv = 'never' and not (s.s <> 0 and sign(l.amt) = -sign(s.s))), 0) r
      from l join s on s.entry_id = l.entry_id
     group by l.entry_id, s.s),
  u as (
    select t.*, -(t.s + t.r) g, case when t.s + t.r <> 0 then t.a / -(t.s + t.r) end alpha from t)
  select u.entry_id, u.s, u.a, u.f, u.r, u.g, u.alpha,
         coalesce(u.s <> 0 and u.f <> 0 and u.alpha >= 0 and u.alpha < 1, false)
    from u
$$;

-- Lines of the session's tenant visible to the caller (location scope), on either basis.
create or replace function ledger.cash_lines(p_entity uuid)
returns table (entry_id uuid, line_id uuid, account_id uuid, location_id uuid, view_date date, amount numeric)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with
  shape as (select * from ledger._entry_shape(p_entity)),
  lines as (
    select jl.id line_id, jl.entry_id, jl.line_no, jl.account_id, jl.location_id, jl.debit - jl.credit amt,
           ac.cash_view cv, je.entry_date, sh.is_doc, sh.s
      from ledger.journal_line jl
      join ledger.journal_entry je on je.id = jl.entry_id
      join public.account ac on ac.id = jl.account_id
      join shape sh on sh.entry_id = jl.entry_id
     where jl.entity_id = p_entity),
  dl as (
    select l.*, case when l.cv = 'always' then 'A' when l.cv = 'settle' then 'S'
                     when sign(l.amt) = -sign(l.s) then 'F' else 'R' end kind
      from lines l where l.is_doc),
  plug as (
    select distinct on (dl.entry_id) dl.entry_id, dl.line_id
      from dl where dl.kind = 'S' order by dl.entry_id, abs(dl.amt) desc, dl.line_no),
  -- An application settles its document, and also the payment when the payment is itself a
  -- document (a credit memo applied to a bill).
  events as (
    select pa.document_entry_id doc, pa.settled_on, pa.seq, pa.amount
      from ledger.payment_application pa where pa.entity_id = p_entity
    union all
    select pa.payment_entry_id, pa.settled_on, pa.seq, pa.amount
      from ledger.payment_application pa join shape sh on sh.entry_id = pa.payment_entry_id and sh.is_doc
     where pa.entity_id = p_entity),
  groups as (
    select sh.entry_id doc, 0::bigint gi, je.entry_date gdate, sh.alpha w, 0::numeric ff
      from shape sh join ledger.journal_entry je on je.id = sh.entry_id where sh.is_doc
    union all
    select ev.doc, row_number() over w, ev.settled_on,
           sh.alpha + sum(ev.amount) over w / abs(sh.g),
           sum(ev.amount) over w / abs(sh.f)
      from events ev join shape sh on sh.entry_id = ev.doc
    window w as (partition by ev.doc order by ev.seq rows unbounded preceding)),
  cum as (
    select d.line_id, d.entry_id, d.account_id, d.location_id, g.gi, g.gdate,
           case d.kind when 'A' then d.amt when 'F' then round(d.amt * g.ff, 4) else round(d.amt * g.w, 4) end raw,
           d.line_id = p.line_id is_plug
      from dl d join groups g on g.doc = d.entry_id join plug p on p.entry_id = d.entry_id),
  fixed as (
    select c.*, case when c.is_plug then c.raw - sum(c.raw) over (partition by c.entry_id, c.gi) else c.raw end cum_amt
      from cum c),
  emitted as (
    select f.entry_id, f.line_id, f.account_id, f.location_id, f.gdate view_date,
           f.cum_amt - coalesce(lag(f.cum_amt) over (partition by f.line_id order by f.gi), 0) amount
      from fixed f),
  allowed as (select app.allowed_locations() locs)
  select x.entry_id, x.line_id, x.account_id, x.location_id, x.view_date, x.amount
    from (select e.entry_id, e.line_id, e.account_id, e.location_id, e.view_date, e.amount from emitted e
          union all
          select l.entry_id, l.line_id, l.account_id, l.location_id, l.entry_date, l.amt from lines l where not l.is_doc) x,
         allowed
   where x.amount <> 0
     and exists (select 1 from public.entity en where en.id = p_entity and en.tenant_id = app.current_tenant())
     and (allowed.locs is null or x.location_id = any(allowed.locs))
$$;

create or replace function ledger.accrual_lines(p_entity uuid)
returns table (entry_id uuid, line_id uuid, account_id uuid, location_id uuid, view_date date, amount numeric)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jl.entry_id, jl.id, jl.account_id, jl.location_id, je.entry_date, jl.debit - jl.credit
    from ledger.journal_line jl
    join ledger.journal_entry je on je.id = jl.entry_id
   where jl.entity_id = p_entity
     and exists (select 1 from public.entity en where en.id = p_entity and en.tenant_id = app.current_tenant())
     and (app.allowed_locations() is null or jl.location_id = any(app.allowed_locations()))
$$;

create or replace function ledger.basis_lines(p_entity uuid, p_basis text)
returns table (entry_id uuid, line_id uuid, account_id uuid, location_id uuid, view_date date, amount numeric)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select * from ledger.cash_lines(p_entity) where p_basis = 'cash'
  union all
  select * from ledger.accrual_lines(p_entity) where p_basis = 'accrual'
$$;

-- Checks the entity is in the session's tenant and resolves the basis (default: entity's).
create or replace function ledger._report_basis(p_entity uuid, p_basis text) returns text
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v text;
begin
  select coalesce(p_basis, default_basis) into v from public.entity
   where id = p_entity and tenant_id = app.current_tenant();
  if not found then
    raise exception 'UNKNOWN_ENTITY: entity % is not in your tenant', p_entity;
  end if;
  if v not in ('accrual', 'cash') then
    raise exception 'BAD_INPUT: basis must be accrual or cash';
  end if;
  return v;
end $$;

-- Trial balance: per account, opening (before p_from), period debits/credits, closing at p_to.
create or replace function ledger.trial_balance(p_entity uuid, p_from date, p_to date, p_basis text default null)
returns table (account_id uuid, number text, name text, type text, opening numeric, debits numeric,
               credits numeric, closing numeric, basis text)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v text := ledger._report_basis(p_entity, p_basis);
begin
  return query
  select ac.id, ac.number, ac.name, ac.type,
         coalesce(sum(b.amount) filter (where b.view_date < coalesce(p_from, '-infinity'::date)), 0),
         coalesce(sum(b.amount) filter (where b.view_date >= coalesce(p_from, '-infinity'::date) and b.amount > 0), 0),
         coalesce(-sum(b.amount) filter (where b.view_date >= coalesce(p_from, '-infinity'::date) and b.amount < 0), 0),
         coalesce(sum(b.amount), 0),
         v
    from ledger.basis_lines(p_entity, v) b join public.account ac on ac.id = b.account_id
   where b.view_date <= p_to
   group by ac.id, ac.number, ac.name, ac.type
   order by ac.number;
end $$;

-- P&L: revenue and expense accounts for [p_from, p_to], amounts positive in their normal direction.
create or replace function ledger.profit_and_loss(p_entity uuid, p_from date, p_to date,
                                                  p_basis text default null, p_location uuid default null)
returns table (account_id uuid, number text, name text, type text, amount numeric, basis text)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v text := ledger._report_basis(p_entity, p_basis);
begin
  return query
  select ac.id, ac.number, ac.name, ac.type,
         case ac.type when 'revenue' then -sum(b.amount) else sum(b.amount) end,
         v
    from ledger.basis_lines(p_entity, v) b join public.account ac on ac.id = b.account_id
   where b.view_date between p_from and p_to
     and ac.type in ('revenue', 'expense')
     and (p_location is null or b.location_id = p_location)
   group by ac.id, ac.number, ac.name, ac.type
  having sum(b.amount) <> 0
   order by ac.number;
end $$;

-- Balance sheet at p_as_of. P&L accounts roll into two equity lines: earnings of prior fiscal
-- years and of the current fiscal year (no closing entries needed).
create or replace function ledger.balance_sheet(p_entity uuid, p_as_of date, p_basis text default null)
returns table (section text, account_id uuid, number text, name text, amount numeric, basis text)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v text := ledger._report_basis(p_entity, p_basis);
  v_fy_start date;
begin
  select min(p2.start_date) into v_fy_start
    from public.period p1 join public.period p2 on p2.entity_id = p1.entity_id and p2.fiscal_year = p1.fiscal_year
   where p1.entity_id = p_entity and p_as_of between p1.start_date and p1.end_date;
  v_fy_start := coalesce(v_fy_start, '-infinity'::date);

  return query
  with b as (select * from ledger.basis_lines(p_entity, v) x where x.view_date <= p_as_of)
  select ac.type, ac.id, ac.number, ac.name,
         case ac.type when 'asset' then sum(b.amount) else -sum(b.amount) end, v
    from b join public.account ac on ac.id = b.account_id
   where ac.type in ('asset', 'liability', 'equity')
   group by ac.id, ac.number, ac.name, ac.type
  having sum(b.amount) <> 0
  union all
  select 'equity', null::uuid, null::text, 'Retained earnings (prior years)',
         coalesce(-sum(b.amount), 0), v
    from b join public.account ac on ac.id = b.account_id
   where ac.type in ('revenue', 'expense') and b.view_date < v_fy_start
  union all
  select 'equity', null::uuid, null::text, 'Current year earnings',
         coalesce(-sum(b.amount), 0), v
    from b join public.account ac on ac.id = b.account_id
   where ac.type in ('revenue', 'expense') and b.view_date >= v_fy_start
   order by 1, 3 nulls last;
end $$;

-- Cash/accrual tie-out (spec §10 control):
--   NI_cash = NI_accrual - (change in working-capital accounts, accrual)
--                        + (change in the same accounts, cash view)
-- Working-capital accounts = balance-sheet accounts whose cash_view is not 'always'
-- (AR, AP, prepaids, accrued liabilities, deferred revenue, ...). The cash-view term is zero when
-- all cash is applied; otherwise it is the movement in unapplied cash and cash-basis riders.
create or replace function ledger.cash_accrual_tieout(p_entity uuid, p_from date, p_to date)
returns table (ni_accrual numeric, ni_cash numeric, wc_change_accrual numeric, wc_change_cash numeric,
               expected_ni_cash numeric, difference numeric, detail jsonb)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform ledger._report_basis(p_entity, 'accrual');
  return query
  with b as (
    select 'accrual' basis, x.* from ledger.accrual_lines(p_entity) x where x.view_date between p_from and p_to
    union all
    select 'cash', y.* from ledger.cash_lines(p_entity) y where y.view_date between p_from and p_to),
  t as (
    select coalesce(-sum(b.amount) filter (where b.basis = 'accrual' and ac.type in ('revenue','expense')), 0) nia,
           coalesce(-sum(b.amount) filter (where b.basis = 'cash'    and ac.type in ('revenue','expense')), 0) nic,
           coalesce(sum(b.amount) filter (where b.basis = 'accrual' and ac.type in ('asset','liability','equity')
                                              and ac.cash_view <> 'always'), 0) wca,
           coalesce(sum(b.amount) filter (where b.basis = 'cash'    and ac.type in ('asset','liability','equity')
                                              and ac.cash_view <> 'always'), 0) wcc
      from b join public.account ac on ac.id = b.account_id),
  d as (
    select coalesce(jsonb_object_agg(z.number, jsonb_build_object('name', z.name, 'accrual', z.acc::text, 'cash', z.cash::text)), '{}') j
      from (select ac.number, ac.name,
                   coalesce(sum(b.amount) filter (where b.basis = 'accrual'), 0) acc,
                   coalesce(sum(b.amount) filter (where b.basis = 'cash'), 0) cash
              from b join public.account ac on ac.id = b.account_id
             where ac.type in ('asset','liability','equity') and ac.cash_view <> 'always'
             group by ac.number, ac.name) z)
  select t.nia, t.nic, t.wca, t.wcc, t.nia - t.wca + t.wcc, t.nic - (t.nia - t.wca + t.wcc), d.j
    from t, d;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Payment application
-- ---------------------------------------------------------------------------------------------

-- Caller rules for posting-like actions: verified member, not a viewer, has a principal, not an agent.
create or replace function ledger._poster() returns uuid
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := app.current_member();
  v_principal uuid;
  v_kind text;
begin
  if m.tenant_id is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  if m.role = 'viewer' then
    raise exception 'ROLE_FORBIDDEN: viewers cannot change the books';
  end if;
  select id, kind into v_principal, v_kind from public.principal
   where tenant_id = m.tenant_id and auth_user_id = m.user_id;
  if v_principal is null then
    raise exception 'NO_PRINCIPAL: this login has no principal in the tenant';
  end if;
  if v_kind = 'agent' then
    raise exception 'AGENT_CANNOT_POST: agents propose; a person or integration must apply payments';
  end if;
  return v_principal;
end $$;

-- The period holding settled_on must be open (soft only with an owner/controller override).
create or replace function ledger._settlement_period_open(p_entity uuid, p_date date, p_allow_soft boolean)
returns void
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare pr public.period;
begin
  select * into pr from public.period where entity_id = p_entity and p_date between start_date and end_date;
  if not found then
    raise exception 'NO_PERIOD: no fiscal period covers %', p_date;
  end if;
  if pr.status = 'soft' and coalesce(p_allow_soft, false) then
    if not app.has_role('owner', 'controller') then
      raise exception 'SOFT_CLOSE_FORBIDDEN: only an owner or controller can settle into a soft-closed period';
    end if;
  elsif pr.status <> 'open' then
    raise exception 'PERIOD_CLOSED: settlement date % falls in a % period', p_date, pr.status;
  end if;
end $$;

create or replace function ledger.apply_payment(p_payment uuid, p_document uuid, p_amount numeric,
                                                p_allow_soft_close boolean default false)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor  uuid := ledger._poster();
  pay      ledger.journal_entry;
  doc      ledger.journal_entry;
  sh       record;
  v_sigma  numeric;
  v_pnet   numeric;
  v_open   numeric;
  v_cap    numeric;
  v_id     uuid;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 4) then
    raise exception 'BAD_LINE_AMOUNT: applied amount must be positive with at most 4 decimal places';
  end if;
  select * into pay from ledger.journal_entry where id = p_payment and tenant_id = app.current_tenant();
  select * into doc from ledger.journal_entry where id = p_document and tenant_id = app.current_tenant();
  if pay.id is null or doc.id is null then
    raise exception 'UNKNOWN_ENTRY: payment or document is not in your tenant';
  end if;
  if pay.entity_id <> doc.entity_id then
    raise exception 'ENTITY_MISMATCH: payment and document must be in the same entity';
  end if;
  if pay.id = doc.id then
    raise exception 'BAD_INPUT: an entry cannot settle itself';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || doc.entity_id::text, 0));

  if pay.source_type = 'reversal' or doc.source_type = 'reversal'
     or exists (select 1 from ledger.journal_entry where reverses_id in (pay.id, doc.id)) then
    raise exception 'ENTRY_REVERSED: reversed entries and reversals cannot be applied';
  end if;

  select * into sh from ledger._entry_shape(doc.entity_id) x where x.entry_id = doc.id;
  if not sh.is_doc then
    raise exception 'NOT_A_DOCUMENT: entry % has no open AR/AP balance to settle', doc.seq;
  end if;
  v_sigma := sign(sh.f);

  -- Document still open: |F| minus everything that settled it (as document, or as payment if a credit memo).
  select abs(sh.f) - coalesce(sum(amount), 0) into v_open
    from ledger.payment_application where document_entry_id = doc.id or payment_entry_id = doc.id;

  -- Payment capacity: its movement on the document's funding accounts, in the clearing direction,
  -- minus what it already settled.
  select coalesce(sum(jl.debit - jl.credit), 0) into v_pnet
    from ledger.journal_line jl
   where jl.entry_id = pay.id
     and jl.account_id in (select l2.account_id from ledger.journal_line l2 join public.account a2 on a2.id = l2.account_id
                            where l2.entry_id = doc.id and a2.cash_view = 'never'
                              and sign(l2.debit - l2.credit) = v_sigma);
  if v_pnet = 0 or sign(v_pnet) <> -v_sigma then
    raise exception 'NOT_A_PAYMENT: entry % does not clear the document''s AR/AP account', pay.seq;
  end if;
  -- Capacity is tracked per funding account: count only what this payment already settled on
  -- documents funded through any of the same accounts (or settled against it as a document).
  select abs(v_pnet) - coalesce(sum(pa.amount), 0) into v_cap
    from ledger.payment_application pa
   where pa.document_entry_id = pay.id
      or (pa.payment_entry_id = pay.id and exists (
            select 1 from ledger.journal_line l1 join public.account a1 on a1.id = l1.account_id
             where l1.entry_id = pa.document_entry_id and a1.cash_view = 'never'
               and l1.account_id in (select l2.account_id from ledger.journal_line l2 join public.account a2 on a2.id = l2.account_id
                                      where l2.entry_id = doc.id and a2.cash_view = 'never'
                                        and sign(l2.debit - l2.credit) = v_sigma)));

  if p_amount > v_open then
    raise exception 'OVER_APPLIED: document has % open, % requested', v_open, p_amount;
  end if;
  if p_amount > v_cap then
    raise exception 'OVER_APPLIED: payment has % unapplied, % requested', v_cap, p_amount;
  end if;

  perform ledger._settlement_period_open(pay.entity_id, pay.entry_date, p_allow_soft_close);

  insert into ledger.payment_application
    (tenant_id, entity_id, payment_entry_id, document_entry_id, amount, settled_on, created_by)
  values (pay.tenant_id, pay.entity_id, pay.id, doc.id, p_amount, pay.entry_date, v_actor)
  returning id into v_id;

  perform audit.append(pay.tenant_id, 'user', v_actor, 'payment.apply', 'payment_application', v_id,
    jsonb_build_object('payment_entry_id', pay.id, 'document_entry_id', doc.id,
                       'amount', p_amount::text, 'settled_on', pay.entry_date));
  return jsonb_build_object('id', v_id, 'settled_on', pay.entry_date, 'amount', p_amount::text,
                            'document_open', (v_open - p_amount)::numeric(19,4)::text);
end $$;

-- Un-application: a negative row at the original settled_on date. Never a delete.
create or replace function ledger.unapply_payment(p_application uuid, p_allow_soft_close boolean default false)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_actor uuid := ledger._poster();
  pa ledger.payment_application;
  v_id uuid;
begin
  select * into pa from ledger.payment_application where id = p_application and tenant_id = app.current_tenant();
  if not found then
    raise exception 'UNKNOWN_APPLICATION: %', p_application;
  end if;
  if pa.amount < 0 then
    raise exception 'BAD_INPUT: an un-application cannot itself be undone; apply again instead';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || pa.entity_id::text, 0));
  perform ledger._settlement_period_open(pa.entity_id, pa.settled_on, p_allow_soft_close);
  begin
    insert into ledger.payment_application
      (tenant_id, entity_id, payment_entry_id, document_entry_id, amount, settled_on, reverses_id, created_by)
    values (pa.tenant_id, pa.entity_id, pa.payment_entry_id, pa.document_entry_id, -pa.amount, pa.settled_on, pa.id, v_actor)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'ALREADY_UNAPPLIED: application % was already undone', pa.id;
  end;
  perform audit.append(pa.tenant_id, 'user', v_actor, 'payment.unapply', 'payment_application', v_id,
    jsonb_build_object('reverses_id', pa.id, 'amount', (-pa.amount)::text));
  return jsonb_build_object('id', v_id, 'reverses_id', pa.id);
end $$;

reset role;
