-- The ledger: posted entries only. Drafts and proposals never live here, which is what
-- makes insert-only possible.

-- ledger_owner needs to reference and read the reference tables.
grant references, select on tenant, principal, entity, location, account, period, source_document to ledger_owner;
grant update (status, seal_hash) on period to ledger_owner;

set role ledger_owner;

create table ledger.journal_entry (
  id               uuid primary key,
  tenant_id        uuid not null,
  entity_id        uuid not null,
  period_id        uuid not null,
  seq              bigint not null check (seq > 0),     -- gap-free per entity
  entry_date       date not null,
  posted_at        timestamptz not null,
  source_type      text not null check (source_type in
                     ('pos_dsj', 'ap_bill', 'ap_payment', 'bank', 'payroll', 'inventory',
                      'manual', 'reversal', 'intercompany', 'opening')),
  idempotency_key  text not null,
  memo             text,
  actor_type       text not null check (actor_type in ('user', 'agent', 'integration')),
  created_by       uuid not null,
  approved_by      uuid,
  reverses_id      uuid references ledger.journal_entry (id),
  ic_group_id      uuid,                                 -- links the two sides of an intercompany pair
  prev_hash        bytea not null check (length(prev_hash) = 32),
  hash             bytea not null check (length(hash) = 32),
  unique (entity_id, seq),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, id),
  unique (tenant_id, entity_id, id),
  foreign key (tenant_id, entity_id)   references public.entity (tenant_id, id),
  foreign key (entity_id, period_id)   references public.period (entity_id, id),
  foreign key (tenant_id, created_by)  references public.principal (tenant_id, id),
  foreign key (tenant_id, approved_by) references public.principal (tenant_id, id)
);

-- An entry can be reversed at most once.
create unique index one_reversal on ledger.journal_entry (reverses_id) where reverses_id is not null;

create table ledger.journal_line (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null,
  line_no      int not null check (line_no > 0),
  tenant_id    uuid not null,
  entity_id    uuid not null,
  account_id   uuid not null,
  location_id  uuid not null,
  debit        numeric(19,4) not null default 0,
  credit       numeric(19,4) not null default 0,
  dims         jsonb not null default '{}',
  check (debit >= 0 and credit >= 0 and (debit = 0) <> (credit = 0)),
  unique (entry_id, line_no),
  -- Lines are written before their header inside post_entry, so this FK is deferred to commit.
  foreign key (tenant_id, entity_id, entry_id) references ledger.journal_entry (tenant_id, entity_id, id)
    deferrable initially deferred,
  foreign key (tenant_id, account_id)  references public.account (tenant_id, id),
  foreign key (entity_id, location_id) references public.location (entity_id, id)
);

create index journal_line_account_idx on ledger.journal_line (tenant_id, account_id);
create index journal_line_entry_idx   on ledger.journal_line (entry_id);

create table ledger.entry_evidence (
  entry_id            uuid not null,
  tenant_id           uuid not null,
  source_document_id  uuid not null,
  primary key (entry_id, source_document_id),
  foreign key (tenant_id, entry_id) references ledger.journal_entry (tenant_id, id)
    deferrable initially deferred,
  foreign key (tenant_id, source_document_id) references public.source_document (tenant_id, id)
);

-- Daily anchor of each entity's chain head. Catches a rewritten or truncated tail,
-- which a self-consistent chain alone cannot.
create table ledger.chain_manifest (
  entity_id  uuid not null,
  seq        bigint not null,
  hash       bytea not null,
  taken_at   timestamptz not null default now(),
  primary key (entity_id, seq)
);

reset role;
