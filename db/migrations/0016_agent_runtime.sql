-- Phase 1 step 1.2: agent runtime at autonomy level L1 (agents propose; people approve).
--   agent            : an agent identity (an `agent` principal with a service login), its model
--                      and the kill switch (enabled)
--   agent_tool       : the tool allow-list
--   agent_policy     : limits on what the agent may propose at all (deny by default)
--   agent_run        : one run of an agent; tool calls and model calls belong to a run
--   model_call       : every model call (model, version, prompt hash, inputs, output, tokens, cost)
--   tool_call        : every tool call the agent asked for, allowed or refused
--   agent_proposal   : links a draft to the run and model call that produced it
--   agent_correction : what a person did with a proposal (approved, rejected, corrected) + diff
--
-- Writes go through SECURITY DEFINER functions in db/functions/55_agents.sql.

create schema if not exists agents authorization ledger_owner;
revoke all on schema agents from public;
grant usage on schema agents to app_role;

set role ledger_owner;

-- Lets agent tables reference a draft together with its tenant.
alter table ledger.je_draft add constraint je_draft_tenant_id_key unique (tenant_id, id);

create table agents.agent (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  principal_id  uuid not null,
  name          text not null,
  kind          text not null check (kind in ('sales', 'ap', 'reconciliation', 'payroll', 'inventory', 'general')),
  version       text not null default 'v1',
  autonomy      text not null default 'L1' check (autonomy in ('L1')),   -- L2 (auto-post) is not built
  model         text not null default 'claude-opus-5-5',
  enabled       boolean not null default true,
  created_by    uuid not null,
  created_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, principal_id),
  foreign key (tenant_id, principal_id) references public.principal (tenant_id, id),
  foreign key (tenant_id, created_by)   references public.principal (tenant_id, id)
);

create table agents.agent_tool (
  agent_id   uuid not null,
  tenant_id  uuid not null,
  tool       text not null,
  primary key (agent_id, tool),
  foreign key (tenant_id, agent_id) references agents.agent (tenant_id, id)
);

create table agents.agent_policy (
  agent_id              uuid primary key,
  tenant_id             uuid not null,
  max_amount            numeric(19,4) not null check (max_amount >= 0),   -- total debits of one proposal
  allowed_account_ids   uuid[],          -- null = any account
  allowed_location_ids  uuid[],          -- null = any location
  allowed_source_types  text[] not null, -- must be listed explicitly
  allowed_vendor_ids    uuid[],          -- null = any vendor (vendors arrive in step 1.5)
  min_confidence        numeric(5,4) not null check (min_confidence between 0 and 1),
  updated_by            uuid not null,
  updated_at            timestamptz not null default now(),
  foreign key (tenant_id, agent_id)   references agents.agent (tenant_id, id),
  foreign key (tenant_id, updated_by) references public.principal (tenant_id, id)
);

create table agents.agent_run (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  agent_id     uuid not null,
  purpose      text not null,
  status       text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'refused', 'stopped')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}',
  error        text,
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents.agent (tenant_id, id),
  check ((status = 'running') = (finished_at is null))
);

create table agents.model_call (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  agent_id       uuid not null,
  run_id         uuid not null,
  turn           int not null check (turn > 0),
  model          text not null,          -- requested
  model_version  text,                   -- the model that answered (response.model)
  prompt_hash    bytea not null check (length(prompt_hash) = 32),
  input_refs     jsonb not null default '[]',   -- ids of documents/entries the prompt included
  output         jsonb,                  -- response content blocks
  stop_reason    text,
  status         text not null check (status in ('ok', 'error')),
  error          text,
  input_tokens   bigint not null default 0 check (input_tokens >= 0),
  output_tokens  bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens   bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens  bigint not null default 0 check (cache_write_tokens >= 0),
  cost_usd       numeric(19,4) not null default 0 check (cost_usd >= 0),
  latency_ms     int,
  at             timestamptz not null default now(),
  unique (tenant_id, id),
  unique (run_id, turn),
  foreign key (tenant_id, run_id)   references agents.agent_run (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents.agent (tenant_id, id),
  check ((status = 'error') = (error is not null))
);

create table agents.tool_call (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  run_id         uuid not null,
  model_call_id  uuid,
  tool           text not null,
  input_hash     bytea not null check (length(input_hash) = 32),
  allowed        boolean not null,
  refusal        text,
  at             timestamptz not null default now(),
  foreign key (tenant_id, run_id)        references agents.agent_run (tenant_id, id),
  foreign key (tenant_id, model_call_id) references agents.model_call (tenant_id, id),
  check (allowed = (refusal is null))
);

create table agents.agent_proposal (
  draft_id       uuid primary key,
  tenant_id      uuid not null,
  agent_id       uuid not null,
  run_id         uuid not null,
  model_call_id  uuid not null,
  confidence     numeric(5,4) not null check (confidence between 0 and 1),
  foreign key (tenant_id, draft_id)      references ledger.je_draft (tenant_id, id),
  foreign key (tenant_id, run_id)        references agents.agent_run (tenant_id, id),
  foreign key (tenant_id, model_call_id) references agents.model_call (tenant_id, id)
);

create table agents.agent_correction (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  agent_id            uuid not null,
  agent_version       text not null,
  draft_id            uuid not null,
  outcome             text not null check (outcome in ('approved', 'rejected', 'corrected')),
  proposed            jsonb not null,
  corrected_draft_id  uuid,
  corrected           jsonb,
  diff                jsonb,
  reason              text,
  decided_by          uuid not null,
  at                  timestamptz not null default now(),
  foreign key (tenant_id, agent_id) references agents.agent (tenant_id, id),
  foreign key (tenant_id, draft_id) references ledger.je_draft (tenant_id, id),
  check ((outcome = 'corrected') = (corrected_draft_id is not null))
);
create unique index agent_correction_once on agents.agent_correction (draft_id, outcome);

-- Logs are insert-only; agents and policies are never deleted (disable instead).
do $$
declare t text;
begin
  foreach t in array array['model_call', 'tool_call', 'agent_proposal', 'agent_correction'] loop
    execute format('create trigger %1$s_immutable before update or delete on agents.%1$I
                      for each row execute function ledger.forbid_change()', t);
  end loop;
  foreach t in array array['agent', 'agent_policy', 'agent_run'] loop
    execute format('create trigger %1$s_no_delete before delete on agents.%1$I
                      for each row execute function ledger.forbid_change()', t);
  end loop;
  foreach t in array array['agent', 'agent_tool', 'agent_policy', 'agent_run', 'model_call', 'tool_call',
                           'agent_proposal', 'agent_correction'] loop
    execute format('create trigger %1$s_no_truncate before truncate on agents.%1$I
                      for each statement execute function ledger.forbid_change()', t);
  end loop;
end $$;

reset role;

-- app_role reads its tenant's rows (RLS); every write goes through the functions.
revoke all on all tables in schema agents from public, app_role;
grant select on all tables in schema agents to app_role;
alter default privileges for role ledger_owner in schema agents revoke all on tables from public;
