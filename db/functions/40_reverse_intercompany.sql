set role ledger_owner;

-- Reversal: builds the mirror-image lines and posts them through the same door.
-- Input: entry_id, entry_date, idempotency_key, actor_type, created_by, approved_by, memo
create or replace function ledger.reverse_entry(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  o     ledger.journal_entry;
  lines jsonb;
  ev    jsonb;
begin
  select * into o from ledger.journal_entry where id = (p->>'entry_id')::uuid;
  if not found then
    raise exception 'REVERSAL_LINK: entry % not found', p->>'entry_id';
  end if;
  if o.ic_group_id is not null then
    raise exception 'IC_REVERSE_PAIR: reverse intercompany pairs with a new intercompany pair';
  end if;

  select jsonb_agg(jsonb_build_object(
           'account_id', l.account_id, 'location_id', l.location_id,
           'debit', l.credit, 'credit', l.debit, 'dims', l.dims) order by l.line_no)
    into lines
    from ledger.journal_line l where l.entry_id = o.id;

  select coalesce(jsonb_agg(v.source_document_id), '[]'::jsonb) into ev
    from ledger.entry_evidence v where v.entry_id = o.id;

  return ledger.result_json(ledger._post(jsonb_build_object(
    'tenant_id', o.tenant_id, 'entity_id', o.entity_id,
    'entry_date', coalesce(p->>'entry_date', o.entry_date::text),
    'source_type', 'reversal', 'reverses_id', o.id,
    'idempotency_key', coalesce(p->>'idempotency_key', 'reversal:' || o.id::text),
    'memo', coalesce(p->>'memo', 'Reversal of entry ' || o.seq),
    'actor_type', coalesce(p->>'actor_type', 'user'),
    'created_by', p->>'created_by', 'approved_by', p->>'approved_by',
    'allow_soft_close', p->'allow_soft_close',
    'evidence_ids', ev, 'lines', lines), null));
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
