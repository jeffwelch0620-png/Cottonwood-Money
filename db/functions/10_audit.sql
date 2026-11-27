-- Audit log: append-only, hash-chained per tenant.
set role ledger_owner;

create or replace function audit.event_hash(e audit.event) returns bytea
language sql stable as $$
  select sha256(e.prev_hash || convert_to(jsonb_build_object(
    'id', e.id, 'tenant_id', e.tenant_id, 'seq', e.seq,
    'at', to_char(e.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_type', e.actor_type, 'actor_id', e.actor_id, 'action', e.action,
    'object_type', e.object_type, 'object_id', e.object_id, 'detail', e.detail
  )::text, 'UTF8'))
$$;

create or replace function audit.append(
  p_tenant uuid, p_actor_type text, p_actor_id uuid, p_action text,
  p_object_type text, p_object_id uuid, p_detail jsonb
) returns audit.event
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  e         audit.event;
  head_seq  bigint;
  head_hash bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('audit:' || p_tenant::text, 0));
  select seq, hash into head_seq, head_hash
    from audit.event where tenant_id = p_tenant order by seq desc limit 1;

  e.id          := gen_random_uuid();
  e.tenant_id   := p_tenant;
  e.seq         := coalesce(head_seq, 0) + 1;
  e.at          := now();
  e.actor_type  := p_actor_type;
  e.actor_id    := p_actor_id;
  e.action      := p_action;
  e.object_type := p_object_type;
  e.object_id   := p_object_id;
  e.detail      := coalesce(p_detail, '{}'::jsonb);
  e.prev_hash   := coalesce(head_hash, sha256(convert_to('audit-genesis:' || p_tenant::text, 'UTF8')));
  e.hash        := audit.event_hash(e);

  insert into audit.event select (e).*;
  return e;
end $$;

create or replace function audit.verify_chain(p_tenant uuid)
returns table (ok boolean, checked bigint, first_bad_seq bigint, reason text)
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  e          audit.event;
  exp_seq    bigint := 1;
  exp_prev   bytea  := sha256(convert_to('audit-genesis:' || p_tenant::text, 'UTF8'));
  n          bigint := 0;
begin
  if p_tenant is distinct from app.current_tenant() then
    raise exception 'TENANT_MISMATCH: you can only verify your own tenant''s audit chain';
  end if;
  for e in select * from audit.event where tenant_id = p_tenant order by seq loop
    n := n + 1;
    if e.seq <> exp_seq then
      return query select false, n, exp_seq, 'SEQ_GAP'::text; return;
    end if;
    if e.prev_hash <> exp_prev then
      return query select false, n, e.seq, 'BROKEN_LINK'::text; return;
    end if;
    if audit.event_hash(e) <> e.hash then
      return query select false, n, e.seq, 'CONTENT_CHANGED'::text; return;
    end if;
    exp_seq  := e.seq + 1;
    exp_prev := e.hash;
  end loop;
  return query select true, n, null::bigint, null::text;
end $$;

reset role;
