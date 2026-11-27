-- Admin console functions (Phase 0 step 8).
--
--   ledger.propose_entry(entry)       draft by the session principal (people or agents)
--   ledger.approve_draft(draft)       a different person approves; posts through ledger._post
--   ledger.reject_draft(draft, why)   reviewer rejects, or the proposer withdraws
--   ledger.load_coa_template(name)    USAR-style restaurant chart of accounts (pending CPA review)
--   ledger.entry_detail(entry)        JE viewer: lines, evidence + sha256, hash checks, approvals, links
--   audit.export(from, to)            audit events for the session tenant + chain verification
set role ledger_owner;

create or replace function ledger.propose_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m        public.membership := app.current_member();
  v_actor  uuid;
  v_kind   text;
  v_entity uuid;
  v_lines  jsonb := p->'lines';
  v_dr     numeric := 0;
  v_cr     numeric := 0;
  v_line   jsonb;
  v_id     uuid;
  v_payload jsonb;
begin
  if m.tenant_id is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  if m.role = 'viewer' then
    raise exception 'ROLE_FORBIDDEN: viewers cannot propose entries';
  end if;
  select id, kind into v_actor, v_kind from public.principal where tenant_id = m.tenant_id and auth_user_id = m.user_id;
  if v_actor is null then
    raise exception 'NO_PRINCIPAL: this login has no principal in the tenant';
  end if;
  if (p->>'tenant_id')::uuid is distinct from m.tenant_id then
    raise exception 'TENANT_MISMATCH: draft is for another tenant';
  end if;
  if p->>'created_by' is not null and (p->>'created_by')::uuid <> v_actor then
    raise exception 'CREATOR_NOT_CALLER: a draft is always created by the session principal';
  end if;
  if p ? 'approved_by' or p ? 'allow_soft_close' then
    raise exception 'BAD_INPUT: approval and soft-close override are given at approval, not in the draft';
  end if;
  if p->>'source_type' in ('reversal', 'intercompany') then
    raise exception 'BAD_SOURCE_TYPE: reversals and intercompany pairs have their own functions';
  end if;
  begin
    v_entity := (p->>'entity_id')::uuid;
  exception when others then
    raise exception 'BAD_INPUT: entity_id must be a uuid';
  end;
  if not exists (select 1 from public.entity where id = v_entity and tenant_id = m.tenant_id) then
    raise exception 'UNKNOWN_ENTITY: entity % is not in your tenant', v_entity;
  end if;
  -- Early checks for a friendly queue; ledger._post re-checks everything at approval.
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) < 2 then
    raise exception 'TOO_FEW_LINES: an entry needs at least two lines';
  end if;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    begin
      v_dr := v_dr + coalesce((v_line->>'debit')::numeric, 0);
      v_cr := v_cr + coalesce((v_line->>'credit')::numeric, 0);
    exception when others then
      raise exception 'BAD_LINE_AMOUNT: line amounts must be numbers';
    end;
    -- Stored drafts are read by RLS policies and the approval queue, so only well-formed ids get in.
    if coalesce(v_line->>'account_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.account where id = (v_line->>'account_id')::uuid and tenant_id = m.tenant_id) then
      raise exception 'UNKNOWN_ACCOUNT: a draft line account is not in your tenant';
    end if;
    if coalesce(v_line->>'location_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.location where id = (v_line->>'location_id')::uuid and entity_id = v_entity) then
      raise exception 'LOCATION_NOT_IN_ENTITY: a draft line location does not belong to this entity';
    end if;
  end loop;
  if v_dr <> v_cr then
    raise exception 'UNBALANCED: debits % <> credits %', v_dr, v_cr;
  end if;

  v_payload := (p - 'created_by' - 'actor_type' - 'idempotency_key')
               || jsonb_build_object('created_by', v_actor, 'actor_type', v_kind);
  insert into ledger.je_draft (tenant_id, entity_id, payload, created_by)
  values (m.tenant_id, v_entity, v_payload, v_actor) returning id into v_id;
  perform audit.append(m.tenant_id, v_kind, v_actor, 'draft.propose', 'je_draft', v_id,
                       jsonb_build_object('source_type', p->>'source_type', 'total', v_dr::text));
  return v_id;
end $$;

create or replace function ledger.approve_draft(p_draft uuid, p_allow_soft_close boolean default false) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  d   ledger.je_draft;
  e   ledger.journal_entry;
  v_caller uuid := app.current_principal();
begin
  select * into d from ledger.je_draft where id = p_draft and tenant_id = app.current_tenant() for update;
  if not found then
    raise exception 'NO_DRAFT: draft % not found', p_draft;
  end if;
  if d.state <> 'pending' then
    raise exception 'REQUEST_DECIDED: draft is already %', d.state;
  end if;
  if v_caller = d.created_by then
    raise exception 'SELF_APPROVAL: the proposer cannot approve their own draft';
  end if;
  -- _post derives the approver from the session (caller <> creator => approver = caller) and
  -- enforces person-only approval, approval limit, location scope, period and every invariant.
  e := ledger._post(d.payload || jsonb_build_object('idempotency_key', 'draft:' || d.id::text,
                                                    'allow_soft_close', coalesce(p_allow_soft_close, false)), null, d.id);
  update ledger.je_draft set state = 'posted', decided_by = v_caller, decided_at = now(), entry_id = e.id
   where id = d.id;
  perform audit.append(d.tenant_id, 'user', v_caller, 'draft.approve', 'je_draft', d.id,
                       jsonb_build_object('entry_id', e.id, 'seq', e.seq));
  return ledger.result_json(e) || jsonb_build_object('draft_id', d.id);
end $$;

create or replace function ledger.reject_draft(p_draft uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  d ledger.je_draft;
  v_caller uuid := app.current_principal();
  v_kind text;
begin
  select * into d from ledger.je_draft where id = p_draft and tenant_id = app.current_tenant() for update;
  if not found then
    raise exception 'NO_DRAFT: draft % not found', p_draft;
  end if;
  if d.state <> 'pending' then
    raise exception 'REQUEST_DECIDED: draft is already %', d.state;
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'MISSING_FIELD: a rejection needs a reason';
  end if;
  if not ledger._lines_in_scope(d.payload->'lines') then
    raise exception 'LOCATION_NOT_PERMITTED: this draft has lines outside your location scope';
  end if;
  select kind into v_kind from public.principal where id = v_caller;
  -- The proposer may withdraw; otherwise a person who can approve entries (not a viewer).
  if v_caller is distinct from d.created_by
     and (v_kind is distinct from 'user' or not app.has_role('owner', 'controller', 'bookkeeper', 'manager')) then
    raise exception 'ROLE_FORBIDDEN: only a reviewer or the proposer can reject a draft';
  end if;
  update ledger.je_draft set state = 'rejected', decided_by = v_caller, decided_at = now(), reason = p_reason
   where id = d.id;
  perform audit.append(d.tenant_id, coalesce(v_kind, 'user'), v_caller, 'draft.reject', 'je_draft', d.id,
                       jsonb_build_object('reason', p_reason));
  return jsonb_build_object('draft_id', d.id, 'state', 'rejected');
end $$;

-- USAR-style chart for restaurants (Uniform System of Accounts for Restaurants layout).
-- A starting point for the CPA review (exit gate); adds only numbers not already in use.
create or replace function ledger.load_coa_template(p_template text default 'usar') returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_tenant uuid := app.current_tenant();
  v_actor uuid := ledger._closer();   -- owner/controller person
  v_added int;
begin
  if p_template <> 'usar' then
    raise exception 'BAD_INPUT: unknown template % (available: usar)', p_template;
  end if;
  with t(number, name, type, nb, cv, ic, usar) as (values
    ('1010','Operating cash','asset','D','always',false,'Cash'),
    ('1020','Cash drawers and safe','asset','D','always',false,'Cash'),
    ('1030','Payroll cash','asset','D','always',false,'Cash'),
    ('1210','Credit card clearing','asset','D','always',false,'Cash'),
    ('1220','Third-party delivery receivable','asset','D','always',false,'Cash'),
    ('1110','Accounts receivable','asset','D','never',false,'Receivables'),
    ('1410','Inventory - food','asset','D','always',false,'Inventories'),
    ('1420','Inventory - beverage','asset','D','always',false,'Inventories'),
    ('1430','Inventory - liquor','asset','D','always',false,'Inventories'),
    ('1440','Inventory - beer','asset','D','always',false,'Inventories'),
    ('1450','Inventory - wine','asset','D','always',false,'Inventories'),
    ('1460','Inventory - paper and supplies','asset','D','always',false,'Inventories'),
    ('1310','Prepaid expenses','asset','D','never',false,'Prepaid expenses'),
    ('1510','Furniture, fixtures and equipment','asset','D','always',false,'Property and equipment'),
    ('1520','Leasehold improvements','asset','D','always',false,'Property and equipment'),
    ('1590','Accumulated depreciation','asset','C','always',false,'Property and equipment'),
    ('1910','Due from affiliates','asset','D','never',true,'Other assets'),
    ('2010','Accounts payable','liability','C','never',false,'Accounts payable'),
    ('2110','Accrued payroll','liability','C','never',false,'Accrued expenses'),
    ('2120','Accrued expenses','liability','C','never',false,'Accrued expenses'),
    ('2210','Sales tax payable','liability','C','never',false,'Taxes payable'),
    ('2310','Payroll taxes payable','liability','C','never',false,'Taxes payable'),
    ('2410','Gift cards outstanding','liability','C','never',false,'Deferred revenue'),
    ('2420','Tips payable','liability','C','never',false,'Accrued expenses'),
    ('2510','Notes payable','liability','C','always',false,'Long-term debt'),
    ('2910','Due to affiliates','liability','C','never',true,'Other liabilities'),
    ('3010','Owner equity','equity','C','always',false,'Equity'),
    ('3020','Owner distributions','equity','D','always',false,'Equity'),
    ('4010','Food sales','revenue','C','settle',false,'Sales - food'),
    ('4110','Beverage sales','revenue','C','settle',false,'Sales - beverage'),
    ('4120','Liquor sales','revenue','C','settle',false,'Sales - beverage'),
    ('4130','Beer sales','revenue','C','settle',false,'Sales - beverage'),
    ('4140','Wine sales','revenue','C','settle',false,'Sales - beverage'),
    ('4210','Catering sales','revenue','C','settle',false,'Sales - other'),
    ('4310','Discounts and comps','revenue','D','settle',false,'Sales - contra'),
    ('5010','Cost of food','expense','D','settle',false,'Cost of sales - food'),
    ('5110','Cost of beverage','expense','D','settle',false,'Cost of sales - beverage'),
    ('5120','Cost of liquor','expense','D','settle',false,'Cost of sales - beverage'),
    ('5130','Cost of beer','expense','D','settle',false,'Cost of sales - beverage'),
    ('5140','Cost of wine','expense','D','settle',false,'Cost of sales - beverage'),
    ('6010','Salaries and wages - FOH','expense','D','settle',false,'Payroll'),
    ('6020','Salaries and wages - BOH','expense','D','settle',false,'Payroll'),
    ('6030','Salaries - management','expense','D','settle',false,'Payroll'),
    ('6110','Payroll taxes','expense','D','settle',false,'Employee benefits'),
    ('6120','Employee benefits','expense','D','settle',false,'Employee benefits'),
    ('7010','Direct operating - supplies','expense','D','settle',false,'Direct operating expenses'),
    ('7020','Direct operating - linen and laundry','expense','D','settle',false,'Direct operating expenses'),
    ('7110','Music and entertainment','expense','D','settle',false,'Music and entertainment'),
    ('7210','Marketing','expense','D','settle',false,'Marketing'),
    ('7310','Utilities','expense','D','settle',false,'Utilities'),
    ('7410','Credit card fees','expense','D','settle',false,'General and administrative'),
    ('7420','Third-party delivery commissions','expense','D','settle',false,'General and administrative'),
    ('7430','Professional fees','expense','D','settle',false,'General and administrative'),
    ('7440','Office and administrative','expense','D','settle',false,'General and administrative'),
    ('7510','Repairs and maintenance','expense','D','settle',false,'Repairs and maintenance'),
    ('8010','Rent','expense','D','settle',false,'Occupancy costs'),
    ('8020','Property taxes','expense','D','settle',false,'Occupancy costs'),
    ('8030','Insurance','expense','D','settle',false,'Occupancy costs'),
    ('8510','Depreciation','expense','D','always',false,'Depreciation and amortization'),
    ('8610','Interest expense','expense','D','settle',false,'Interest'),
    ('8710','Other income','revenue','C','settle',false,'Other income'),
    ('8910','Income taxes','expense','D','settle',false,'Income taxes'))
  insert into public.account (tenant_id, number, name, type, normal_balance, cash_view, is_intercompany, usar_code)
  select v_tenant, t.number, t.name, t.type, t.nb, t.cv, t.ic, t.usar from t
   where not exists (select 1 from public.account a where a.tenant_id = v_tenant and a.number = t.number);
  get diagnostics v_added = row_count;
  perform audit.append(v_tenant, 'user', v_actor, 'coa.template_load', 'tenant', v_tenant,
                       jsonb_build_object('template', p_template, 'added', v_added));
  return jsonb_build_object('template', p_template, 'added', v_added);
end $$;

-- JE viewer. Hash checks recompute through ledger.entry_hash (rule 5).
create or replace function ledger.entry_detail(p_entry uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  e ledger.journal_entry;
  v_prev bytea;
  v_locs uuid[] := app.allowed_locations();
begin
  select * into e from ledger.journal_entry where id = p_entry and tenant_id = app.current_tenant();
  if not found then
    raise exception 'UNKNOWN_ENTRY: entry % is not in your tenant', p_entry;
  end if;
  select hash into v_prev from ledger.journal_entry where entity_id = e.entity_id and seq = e.seq - 1;
  return jsonb_build_object(
    'id', e.id, 'entity_id', e.entity_id,
    'entity', (select legal_name from public.entity where id = e.entity_id),
    'seq', e.seq, 'entry_date', e.entry_date, 'posted_at', e.posted_at,
    'period', (select jsonb_build_object('id', id, 'fiscal_year', fiscal_year, 'period_no', period_no, 'status', status)
                 from public.period where id = e.period_id),
    'source_type', e.source_type, 'memo', e.memo, 'idempotency_key', e.idempotency_key,
    'created_by', (select jsonb_build_object('id', id, 'name', name, 'kind', kind) from public.principal where id = e.created_by),
    'approved_by', (select jsonb_build_object('id', id, 'name', name, 'kind', kind) from public.principal where id = e.approved_by),
    'lines', (select coalesce(jsonb_agg(jsonb_build_object(
                'line_no', l.line_no, 'account', a.number, 'account_name', a.name,
                'location', lo.name, 'debit', l.debit::text, 'credit', l.credit::text, 'dims', l.dims)
                order by l.line_no), '[]')
                from ledger.journal_line l
                join public.account a on a.id = l.account_id
                join public.location lo on lo.id = l.location_id
               where l.entry_id = e.id and (v_locs is null or l.location_id = any(v_locs))),
    'evidence', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', d.id, 'doc_type', d.doc_type, 'storage_uri', d.storage_uri,
                   'sha256', encode(d.sha256, 'hex'), 'received_at', d.received_at)), '[]')
                   from ledger.entry_evidence v join public.source_document d on d.id = v.source_document_id
                  where v.entry_id = e.id),
    'hash', encode(e.hash, 'hex'), 'prev_hash', encode(e.prev_hash, 'hex'),
    'hash_ok', ledger.entry_hash(e) = e.hash,
    'link_ok', e.prev_hash = coalesce(v_prev, case when e.seq = 1 then ledger.genesis_hash(e.entity_id) end),
    'reverses', (select jsonb_build_object('id', id, 'seq', seq) from ledger.journal_entry where id = e.reverses_id),
    'reversed_by', (select jsonb_build_object('id', id, 'seq', seq) from ledger.journal_entry where reverses_id = e.id),
    'ic_group_id', e.ic_group_id,
    'draft_id', (select id from ledger.je_draft where entry_id = e.id),
    'applications', (select coalesce(jsonb_agg(jsonb_build_object(
                       'id', pa.id, 'payment_entry_id', pa.payment_entry_id, 'document_entry_id', pa.document_entry_id,
                       'amount', pa.amount::text, 'settled_on', pa.settled_on) order by pa.seq), '[]')
                       from ledger.payment_application pa
                      where pa.payment_entry_id = e.id or pa.document_entry_id = e.id));
