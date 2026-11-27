-- Phase 1 step 1.1: connectors, encrypted secrets, the job queue, sync runs and evidence.
--
-- Who calls what:
--   app_role (a person or the integration principal, from JWT claims):
--     create_connector, set_connector_status, set_connector_secret (write-only), request_sync,
--     start_sync_run, finish_sync_run, register_evidence
--   worker_role (the job worker; no tenant claims, no table privileges):
--     enqueue_due_syncs, claim_job, heartbeat_job, complete_job, fail_job, read_secret
-- The worker does tenant work (posting, evidence) in an app_role session as the job's run_as
-- principal, so every ledger rule still applies to it.

-- Caller helpers ---------------------------------------------------------------------------
create or replace function integration._require_member() returns public.membership
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare m public.membership := app.current_member();
begin
  if m.tenant_id is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  return m;
end $$;

-- Keys in connector config that look like credentials. Secrets go in connector_secret.
create or replace function integration._secret_looking_keys(j jsonb) returns text[]
language sql immutable set search_path = pg_catalog as $$
  with recursive walk(v) as (
    select j
    union all
    select c.value from walk,
      lateral (select value from jsonb_each(case when jsonb_typeof(walk.v) = 'object' then walk.v else '{}' end)
               union all
               select value from jsonb_array_elements(case when jsonb_typeof(walk.v) = 'array' then walk.v else '[]' end)) c
  )
  select coalesce(array_agg(distinct k), '{}') from walk,
    lateral jsonb_object_keys(case when jsonb_typeof(walk.v) = 'object' then walk.v else '{}' end) k
   where k ~* '(secret|password|passwd|token|api[_-]?key|private[_-]?key|credential)'
$$;

-- 1. Connectors -----------------------------------------------------------------------------
create or replace function integration.create_connector(p jsonb) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m        public.membership := integration._require_member();
  v_actor  uuid := app.current_principal();
  v_id     uuid;
  v_run_as uuid := (p->>'run_as')::uuid;
  v_entity uuid := (p->>'entity_id')::uuid;
  v_config jsonb := coalesce(p->'config', '{}');
  v_bad    text[];
begin
  if not app.has_role('owner', 'controller') then
    raise exception 'ROLE_FORBIDDEN: only an owner or controller can add a connector';
  end if;
  if coalesce(p->>'kind', '') = '' or coalesce(p->>'name', '') = '' or v_run_as is null then
    raise exception 'MISSING_FIELD: kind, name and run_as are required';
  end if;
  if jsonb_typeof(v_config) <> 'object' then
    raise exception 'BAD_CONFIG: config must be a JSON object';
  end if;
  v_bad := integration._secret_looking_keys(v_config);
  if cardinality(v_bad) > 0 then
    raise exception 'SECRET_IN_CONFIG: % look like credentials; store them with set_connector_secret', v_bad;
  end if;
  if v_entity is not null and not exists (select 1 from entity where id = v_entity and tenant_id = m.tenant_id) then
    raise exception 'UNKNOWN_ENTITY: entity % is not in your tenant', v_entity;
  end if;
  -- The worker acts as run_as: it must be an integration principal with an active service login.
  if not exists (select 1 from principal pr join membership ms
                   on ms.user_id = pr.auth_user_id and ms.tenant_id = pr.tenant_id
                  where pr.id = v_run_as and pr.tenant_id = m.tenant_id and pr.kind = 'integration'
                    and ms.role = 'service' and ms.active) then
    raise exception 'BAD_RUN_AS: run_as must be an integration principal of this tenant with an active service login';
  end if;

  insert into integration.connector (tenant_id, entity_id, kind, name, run_as, config, created_by)
  values (m.tenant_id, v_entity, p->>'kind', p->>'name', v_run_as, v_config, v_actor)
  returning id into v_id;
  perform audit.append(m.tenant_id, 'user', v_actor, 'connector.create', 'connector', v_id,
                       jsonb_build_object('kind', p->>'kind', 'name', p->>'name', 'run_as', v_run_as, 'config', v_config));
  return v_id;
end $$;

