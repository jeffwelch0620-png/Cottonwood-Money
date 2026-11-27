set role ledger_owner;

-- Reversal request: builds the mirror-image entry and saves it as a draft proposed by the caller
-- (the requester). A different person approves it with ledger.approve_draft, which posts it through
-- ledger._post (mirror check, one reversal per entry, no live payment applications, open period).
-- Input: entry_id, entry_date (default: original date), memo.
drop function if exists ledger.reverse_entry(jsonb);
create or replace function ledger.request_reversal(p jsonb) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  o       ledger.journal_entry;
  m       public.membership := app.current_member();
  v_actor uuid;
  v_kind  text;
  lines   jsonb;
  ev      jsonb;
  v_id    uuid;
begin
  if m.tenant_id is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  if m.role = 'viewer' then
    raise exception 'ROLE_FORBIDDEN: viewers cannot request reversals';
  end if;
  select id, kind into v_actor, v_kind from public.principal where tenant_id = m.tenant_id and auth_user_id = m.user_id;
  if v_kind is distinct from 'user' then
    raise exception 'APPROVER_NOT_USER: only a person can request a reversal';
  end if;
  select * into o from ledger.journal_entry where id = (p->>'entry_id')::uuid and tenant_id = m.tenant_id;
  if not found then
    raise exception 'REVERSAL_LINK: entry % not found', p->>'entry_id';
  end if;
  if o.ic_group_id is not null then
    raise exception 'IC_REVERSE_PAIR: reverse intercompany pairs with a new intercompany pair';
  end if;
  if o.source_type = 'reversal' then
    raise exception 'REVERSAL_LINK: a reversal cannot itself be reversed; post a new entry';
  end if;
  if exists (select 1 from ledger.journal_entry where reverses_id = o.id) then
    raise exception 'ALREADY_REVERSED: entry % already has a reversal', o.seq;
  end if;
  if exists (select 1 from ledger.je_draft where tenant_id = o.tenant_id and state = 'pending'
              and payload->>'reverses_id' = o.id::text) then
    raise exception 'REVERSAL_PENDING: entry % already has a pending reversal request', o.seq;
  end if;
  if not ledger._lines_in_scope((select jsonb_agg(jsonb_build_object('location_id', location_id))
                                   from ledger.journal_line where entry_id = o.id)) then
    raise exception 'LOCATION_NOT_PERMITTED: the entry has lines outside your location scope';
  end if;

  select jsonb_agg(jsonb_build_object(
           'account_id', l.account_id, 'location_id', l.location_id,
           'debit', l.credit, 'credit', l.debit, 'dims', l.dims) order by l.line_no)
    into lines
    from ledger.journal_line l where l.entry_id = o.id;
  select coalesce(jsonb_agg(v.source_document_id), '[]'::jsonb) into ev
    from ledger.entry_evidence v where v.entry_id = o.id;

  insert into ledger.je_draft (tenant_id, entity_id, payload, created_by)
  values (o.tenant_id, o.entity_id, jsonb_build_object(
      'tenant_id', o.tenant_id, 'entity_id', o.entity_id,
      'entry_date', coalesce(p->>'entry_date', o.entry_date::text),
      'source_type', 'reversal', 'reverses_id', o.id,
      'memo', coalesce(p->>'memo', 'Reversal of entry ' || o.seq),
      'actor_type', 'user', 'created_by', v_actor,
      'evidence_ids', ev, 'lines', lines), v_actor)
  returning id into v_id;
  perform audit.append(o.tenant_id, 'user', v_actor, 'reversal.request', 'journal_entry', o.id,
                       jsonb_build_object('draft_id', v_id));
  return v_id;
end $$;

-- Intercompany (I6): both sides post in one transaction and their intercompany
-- account lines must net to zero across the pair.
-- Input: { "sides": [ <entry for entity A>, <entry for entity B> ] }
create or replace function ledger.post_intercompany(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  a     jsonb := p->'sides'->0;
  b     jsonb := p->'sides'->1;
  gid   uuid  := gen_random_uuid();
  ea    ledger.journal_entry;
  eb    ledger.journal_entry;
  net   numeric;
begin
  if jsonb_array_length(coalesce(p->'sides', '[]'::jsonb)) <> 2 then
    raise exception 'IC_REQUIRES_PAIR: exactly two sides are required';
  end if;
  if a->>'tenant_id' is distinct from b->>'tenant_id' then
    raise exception 'IC_TENANT_MISMATCH: both sides must be in the same tenant';
  end if;
  if a->>'entity_id' = b->>'entity_id' then
    raise exception 'IC_SAME_ENTITY: the two sides must be different entities';
  end if;

  -- Lock both entities in a fixed order so two opposite pairs can't deadlock.
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || least(a->>'entity_id', b->>'entity_id'), 0));
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || greatest(a->>'entity_id', b->>'entity_id'), 0));

  ea := ledger._post(a || jsonb_build_object('source_type', 'intercompany'), gid);
  eb := ledger._post(b || jsonb_build_object('source_type', 'intercompany'), gid);

  if ea.ic_group_id is distinct from eb.ic_group_id then
    raise exception 'IDEMPOTENCY_CONFLICT: only one side of this pair was posted before';
  end if;

  if not exists (select 1 from ledger.journal_line l join public.account ac on ac.id = l.account_id
                  where l.entry_id = ea.id and ac.is_intercompany)
     or not exists (select 1 from ledger.journal_line l join public.account ac on ac.id = l.account_id
                     where l.entry_id = eb.id and ac.is_intercompany) then
    raise exception 'IC_NOT_NETTING: each side needs an intercompany due-to/due-from line';
  end if;

  select sum(l.debit - l.credit) into net
    from ledger.journal_line l join public.account ac on ac.id = l.account_id
   where l.entry_id in (ea.id, eb.id) and ac.is_intercompany;
  if net <> 0 then
    raise exception 'IC_NOT_NETTING: intercompany lines net to % across the pair', net;
  end if;

  return jsonb_build_object('ic_group_id', ea.ic_group_id,
                            'sides', jsonb_build_array(ledger.result_json(ea), ledger.result_json(eb)));
end $$;

reset role;
