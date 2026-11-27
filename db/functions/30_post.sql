-- The only door into the ledger.
--
-- ledger._post        internal worker (not executable by app_role)
-- ledger.post_entry   public entry point for single-entity entries
--
-- Errors are raised as 'CODE: detail' so the application can map them to typed errors.
set role ledger_owner;

-- p_draft: set only by ledger.approve_draft (app_role cannot call _post), proving the creator
-- proposed this entry in their own session. Without it, the caller must be the creator.
drop function if exists ledger._post(jsonb, uuid);
create or replace function ledger._post(p jsonb, p_ic_group uuid default null, p_draft uuid default null)
returns ledger.journal_entry
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_tenant   uuid;
  v_entity   uuid;
  v_date     date;
  v_src      text  := p->>'source_type';
  v_key      text  := p->>'idempotency_key';
  v_lines    jsonb := p->'lines';
  e          ledger.journal_entry;
  v_existing ledger.journal_entry;
  v_period   public.period;
  v_acct     public.account;
  v_line     jsonb;
  v_n        int     := 0;
  v_dr       numeric := 0;
  v_cr       numeric := 0;
  v_d        numeric;
  v_c        numeric;
  v_ev       uuid[];
  v_kind     text;
  v_head_seq  bigint;
  v_head_hash bytea;
  v_orig     ledger.journal_entry;
  v_member   public.membership;
  v_caller   uuid;
  v_caller_kind text;
  v_soft     boolean := false;
