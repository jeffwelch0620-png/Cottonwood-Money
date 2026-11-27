-- Source evidence and the audit event log. Runs before the ledger, which references
-- source_document.

create table source_document (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenant,
  doc_type     text not null,           -- pos_eod, invoice, bank_line, payroll_file, memo, ...
  storage_uri  text not null,           -- object-locked (WORM) storage location
  sha256       bytea not null check (length(sha256) = 32),
  received_at  timestamptz not null default now(),
  extracted    jsonb,
  unique (tenant_id, id)
);

set role ledger_owner;

-- Append-only, hash-chained per tenant. Written only through audit.append().
create table audit.event (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  seq          bigint not null check (seq > 0),
  at           timestamptz not null,
  actor_type   text not null,
  actor_id     uuid,
  action       text not null,
  object_type  text not null,
  object_id    uuid,
  detail       jsonb not null default '{}',
  prev_hash    bytea not null,
  hash         bytea not null,
  unique (tenant_id, seq)
);

reset role;
