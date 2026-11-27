-- Phase 1 step 1.1: integration base.
--   connector         : a configured data source (Toast, bank feed, ...) or export, run as an
--                       integration principal
--   connector_secret  : encrypted credentials. app_role may write them but never read them;
--                       only worker_role reads, and only for a job it currently holds
--   job / job_attempt : a Postgres job queue with leases, retries and an insert-only attempt log
--   sync_run          : one pull of one scope (e.g. a business day); one running run per scope
--   evidence_object   : where a source file's bytes live in object-locked storage, by SHA-256
--
-- All writes go through the SECURITY DEFINER functions in db/functions/50_integration.sql.

do $$
begin
  if not exists (select from pg_roles where rolname = 'worker_role') then
    create role worker_role nologin;
  end if;
end $$;

create schema if not exists integration authorization ledger_owner;
revoke all on schema integration from public;
grant usage on schema integration to app_role, worker_role;

set role ledger_owner;

create table integration.connector (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  entity_id   uuid,
  kind        text not null check (kind in ('toast', 'bank_feed', 'bill_inbox', 'payroll', 'sample_pos', 'manifest_export')),
  name        text not null,
  run_as      uuid not null,                     -- integration principal the worker acts as
  config      jsonb not null default '{}',       -- non-secret settings only
  status      text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, entity_id)  references public.entity (tenant_id, id),
  foreign key (tenant_id, run_as)     references public.principal (tenant_id, id),
  foreign key (tenant_id, created_by) references public.principal (tenant_id, id)
);

create table integration.connector_secret (
  connector_id uuid primary key,
  tenant_id    uuid not null,
  ciphertext   bytea not null check (length(ciphertext) >= 29),  -- version + 12 IV + 16 tag + data
  key_id       text not null,
  updated_by   uuid not null,
  updated_at   timestamptz not null default now(),
  foreign key (tenant_id, connector_id) references integration.connector (tenant_id, id),
  foreign key (tenant_id, updated_by)   references public.principal (tenant_id, id)
);

create table integration.job (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  kind          text not null check (kind in ('connector_sync')),
  connector_id  uuid,
  run_as        uuid not null,
  payload       jsonb not null default '{}',
  dedupe_key    text,
  status        text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'dead')),
  attempts      int not null default 0 check (attempts >= 0),
  max_attempts  int not null default 5 check (max_attempts between 1 and 20),
  run_after     timestamptz not null default now(),
  locked_by     text,
  locked_until  timestamptz,
  attempt_started_at timestamptz,
  last_error    text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, dedupe_key),
  foreign key (tenant_id, connector_id) references integration.connector (tenant_id, id),
  foreign key (tenant_id, run_as)       references public.principal (tenant_id, id),
  check ((status = 'running') = (locked_by is not null and locked_until is not null)),
  check ((status in ('succeeded', 'dead')) = (finished_at is not null)),
  check (status <> 'dead' or last_error is not null)
);
create index job_ready_idx on integration.job (run_after) where status = 'queued';
create index job_lease_idx on integration.job (locked_until) where status = 'running';

create table integration.job_attempt (
  job_id       uuid not null,
  tenant_id    uuid not null,
  attempt_no   int not null check (attempt_no > 0),
  worker       text not null,
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  outcome      text not null check (outcome in ('succeeded', 'failed', 'lease_expired')),
  error        text,
  primary key (job_id, attempt_no),
  foreign key (tenant_id, job_id) references integration.job (tenant_id, id),
  check ((outcome = 'succeeded') = (error is null))
);

create table integration.sync_run (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  connector_id  uuid not null,
  scope_key     text not null,                   -- e.g. business day '2026-11-26'
  job_id        uuid,
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'abandoned')),
  lease_until   timestamptz not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  stats         jsonb not null default '{}',     -- {posted, already_posted, evidence_new, evidence_existing}
  error         text,
  foreign key (tenant_id, connector_id) references integration.connector (tenant_id, id),
  foreign key (tenant_id, job_id)       references integration.job (tenant_id, id),
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'failed' or error is not null)
);
-- One running run per connector and scope: two workers can never pull the same day at once.
create unique index sync_run_one_running on integration.sync_run (connector_id, scope_key) where status = 'running';

create table integration.evidence_object (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  source_document_id  uuid not null unique,
  sha256              bytea not null check (length(sha256) = 32),
  size_bytes          bigint not null check (size_bytes >= 0),
  content_type        text not null,
  backend             text not null check (backend in ('s3', 'memory')),
  bucket              text not null,
  object_key          text not null,
  version_id          text,
  retain_until        timestamptz not null,
  stored_at           timestamptz not null default now(),
  unique (tenant_id, sha256),
  foreign key (tenant_id, source_document_id) references public.source_document (tenant_id, id),
  -- The retention floor (7 years) is checked in register_evidence; this keeps any row honest.
  check (retain_until > stored_at)
);

-- Evidence records and the attempt log are insert-only, like the ledger.
create trigger eo_immutable before update or delete on integration.evidence_object
  for each row execute function ledger.forbid_change();
create trigger eo_no_truncate before truncate on integration.evidence_object
  for each statement execute function ledger.forbid_change();
create trigger ja_immutable before update or delete on integration.job_attempt
  for each row execute function ledger.forbid_change();
create trigger ja_no_truncate before truncate on integration.job_attempt
  for each statement execute function ledger.forbid_change();

-- Connectors and secrets are never deleted (disable instead); jobs and runs are history.
create trigger connector_no_delete before delete on integration.connector
  for each row execute function ledger.forbid_change();
create trigger secret_no_delete before delete on integration.connector_secret
  for each row execute function ledger.forbid_change();
create trigger job_no_delete before delete on integration.job
  for each row execute function ledger.forbid_change();
create trigger sync_run_no_delete before delete on integration.sync_run
  for each row execute function ledger.forbid_change();
do $$
declare t text;
begin
  foreach t in array array['connector', 'connector_secret', 'job', 'sync_run'] loop
    execute format('create trigger %1$s_no_truncate before truncate on integration.%1$I
                      for each statement execute function ledger.forbid_change()', t);
  end loop;
end $$;

reset role;

-- The definer functions create source documents for registered evidence.
grant select, insert on public.source_document to ledger_owner;

-- Privileges: app_role reads the non-secret tables (rows filtered by RLS); nobody but the
-- owner touches connector_secret. worker_role has no table privileges at all.
revoke all on all tables in schema integration from public, app_role, worker_role;
grant select on integration.connector, integration.job, integration.job_attempt,
                integration.sync_run, integration.evidence_object to app_role;
alter default privileges for role ledger_owner in schema integration revoke all on tables from public;