create or replace function integration.set_connector_status(p_connector uuid, p_status text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := integration._require_member();
  v_old text;
begin
  if not app.has_role('owner', 'controller') then
    raise exception 'ROLE_FORBIDDEN: only an owner or controller can change a connector';
  end if;
  select status into v_old from integration.connector where id = p_connector and tenant_id = m.tenant_id for update;
  if not found then raise exception 'NO_CONNECTOR: %', p_connector; end if;
  update integration.connector set status = p_status where id = p_connector;
  perform audit.append(m.tenant_id, 'user', app.current_principal(), 'connector.status', 'connector', p_connector,
                       jsonb_build_object('from', v_old, 'to', p_status));
end $$;

-- Write-only: the ciphertext goes in, nothing comes back out to app_role.
create or replace function integration.set_connector_secret(p_connector uuid, p_ciphertext bytea, p_key_id text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := integration._require_member();
  v_actor uuid := app.current_principal();
begin
  if not app.has_role('owner', 'controller') then
    raise exception 'ROLE_FORBIDDEN: only an owner or controller can set connector credentials';
  end if;
  if not exists (select 1 from integration.connector where id = p_connector and tenant_id = m.tenant_id) then
    raise exception 'NO_CONNECTOR: %', p_connector;
  end if;
  -- Envelope v1 (modules/integration/crypto.ts): 0x01 | 12-byte IV | 16-byte tag | ciphertext.
  if p_ciphertext is null or length(p_ciphertext) < 30 or get_byte(p_ciphertext, 0) <> 1 then
    raise exception 'NOT_ENCRYPTED: secrets must be sealed with the v1 envelope before they reach the database';
  end if;
  if coalesce(p_key_id, '') = '' then
    raise exception 'MISSING_FIELD: key_id is required';
  end if;
  insert into integration.connector_secret (connector_id, tenant_id, ciphertext, key_id, updated_by)
  values (p_connector, m.tenant_id, p_ciphertext, p_key_id, v_actor)
  on conflict (connector_id) do update
     set ciphertext = excluded.ciphertext, key_id = excluded.key_id,
         updated_by = excluded.updated_by, updated_at = now();
  perform audit.append(m.tenant_id, 'user', v_actor, 'connector.secret_set', 'connector', p_connector,
                       jsonb_build_object('key_id', p_key_id, 'bytes', length(p_ciphertext)));
end $$;

-- 2. Jobs -----------------------------------------------------------------------------------
-- A person asks for a sync of one scope now (e.g. re-pull yesterday). Not deduplicated: the
-- sync itself is repeat-safe.
create or replace function integration.request_sync(p_connector uuid, p_scope text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := integration._require_member();
  c integration.connector;
  v_id uuid;
begin
  if not app.has_role('owner', 'controller', 'bookkeeper') then
    raise exception 'ROLE_FORBIDDEN: only an owner, controller or bookkeeper can request a sync';
  end if;
  select * into c from integration.connector where id = p_connector and tenant_id = m.tenant_id;
  if not found then raise exception 'NO_CONNECTOR: %', p_connector; end if;
  if c.status <> 'active' then raise exception 'CONNECTOR_INACTIVE: connector is %', c.status; end if;
  if coalesce(p_scope, '') = '' then raise exception 'MISSING_FIELD: scope is required'; end if;
  insert into integration.job (tenant_id, kind, connector_id, run_as, payload)
  values (m.tenant_id, 'connector_sync', c.id, c.run_as,
          jsonb_build_object('scope', p_scope, 'requested_by', app.current_principal()))
  returning id into v_id;
  return v_id;
end $$;

-- Nightly: one sync job per active connector per day. The dedupe key makes re-running the
-- scheduler harmless.
create or replace function integration.enqueue_due_syncs(p_day date) returns int
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare n int;
begin
  insert into integration.job (tenant_id, kind, connector_id, run_as, payload, dedupe_key)
  select c.tenant_id, 'connector_sync', c.id, c.run_as, jsonb_build_object('scope', p_day::text),
         'sync:' || c.id || ':' || p_day
    from integration.connector c
   where c.status = 'active'
  on conflict (tenant_id, dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Records a failed attempt and either requeues the job with backoff or stops it for good.
create or replace function integration._record_failure(
  j integration.job, p_outcome text, p_error text, p_retry_in_seconds int
) returns integration.job
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_delay int := coalesce(p_retry_in_seconds, least(3600, 30 * (2 ^ greatest(j.attempts - 1, 0))::int));
  r integration.job;
begin
  insert into integration.job_attempt (job_id, tenant_id, attempt_no, worker, started_at, outcome, error)
  values (j.id, j.tenant_id, j.attempts, j.locked_by, coalesce(j.attempt_started_at, now()),
          p_outcome, left(p_error, 4000));
  if j.attempts >= j.max_attempts then
    update integration.job
       set status = 'dead', locked_by = null, locked_until = null, finished_at = now(),
           last_error = left(p_error, 4000)
     where id = j.id returning * into r;
  else
    update integration.job
       set status = 'queued', locked_by = null, locked_until = null,
           run_after = now() + make_interval(secs => greatest(v_delay, 0)), last_error = left(p_error, 4000)
     where id = j.id returning * into r;
  end if;
  return r;
end $$;

-- Claims the next ready job (skipping ones other workers hold). Jobs whose worker stopped
-- responding (lease expired) are first counted as failed attempts.
drop function if exists integration.claim_job(text, int);
create or replace function integration.claim_job(p_worker text, p_lease_seconds int default 300)
returns table (job_id uuid, tenant_id uuid, kind text, connector_id uuid, connector_kind text,
               connector_config jsonb, entity_id uuid, payload jsonb, attempt int,
               run_as uuid, run_as_auth_user uuid, locked_until timestamptz)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  j integration.job;
begin
  if coalesce(p_worker, '') = '' or p_lease_seconds not between 5 and 3600 then
    raise exception 'BAD_ARGUMENT: worker id required; lease between 5 and 3600 seconds';
  end if;
  for j in select * from integration.job x
            where x.status = 'running' and x.locked_until < now()
            for update skip locked loop
    perform integration._record_failure(j, 'lease_expired',
      format('LEASE_EXPIRED: worker %s stopped responding during attempt %s', j.locked_by, j.attempts), null);
  end loop;

  select x.* into j from integration.job x
    left join integration.connector c on c.id = x.connector_id
   where x.status = 'queued' and x.run_after <= now()
     and (x.connector_id is null or c.status = 'active')
   order by x.run_after, x.created_at
   limit 1
   for update of x skip locked;
  if not found then return; end if;

  update integration.job x
     set status = 'running', attempts = x.attempts + 1, locked_by = p_worker, attempt_started_at = now(),
         locked_until = now() + make_interval(secs => p_lease_seconds)
   where x.id = j.id returning * into j;

  return query
    select j.id, j.tenant_id, j.kind, j.connector_id, c.kind, c.config, c.entity_id, j.payload, j.attempts,
           j.run_as, pr.auth_user_id, j.locked_until
      from public.principal pr
      left join integration.connector c on c.id = j.connector_id
     where pr.id = j.run_as;
end $$;

-- The caller must still hold an unexpired lease on a running job.
create or replace function integration._held_job(p_job uuid, p_worker text) returns integration.job
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare j integration.job;
begin
  select * into j from integration.job where id = p_job for update;
  if not found then raise exception 'NO_JOB: %', p_job; end if;
  if j.status <> 'running' or j.locked_by is distinct from p_worker or j.locked_until < now() then
    raise exception 'LEASE_LOST: job % is not held by worker % (status %, holder %)', p_job, p_worker, j.status, j.locked_by;
  end if;
  return j;
end $$;

create or replace function integration.heartbeat_job(p_job uuid, p_worker text, p_lease_seconds int default 300) returns timestamptz
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare j integration.job := integration._held_job(p_job, p_worker);
        v_until timestamptz := now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 3600));
begin
  update integration.job set locked_until = v_until where id = j.id;
  update integration.sync_run set lease_until = v_until where job_id = j.id and status = 'running';
  return v_until;
end $$;

create or replace function integration.complete_job(p_job uuid, p_worker text, p_result jsonb default '{}') returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare j integration.job := integration._held_job(p_job, p_worker);
begin
  insert into integration.job_attempt (job_id, tenant_id, attempt_no, worker, started_at, outcome)
  values (j.id, j.tenant_id, j.attempts, p_worker, coalesce(j.attempt_started_at, now()), 'succeeded');
  update integration.job
     set status = 'succeeded', locked_by = null, locked_until = null, finished_at = now(),
         result = coalesce(p_result, '{}'), last_error = null
   where id = j.id;
end $$;

create or replace function integration.fail_job(p_job uuid, p_worker text, p_error text, p_retry_in_seconds int default null)
returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare j integration.job := integration._held_job(p_job, p_worker);
begin
  if coalesce(p_error, '') = '' then raise exception 'MISSING_FIELD: an error message is required'; end if;
  return (integration._record_failure(j, 'failed', p_error, p_retry_in_seconds)).status;
end $$;

-- The only way to read a credential: the worker holding the job's lease, for that job's connector.
create or replace function integration.read_secret(p_job uuid, p_worker text)
returns table (connector_id uuid, ciphertext bytea, key_id text)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare j integration.job := integration._held_job(p_job, p_worker);
begin
  return query select s.connector_id, s.ciphertext, s.key_id
                 from integration.connector_secret s
                where s.connector_id = j.connector_id and s.tenant_id = j.tenant_id;
end $$;

-- 3. Sync runs ------------------------------------------------------------------------------
-- The connector's own integration principal (or an owner/controller) runs a sync.
create or replace function integration._sync_connector(p_connector uuid) returns integration.connector
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := integration._require_member();
  c integration.connector;
begin
  select * into c from integration.connector where id = p_connector and tenant_id = m.tenant_id;
  if not found then raise exception 'NO_CONNECTOR: %', p_connector; end if;
  if app.current_principal() is distinct from c.run_as and not app.has_role('owner', 'controller') then
    raise exception 'ROLE_FORBIDDEN: only the connector''s integration principal or an owner/controller can run its sync';
  end if;
  return c;
end $$;

create or replace function integration.start_sync_run(
  p_connector uuid, p_scope text, p_job uuid default null, p_lease_seconds int default 300
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  c integration.connector := integration._sync_connector(p_connector);
  v_id uuid;
begin
  if c.status <> 'active' then raise exception 'CONNECTOR_INACTIVE: connector is %', c.status; end if;
  if coalesce(p_scope, '') = '' then raise exception 'MISSING_FIELD: scope is required'; end if;
  if p_job is not null and not exists (select 1 from integration.job where id = p_job and tenant_id = c.tenant_id
                                          and connector_id = c.id and status = 'running') then
    raise exception 'NO_JOB: % is not a running job of this connector', p_job;
  end if;
  -- A run whose worker vanished (lease passed) no longer blocks the scope.
  update integration.sync_run set status = 'abandoned', finished_at = now()
   where connector_id = c.id and scope_key = p_scope and status = 'running' and lease_until < now();
  begin
    insert into integration.sync_run (tenant_id, connector_id, scope_key, job_id, lease_until)
    values (c.tenant_id, c.id, p_scope, p_job, now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 3600)))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'SYNC_RUNNING: connector % is already syncing scope %', c.id, p_scope;
  end;
  return v_id;
end $$;

create or replace function integration.finish_sync_run(p_run uuid, p_status text, p_stats jsonb default '{}', p_error text default null)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  r integration.sync_run;
  c integration.connector;
begin
  select * into r from integration.sync_run where id = p_run for update;
  if not found then raise exception 'NO_SYNC_RUN: %', p_run; end if;
  c := integration._sync_connector(r.connector_id);
  if r.status <> 'running' then raise exception 'SYNC_FINISHED: run % is already %', p_run, r.status; end if;
  if p_status not in ('succeeded', 'failed') then raise exception 'BAD_STATUS: %', p_status; end if;
  update integration.sync_run
     set status = p_status, finished_at = now(), stats = coalesce(p_stats, '{}'), error = p_error
   where id = p_run;
end $$;

-- 4. Evidence -------------------------------------------------------------------------------
-- Records a file already written to object-locked storage. Same bytes (SHA-256) in the same
-- tenant always resolve to the same source document, so a re-run never duplicates evidence.
create or replace function integration.min_retention() returns interval
language sql immutable set search_path = pg_catalog as $$ select interval '7 years' $$;

create or replace function integration.register_evidence(p jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m        public.membership := integration._require_member();
  v_sha    bytea;
  v_doc    uuid;
  v_until  timestamptz := (p->>'retain_until')::timestamptz;
begin
  if not app.has_role('owner', 'controller', 'bookkeeper', 'manager', 'service') then
    raise exception 'ROLE_FORBIDDEN: viewers cannot add evidence';
  end if;
  if coalesce(p->>'sha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'BAD_SHA256: sha256 must be 64 lowercase hex characters';
  end if;
  if coalesce(p->>'doc_type', '') = '' or coalesce(p->>'bucket', '') = '' or coalesce(p->>'object_key', '') = ''
     or coalesce(p->>'content_type', '') = '' or (p->>'size_bytes') is null or v_until is null then
    raise exception 'MISSING_FIELD: doc_type, sha256, size_bytes, content_type, bucket, object_key and retain_until are required';
  end if;
  if v_until < now() + integration.min_retention() then
    raise exception 'RETENTION_TOO_SHORT: evidence must be locked until at least %', (now() + integration.min_retention())::date;
  end if;
  v_sha := decode(p->>'sha256', 'hex');

  perform pg_advisory_xact_lock(hashtextextended('evidence:' || m.tenant_id || ':' || (p->>'sha256'), 0));
  select source_document_id into v_doc from integration.evidence_object
   where tenant_id = m.tenant_id and sha256 = v_sha;
  if found then
    return jsonb_build_object('source_document_id', v_doc, 'existed', true);
  end if;

  insert into source_document (tenant_id, doc_type, storage_uri, sha256, extracted)
  values (m.tenant_id, p->>'doc_type',
          format('%s://%s/%s', p->>'backend', p->>'bucket', p->>'object_key')
            || coalesce('?versionId=' || (p->>'version_id'), ''),
          v_sha, p->'extracted')
  returning id into v_doc;
  insert into integration.evidence_object (tenant_id, source_document_id, sha256, size_bytes, content_type,
                                           backend, bucket, object_key, version_id, retain_until)
  values (m.tenant_id, v_doc, v_sha, (p->>'size_bytes')::bigint, p->>'content_type',
          coalesce(p->>'backend', 's3'), p->>'bucket', p->>'object_key', p->>'version_id', v_until);
  return jsonb_build_object('source_document_id', v_doc, 'existed', false);
end $$;