end $$;

-- Audit export: the session tenant's events in [from, to) plus a full-chain verification.
create or replace function audit.export(p_from timestamptz, p_to timestamptz)
returns table (seq bigint, at timestamptz, actor_type text, actor_id uuid, actor_name text, action text,
               object_type text, object_id uuid, detail jsonb, prev_hash text, hash text,
               chain_ok boolean, chain_checked bigint, chain_first_bad_seq bigint)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_tenant uuid := app.current_tenant();
  v record;
begin
  if v_tenant is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  if not app.has_role('owner', 'controller') then
    raise exception 'ROLE_FORBIDDEN: only an owner or controller can export the audit log';
  end if;
  select * into v from audit.verify_chain(v_tenant);
  return query
  select ev.seq, ev.at, ev.actor_type, ev.actor_id, pr.name, ev.action, ev.object_type, ev.object_id, ev.detail,
         encode(ev.prev_hash, 'hex'), encode(ev.hash, 'hex'), v.ok, v.checked, v.first_bad_seq
    from audit.event ev left join public.principal pr on pr.id = ev.actor_id
   where ev.tenant_id = v_tenant
     and ev.at >= coalesce(p_from, '-infinity') and ev.at < coalesce(p_to, 'infinity')
   order by ev.seq;
end $$;

reset role;
