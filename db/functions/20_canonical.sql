-- Canonical form and hash of a journal entry (invariant I7).
-- Both the posting function and the verifier compute the hash through entry_hash(),
-- so the two can never disagree about what was hashed.
set role ledger_owner;

create or replace function ledger.canonical(e ledger.journal_entry) returns text
language sql stable as $$
  select jsonb_build_object(
    'h', jsonb_build_object(
      'id', e.id, 'tenant_id', e.tenant_id, 'entity_id', e.entity_id, 'period_id', e.period_id,
      'seq', e.seq, 'entry_date', e.entry_date::text,
      'posted_at', to_char(e.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'source_type', e.source_type, 'idempotency_key', e.idempotency_key, 'memo', e.memo,
      'actor_type', e.actor_type, 'created_by', e.created_by, 'approved_by', e.approved_by,
      'reverses_id', e.reverses_id, 'ic_group_id', e.ic_group_id),
    'l', coalesce((
      select jsonb_agg(jsonb_build_object(
               'n', l.line_no, 'account_id', l.account_id, 'location_id', l.location_id,
               'debit', l.debit::text, 'credit', l.credit::text, 'dims', l.dims)
             order by l.line_no)
      from ledger.journal_line l where l.entry_id = e.id), '[]'::jsonb),
    'ev', coalesce((
      select jsonb_agg(v.source_document_id order by v.source_document_id)
      from ledger.entry_evidence v where v.entry_id = e.id), '[]'::jsonb)
  )::text
$$;

-- h_n = SHA256(h_{n-1} || canonical(E_n))
create or replace function ledger.entry_hash(e ledger.journal_entry) returns bytea
language sql stable as $$
  select sha256(e.prev_hash || convert_to(ledger.canonical(e), 'UTF8'))
$$;

create or replace function ledger.genesis_hash(p_entity uuid) returns bytea
language sql immutable as $$
  select sha256(convert_to('ledger-genesis:' || p_entity::text, 'UTF8'))
$$;

reset role;