begin
  -- 0. Required fields -----------------------------------------------------------------
  begin
    v_tenant := (p->>'tenant_id')::uuid;
    v_entity := (p->>'entity_id')::uuid;
    v_date   := (p->>'entry_date')::date;
  exception when others then
    raise exception 'BAD_INPUT: tenant_id, entity_id must be uuids and entry_date a date';
  end;
  if v_tenant is null or v_entity is null or v_date is null or v_src is null
     or coalesce(v_key, '') = '' or p->>'actor_type' is null or p->>'created_by' is null then
    raise exception 'MISSING_FIELD: tenant_id, entity_id, entry_date, source_type, idempotency_key, actor_type and created_by are required';
  end if;

  -- 0b. Caller: a verified member of THIS tenant, acting as their own principal -------
  v_member := app.current_member();
  if v_member.tenant_id is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  if v_tenant <> v_member.tenant_id then
    raise exception 'TENANT_MISMATCH: entry is for tenant %, session is for tenant %', v_tenant, v_member.tenant_id;
  end if;
  if v_member.role = 'viewer' then
    raise exception 'ROLE_FORBIDDEN: viewers cannot post';
  end if;
  select id, kind into v_caller, v_caller_kind from public.principal
   where tenant_id = v_member.tenant_id and auth_user_id = v_member.user_id;
  if v_caller is null then
    raise exception 'NO_PRINCIPAL: this login has no principal in the tenant';
  end if;
  if (v_member.role = 'service') <> (v_caller_kind <> 'user') then
    raise exception 'MEMBERSHIP_KIND_MISMATCH: role % cannot act as a % principal', v_member.role, v_caller_kind;
  end if;
  if v_caller_kind = 'agent' then
    raise exception 'AGENT_CANNOT_POST: agents propose; a person or integration must post';
  end if;

  if not exists (select 1 from public.entity where id = v_entity and tenant_id = v_tenant) then
    raise exception 'UNKNOWN_ENTITY: entity % is not in tenant %', v_entity, v_tenant;
  end if;

  -- 1. Serialize posting per entity so seq and the hash chain can never fork ----------
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || v_entity::text, 0));

  -- 2. Idempotency: a repeated key returns the original entry, never a second one -----
  select * into v_existing from ledger.journal_entry
   where tenant_id = v_tenant and idempotency_key = v_key;
  if found then
    if v_existing.entity_id <> v_entity then
      raise exception 'IDEMPOTENCY_CONFLICT: key % already used by another entity', v_key;
    end if;
    return v_existing;
  end if;

  -- 3. Source type and intercompany routing -------------------------------------------
  if v_src not in ('pos_dsj','ap_bill','ap_payment','ar_invoice','ar_receipt','bank','payroll','inventory',
                   'manual','reversal','intercompany','opening') then
    raise exception 'BAD_SOURCE_TYPE: %', v_src;
  end if;
  if (v_src = 'intercompany') <> (p_ic_group is not null) then
    raise exception 'IC_REQUIRES_PAIR: intercompany entries must be posted with ledger.post_intercompany';
  end if;

  -- 4. Actors and approval (segregation of duties) ------------------------------------
  e.actor_type := p->>'actor_type';
  e.created_by := (p->>'created_by')::uuid;

  select kind into v_kind from public.principal where id = e.created_by and tenant_id = v_tenant;
  if v_kind is null then
    raise exception 'UNKNOWN_PRINCIPAL: creator % is not in tenant', e.created_by;
  end if;
  if v_kind <> e.actor_type then
    raise exception 'ACTOR_MISMATCH: creator is a %, entry says %', v_kind, e.actor_type;
  end if;

  -- A human creator must be a real, active member (no ghost principals as "the other person").
  if v_kind = 'user' and not exists (
       select 1 from public.principal pr
         join public.membership m on m.user_id = pr.auth_user_id and m.tenant_id = pr.tenant_id
        where pr.id = e.created_by and m.active and m.role <> 'viewer') then
    raise exception 'CREATOR_NOT_MEMBER: creator % has no active membership', e.created_by;
  end if;

  -- The approver is never taken from input: it is the caller, when the caller is not the
  -- creator. An approved_by in the input may only restate that.
  if v_caller = e.created_by then
    if nullif(p->>'approved_by', '')::uuid = e.created_by then
      raise exception 'SELF_APPROVAL: creator cannot approve their own entry';
    elsif nullif(p->>'approved_by', '') is not null then
      raise exception 'APPROVER_NOT_CALLER: approval must be given in the approver''s own session';
    end if;
    e.approved_by := null;
  else
    -- Naming someone else as creator is only possible for a draft they proposed themselves.
    if p_draft is null then
      raise exception 'CREATOR_NOT_CALLER: post as yourself, or have % propose a draft for approval', e.created_by;
    end if;
    if not exists (select 1 from ledger.je_draft where id = p_draft and created_by = e.created_by and state = 'pending') then
      raise exception 'CREATOR_NOT_CALLER: draft % was not proposed by the named creator', p_draft;
    end if;
    if nullif(p->>'approved_by', '') is not null and (p->>'approved_by')::uuid <> v_caller then
      raise exception 'APPROVER_NOT_CALLER: approval must be given in the approver''s own session';
    end if;
    if v_caller_kind <> 'user' then
      raise exception 'APPROVER_NOT_USER: only people can approve; caller is a %', v_caller_kind;
    end if;
    e.approved_by := v_caller;
  end if;
  if v_src in ('manual', 'reversal', 'opening') and e.approved_by is null then
    raise exception 'APPROVAL_REQUIRED: % entries need a second-person approver', v_src;
  end if;

  -- 5. Period must be open (I3) --------------------------------------------------------
  select * into v_period from public.period
   where entity_id = v_entity and v_date between start_date and end_date;
  if not found then
    raise exception 'NO_PERIOD: no fiscal period covers % for this entity', v_date;
  end if;
  if v_period.status = 'soft' and coalesce((p->>'allow_soft_close')::boolean, false) then
    if v_member.role not in ('owner', 'controller') then
      raise exception 'SOFT_CLOSE_FORBIDDEN: only an owner or controller can post into a soft-closed period';
    end if;
    v_soft := true;
  end if;
  if not (v_period.status = 'open' or v_soft) then
    raise exception 'PERIOD_CLOSED: period % is %', v_period.id, v_period.status;
  end if;

  -- 6. Lines: shape, precision, ownership (I1, I2) ------------------------------------
  if jsonb_typeof(v_lines) is distinct from 'array' or jsonb_array_length(v_lines) < 2 then
    raise exception 'TOO_FEW_LINES: an entry needs at least two lines';
  end if;

  e.id := gen_random_uuid();

  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_n := v_n + 1;
    begin
      v_d := coalesce((v_line->>'debit')::numeric, 0);
      v_c := coalesce((v_line->>'credit')::numeric, 0);
    exception when others then
      raise exception 'BAD_LINE_AMOUNT: line % amounts must be numbers', v_n;
    end;
    if v_d < 0 or v_c < 0 or (v_d = 0) = (v_c = 0) then
      raise exception 'BAD_LINE_AMOUNT: line % needs exactly one positive debit or credit', v_n;
    end if;
    if v_d <> round(v_d, 4) or v_c <> round(v_c, 4) then
      raise exception 'BAD_PRECISION: line % has more than 4 decimal places', v_n;
    end if;

    select * into v_acct from public.account
     where id = (v_line->>'account_id')::uuid and tenant_id = v_tenant;
    if not found then
      raise exception 'UNKNOWN_ACCOUNT: line % account is not in tenant', v_n;
    end if;
    if not v_acct.active then
      raise exception 'INACTIVE_ACCOUNT: line % account % is inactive', v_n, v_acct.number;
    end if;
    if v_acct.is_intercompany and p_ic_group is null then
      raise exception 'IC_REQUIRES_PAIR: line % uses intercompany account %', v_n, v_acct.number;
    end if;
    if not exists (select 1 from public.location
                    where id = (v_line->>'location_id')::uuid and entity_id = v_entity) then
      raise exception 'LOCATION_NOT_IN_ENTITY: line % location does not belong to this entity', v_n;
    end if;
    if v_member.location_ids is not null
       and not ((v_line->>'location_id')::uuid = any(v_member.location_ids)) then
      raise exception 'LOCATION_NOT_PERMITTED: line % location is outside your location scope', v_n;
    end if;

    insert into ledger.journal_line
      (entry_id, line_no, tenant_id, entity_id, account_id, location_id, debit, credit, dims)
    values
      (e.id, v_n, v_tenant, v_entity, v_acct.id, (v_line->>'location_id')::uuid, v_d, v_c,
       coalesce(v_line->'dims', '{}'::jsonb));

    v_dr := v_dr + v_d;
    v_cr := v_cr + v_c;
  end loop;

  if v_dr <> v_cr then
    raise exception 'UNBALANCED: debits % <> credits %', v_dr, v_cr;
  end if;
  if e.approved_by is not null and v_member.approval_limit is not null and v_dr > v_member.approval_limit then
    raise exception 'APPROVAL_LIMIT: entry total % exceeds your approval limit %', v_dr, v_member.approval_limit;
  end if;

  -- 7. Evidence (I5) -------------------------------------------------------------------
  v_ev := array(select distinct x::uuid
                  from jsonb_array_elements_text(coalesce(p->'evidence_ids', '[]'::jsonb)) x);
  -- A reversal cites exactly its original's documents (checked in step 8), which may be none for
  -- a manual or opening entry.
  if v_src not in ('manual', 'opening', 'reversal') and cardinality(v_ev) = 0 then
    raise exception 'NO_EVIDENCE: % entries must cite at least one source document', v_src;
  end if;
  if (select count(*) from public.source_document where tenant_id = v_tenant and id = any(v_ev))
     <> cardinality(v_ev) then
    raise exception 'UNKNOWN_EVIDENCE: a cited source document is not in this tenant';
  end if;
  insert into ledger.entry_evidence (entry_id, tenant_id, source_document_id)
  select e.id, v_tenant, unnest(v_ev);

  -- 8. Reversal must exactly mirror its original -----------------------------------------
  if v_src = 'reversal' then
    select * into v_orig from ledger.journal_entry
     where id = nullif(p->>'reverses_id', '')::uuid and entity_id = v_entity;
    if not found then
      raise exception 'REVERSAL_LINK: original entry not found in this entity';
    end if;
    if v_orig.source_type = 'reversal' then
      raise exception 'REVERSAL_LINK: a reversal cannot itself be reversed; post a new entry';
    end if;
    if exists (select 1 from ledger.journal_entry where reverses_id = v_orig.id) then
      raise exception 'ALREADY_REVERSED: entry % already has a reversal', v_orig.id;
    end if;
    -- A payment or document that still settles something would keep driving the cash view.
    if (select coalesce(sum(amount), 0) from ledger.payment_application
         where payment_entry_id = v_orig.id or document_entry_id = v_orig.id) <> 0 then
      raise exception 'HAS_APPLICATIONS: entry % still has payment applications; unapply them first', v_orig.seq;
    end if;
    if exists (
         (select account_id, location_id, debit, credit, dims from ledger.journal_line where entry_id = v_orig.id
          except all
          select account_id, location_id, credit, debit, dims from ledger.journal_line where entry_id = e.id)
         union all
         (select account_id, location_id, credit, debit, dims from ledger.journal_line where entry_id = e.id
          except all
          select account_id, location_id, debit, credit, dims from ledger.journal_line where entry_id = v_orig.id)) then
      raise exception 'REVERSAL_MISMATCH: reversal lines must mirror the original exactly';
    end if;
    if exists ((select source_document_id from ledger.entry_evidence where entry_id = v_orig.id
                except select unnest(v_ev))
               union all
               (select unnest(v_ev) except select source_document_id from ledger.entry_evidence where entry_id = v_orig.id)) then
      raise exception 'REVERSAL_MISMATCH: a reversal cites exactly the original''s source documents';
    end if;
    e.reverses_id := v_orig.id;
  elsif p->>'reverses_id' is not null then
    raise exception 'REVERSAL_LINK: reverses_id is only allowed on reversal entries';
  end if;

  -- 9. Number and hash (I7) ------------------------------------------------------------
  select seq, hash into v_head_seq, v_head_hash
    from ledger.journal_entry where entity_id = v_entity order by seq desc limit 1;

  e.tenant_id       := v_tenant;
  e.entity_id       := v_entity;
  e.period_id       := v_period.id;
  e.seq             := coalesce(v_head_seq, 0) + 1;
  e.entry_date      := v_date;
  e.posted_at       := now();
  e.source_type     := v_src;
  e.idempotency_key := v_key;
  e.memo            := p->>'memo';
  e.ic_group_id     := p_ic_group;
  e.prev_hash       := coalesce(v_head_hash, ledger.genesis_hash(v_entity));
  e.hash            := ledger.entry_hash(e);

  insert into ledger.journal_entry select (e).*;

  perform audit.append(v_tenant, e.actor_type, e.created_by, 'ledger.post', 'journal_entry', e.id,
    jsonb_build_object('entity_id', v_entity, 'seq', e.seq, 'source_type', v_src,
                       'hash', encode(e.hash, 'hex'), 'approved_by', e.approved_by,
                       'posted_by', v_caller, 'soft_close_override', v_soft));
  return e;
end $$;

create or replace function ledger.result_json(e ledger.journal_entry) returns jsonb
language sql immutable as $$
  select jsonb_build_object('id', e.id, 'entity_id', e.entity_id, 'seq', e.seq,
                            'hash', encode(e.hash, 'hex'), 'posted_at', e.posted_at)
$$;

create or replace function ledger.post_entry(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  return ledger.result_json(ledger._post(p, null));
end $$;

reset role;
