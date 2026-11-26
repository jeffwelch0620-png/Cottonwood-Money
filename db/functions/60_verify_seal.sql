set role ledger_owner;

-- Walks an entity's chain: seq must be gap-free, each prev_hash must equal the prior
-- hash, each hash must match recomputed content, every entry must balance, and every
-- manifest anchor must still match.
create or replace function ledger.verify_chain(p_entity uuid)
returns table (ok boolean, checked bigint, first_bad_seq bigint, reason text)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  e         ledger.journal_entry;
  exp_seq   bigint := 1;
  exp_prev  bytea  := ledger.genesis_hash(p_entity);
  n         bigint := 0;
  m         record;
begin
  for e in select * from ledger.journal_entry where entity_id = p_entity order by seq loop
    n := n + 1;
    if e.seq <> exp_seq then
      return query select false, n, exp_seq, 'SEQ_GAP'::text; return;
    end if;
    if e.prev_hash <> exp_prev then
      return query select false, n, e.seq, 'BROKEN_LINK'::text; return;
    end if;
    if ledger.entry_hash(e) <> e.hash then
      return query select false, n, e.seq, 'CONTENT_CHANGED'::text; return;
    end if;
    if (select coalesce(sum(debit - credit), 0) from ledger.journal_line where entry_id = e.id) <> 0 then
      return query select false, n, e.seq, 'UNBALANCED'::text; return;
    end if;
    exp_seq  := e.seq + 1;
    exp_prev := e.hash;
  end loop;

  for m in select * from ledger.chain_manifest where entity_id = p_entity order by seq loop
    if not exists (select 1 from ledger.journal_entry
                    where entity_id = p_entity and seq = m.seq and hash = m.hash) then
      return query select false, n, m.seq, 'MANIFEST_MISMATCH'::text; return;
    end if;
  end loop;

  return query select true, n, null::bigint, null::text;
end $$;

-- Records the current head of an entity's chain (run nightly by the worker; the
-- manifest is also exported to write-once storage and emailed to the owner).
create or replace function ledger.take_manifest(p_entity uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  s bigint; h bytea;
begin
  select seq, hash into s, h from ledger.journal_entry
   where entity_id = p_entity order by seq desc limit 1;
  if s is null then
    return jsonb_build_object('entity_id', p_entity, 'seq', 0);
  end if;
  insert into ledger.chain_manifest (entity_id, seq, hash) values (p_entity, s, h)
    on conflict (entity_id, seq) do nothing;
  return jsonb_build_object('entity_id', p_entity, 'seq', s, 'hash', encode(h, 'hex'));
end $$;

-- Seals a hard-closed period, recording the entity's chain head at that moment.
create or replace function ledger.seal_period(p_period uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  pr public.period; h bytea; v_kind text;
begin
  select * into pr from public.period where id = p_period for update;
  if not found then raise exception 'NO_PERIOD: %', p_period; end if;
  if pr.status <> 'hard' then
    raise exception 'PERIOD_NOT_HARD: only hard-closed periods can be sealed (is %)', pr.status;
  end if;
  select kind into v_kind from public.principal where id = p_actor and tenant_id = pr.tenant_id;
  if v_kind is distinct from 'user' then
    raise exception 'APPROVER_NOT_USER: only a person can seal a period';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || pr.entity_id::text, 0));
  select hash into h from ledger.journal_entry where entity_id = pr.entity_id order by seq desc limit 1;
  update public.period set status = 'sealed',
         seal_hash = coalesce(h, ledger.genesis_hash(pr.entity_id))
   where id = p_period;
  perform audit.append(pr.tenant_id, 'user', p_actor, 'period.seal', 'period', p_period,
                       jsonb_build_object('seal_hash', encode(coalesce(h, ledger.genesis_hash(pr.entity_id)), 'hex')));
  return jsonb_build_object('period_id', p_period, 'seal_hash', encode(coalesce(h, ledger.genesis_hash(pr.entity_id)), 'hex'));
end $$;

reset role;
