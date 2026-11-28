-- Phase 1 step 1.2: agent runtime (L1). Agents propose; people approve.
--
-- People (owner/controller):  create_agent, set_agent_tools, set_agent_policy, set_agent_enabled
-- The agent's own session:    start_run, finish_run, log_model_call, authorize_tool
-- Enforced inside ledger.propose_entry for agent callers: agents._check_proposal
-- Recorded automatically:     agent_correction (trigger on draft decisions; corrects_draft_id)

-- Upgrade path, as in 50_integration.sql: hand any function created by the migration login over.
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'agents'::regnamespace and p.proowner <> 'ledger_owner'::regrole loop
    execute format('alter function %s owner to ledger_owner', f);
  end loop;
end $$;

set role ledger_owner;

-- The tools an agent can be given. Nothing that changes the chart of accounts, policies, users
-- or permissions is a tool, so no allow-list can grant it.
create or replace function agents.known_tools() returns text[]
language sql immutable set search_path = pg_catalog as $$
  select array['read_accounts', 'read_locations', 'read_entries', 'read_evidence', 'propose_entry']
$$;

-- A person with authority over agents: owner or controller, never an agent or integration.
create or replace function agents._require_admin() returns public.membership
language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare m public.membership := app.current_member();
begin
  if m.tenant_id is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  if not app.has_role('owner', 'controller')
     or (select kind from principal where id = app.current_principal()) is distinct from 'user' then
    raise exception 'ROLE_FORBIDDEN: only an owner or controller (a person) can manage agents';
  end if;
  return m;
end $$;

create or replace function agents._agent_of_tenant(p_agent uuid, p_tenant uuid, p_lock boolean default false) returns agents.agent
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare a agents.agent;
begin
  if p_lock then
    select * into a from agents.agent where id = p_agent and tenant_id = p_tenant for update;
  else
    select * into a from agents.agent where id = p_agent and tenant_id = p_tenant;
  end if;
  if not found then raise exception 'NO_AGENT: %', p_agent; end if;
  return a;
end $$;

-- 1. Managing agents (people) -----------------------------------------------------------------
create or replace function agents.create_agent(p jsonb) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := agents._require_admin();
  v_principal uuid := (p->>'principal_id')::uuid;
  v_id uuid;
begin
  if v_principal is null or coalesce(p->>'name', '') = '' or coalesce(p->>'kind', '') = '' then
    raise exception 'MISSING_FIELD: principal_id, name and kind are required';
  end if;
  if not exists (select 1 from principal pr join membership ms on ms.user_id = pr.auth_user_id and ms.tenant_id = pr.tenant_id
                  where pr.id = v_principal and pr.tenant_id = m.tenant_id and pr.kind = 'agent'
                    and ms.role = 'service' and ms.active) then
    raise exception 'BAD_PRINCIPAL: an agent must be an agent principal of this tenant with an active service login';
  end if;
  insert into agents.agent (tenant_id, principal_id, name, kind, version, model, created_by)
  values (m.tenant_id, v_principal, p->>'name', p->>'kind', coalesce(p->>'version', 'v1'),
          coalesce(p->>'model', 'claude-opus-5-5'), app.current_principal())
  returning id into v_id;
  perform audit.append(m.tenant_id, 'user', app.current_principal(), 'agent.create', 'agent', v_id,
                       p - 'principal_id' || jsonb_build_object('principal_id', v_principal));
  return v_id;
end $$;

create or replace function agents.set_agent_tools(p_agent uuid, p_tools text[]) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := agents._require_admin();
  a agents.agent := agents._agent_of_tenant(p_agent, m.tenant_id, true);
  v_bad text[];
begin
  select coalesce(array_agg(t), '{}') into v_bad from unnest(coalesce(p_tools, '{}')) t where t <> all (agents.known_tools());
  if cardinality(v_bad) > 0 then
    raise exception 'UNKNOWN_TOOL: % (known tools: %)', v_bad, agents.known_tools();
  end if;
  delete from agents.agent_tool where agent_id = a.id;
  insert into agents.agent_tool (agent_id, tenant_id, tool)
  select distinct a.id, a.tenant_id, t from unnest(coalesce(p_tools, '{}')) t;
  perform audit.append(m.tenant_id, 'user', app.current_principal(), 'agent.tools', 'agent', a.id,
                       jsonb_build_object('tools', to_jsonb(coalesce(p_tools, '{}'))));
end $$;

-- A policy list: absent or JSON null = no restriction; otherwise an array of non-null strings.
-- Anything else is refused, so a malformed list can never widen a policy by turning into NULL.
create or replace function agents._policy_list(p jsonb, k text) returns text[]
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if not p ? k or jsonb_typeof(p->k) = 'null' then return null; end if;
  if jsonb_typeof(p->k) <> 'array' then
    raise exception 'BAD_POLICY: % must be a list', k;
  end if;
  if exists (select 1 from jsonb_array_elements(p->k) e where jsonb_typeof(e) <> 'string') then
    raise exception 'BAD_POLICY: % may contain only non-empty ids or names', k;
  end if;
  return array(select jsonb_array_elements_text(p->k));
end $$;

create or replace function agents.set_agent_policy(p_agent uuid, p jsonb) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := agents._require_admin();
  a agents.agent := agents._agent_of_tenant(p_agent, m.tenant_id, true);
  v_accounts  uuid[] := agents._policy_list(p, 'allowed_account_ids')::uuid[];
  v_locations uuid[] := agents._policy_list(p, 'allowed_location_ids')::uuid[];
  v_vendors   uuid[] := agents._policy_list(p, 'allowed_vendor_ids')::uuid[];
  v_sources   text[] := agents._policy_list(p, 'allowed_source_types');
begin
  if (p->>'max_amount') is null or (p->>'min_confidence') is null or v_sources is null then
    raise exception 'MISSING_FIELD: max_amount, min_confidence and allowed_source_types are required';
  end if;
  if exists (select 1 from unnest(coalesce(v_accounts, '{}')) x
              where not exists (select 1 from account where id = x and tenant_id = m.tenant_id)) then
    raise exception 'UNKNOWN_ACCOUNT: a policy account is not in your tenant';
  end if;
  if exists (select 1 from unnest(coalesce(v_locations, '{}')) x
              where not exists (select 1 from location where id = x and tenant_id = m.tenant_id)) then
    raise exception 'UNKNOWN_LOCATION: a policy location is not in your tenant';
  end if;
  if exists (select 1 from unnest(v_sources) s where s in ('reversal', 'intercompany', 'opening')) then
    raise exception 'BAD_SOURCE_TYPE: agents cannot propose reversals, intercompany pairs or opening entries';
  end if;
  insert into agents.agent_policy (agent_id, tenant_id, max_amount, allowed_account_ids, allowed_location_ids,
                                   allowed_source_types, allowed_vendor_ids, min_confidence, updated_by)
  values (a.id, a.tenant_id, (p->>'max_amount')::numeric, v_accounts, v_locations, v_sources, v_vendors,
          (p->>'min_confidence')::numeric, app.current_principal())
  on conflict (agent_id) do update
     set max_amount = excluded.max_amount, allowed_account_ids = excluded.allowed_account_ids,
         allowed_location_ids = excluded.allowed_location_ids, allowed_source_types = excluded.allowed_source_types,
         allowed_vendor_ids = excluded.allowed_vendor_ids, min_confidence = excluded.min_confidence,
         updated_by = excluded.updated_by, updated_at = now();
  perform audit.append(m.tenant_id, 'user', app.current_principal(), 'agent.policy', 'agent', a.id, p);
end $$;

-- The kill switch. Proposals, tool calls and new runs check `enabled` under a share lock on the
-- agent row, so once this commits no further proposal from the agent is accepted.
create or replace function agents.set_agent_enabled(p_agent uuid, p_enabled boolean, p_reason text) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := agents._require_admin();
  a agents.agent := agents._agent_of_tenant(p_agent, m.tenant_id, true);
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'MISSING_FIELD: a reason is required'; end if;
  update agents.agent set enabled = p_enabled where id = a.id;
  perform audit.append(m.tenant_id, 'user', app.current_principal(),
                       case when p_enabled then 'agent.enable' else 'agent.kill' end, 'agent', a.id,
                       jsonb_build_object('reason', p_reason, 'was_enabled', a.enabled));
end $$;

-- 2. The agent's own session -------------------------------------------------------------------
-- The calling agent, share-locked so the kill switch can't change underneath a proposal.
create or replace function agents._self(p_require_enabled boolean default true) returns agents.agent
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  m public.membership := app.current_member();
  a agents.agent;
begin
  if m.tenant_id is null then
    raise exception 'NOT_AUTHENTICATED: no verified, MFA-complete membership for this session';
  end if;
  select * into a from agents.agent where tenant_id = m.tenant_id and principal_id = app.current_principal() for share;
  if not found then raise exception 'NOT_AN_AGENT: this session is not a registered agent'; end if;
  if p_require_enabled and not a.enabled then
    raise exception 'AGENT_DISABLED: agent % is switched off', a.name;
  end if;
  return a;
end $$;

create or replace function agents._own_run(a agents.agent, p_run uuid) returns agents.agent_run
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare r agents.agent_run;
begin
  select * into r from agents.agent_run where id = p_run and agent_id = a.id;
  if not found then raise exception 'NO_RUN: run % is not one of this agent''s runs', p_run; end if;
  if r.status <> 'running' then raise exception 'RUN_FINISHED: run % is %', p_run, r.status; end if;
  return r;
end $$;

create or replace function agents.start_run(p_purpose text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  a agents.agent := agents._self();
  v_id uuid;
begin
  if coalesce(trim(p_purpose), '') = '' then raise exception 'MISSING_FIELD: a run needs a purpose'; end if;
  insert into agents.agent_run (tenant_id, agent_id, purpose) values (a.tenant_id, a.id, p_purpose) returning id into v_id;
  return v_id;
end $$;

create or replace function agents.finish_run(p_run uuid, p_status text, p_stats jsonb default '{}', p_error text default null)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  a agents.agent := agents._self(false);   -- a switched-off agent still closes its run
  r agents.agent_run := agents._own_run(a, p_run);
begin
  if p_status not in ('succeeded', 'failed', 'refused', 'stopped') then raise exception 'BAD_STATUS: %', p_status; end if;
  update agents.agent_run set status = p_status, finished_at = now(), stats = coalesce(p_stats, '{}'), error = p_error
   where id = r.id;
end $$;

-- Every model call, successful or not. The prompt hash is computed here from the request body.
create or replace function agents.log_model_call(p_run uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  a agents.agent := agents._self(false);   -- logging never stops, even after the kill switch
  r agents.agent_run := agents._own_run(a, p_run);
  v_turn int;
  v_id uuid;
begin
  if p->'request' is null or coalesce(p->>'model', '') = '' then
    raise exception 'MISSING_FIELD: model and request are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agent_run:' || r.id, 0));
  select coalesce(max(turn), 0) + 1 into v_turn from agents.model_call where run_id = r.id;
  insert into agents.model_call (tenant_id, agent_id, run_id, turn, model, model_version, prompt_hash, input_refs,
                                 output, stop_reason, status, error, input_tokens, output_tokens,
                                 cache_read_tokens, cache_write_tokens, cost_usd, latency_ms)
  values (a.tenant_id, a.id, r.id, v_turn, p->>'model', p->>'model_version',
          sha256(convert_to((p->'request')::text, 'UTF8')), coalesce(p->'input_refs', '[]'),
          p->'output', p->>'stop_reason', coalesce(p->>'status', 'ok'), p->>'error',
          coalesce((p->>'input_tokens')::bigint, 0), coalesce((p->>'output_tokens')::bigint, 0),
          coalesce((p->>'cache_read_tokens')::bigint, 0), coalesce((p->>'cache_write_tokens')::bigint, 0),
          coalesce((p->>'cost_usd')::numeric, 0), (p->>'latency_ms')::int)
  returning id into v_id;
  return v_id;
end $$;

-- Asked before every tool call; recorded whether allowed or refused.
create or replace function agents.authorize_tool(p_run uuid, p_tool text, p_input jsonb, p_model_call uuid default null)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  a agents.agent := agents._self(false);
  r agents.agent_run := agents._own_run(a, p_run);
  v_refusal text;
begin
  if p_model_call is not null and not exists (select 1 from agents.model_call where id = p_model_call and run_id = r.id) then
    raise exception 'MODEL_CALL_MISSING: % is not a model call of this run', p_model_call;
  end if;
  if not a.enabled then
    v_refusal := 'AGENT_DISABLED';
  elsif not exists (select 1 from agents.agent_tool where agent_id = a.id and tool = p_tool) then
    v_refusal := 'TOOL_NOT_ALLOWED';
  end if;
  insert into agents.tool_call (tenant_id, run_id, model_call_id, tool, input_hash, allowed, refusal)
  values (a.tenant_id, r.id, p_model_call, left(coalesce(p_tool, ''), 200),
          sha256(convert_to(coalesce(p_input, 'null'::jsonb)::text, 'UTF8')), v_refusal is null, v_refusal);
  return jsonb_build_object('allowed', v_refusal is null, 'refusal', v_refusal);
end $$;

-- 3. Proposal checks (called by ledger.propose_entry when the caller is an agent) ---------------
create or replace function agents._check_proposal(p jsonb, p_total numeric) returns agents.agent_proposal
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  a    agents.agent := agents._self();          -- AGENT_DISABLED once the kill switch is on
  pol  agents.agent_policy;
  meta jsonb := p->'agent';
  r    agents.agent_run;
  v_mc uuid;
  v_conf numeric;
  out  agents.agent_proposal;
begin
  if not exists (select 1 from agents.agent_tool where agent_id = a.id and tool = 'propose_entry') then
    raise exception 'TOOL_NOT_ALLOWED: propose_entry is not on this agent''s allow-list';
  end if;
  if jsonb_typeof(meta) is distinct from 'object' or meta->>'run_id' is null or meta->>'model_call_id' is null then
    raise exception 'MISSING_AGENT_META: an agent proposal carries agent.run_id, agent.model_call_id and agent.confidence';
  end if;
  r := agents._own_run(a, (meta->>'run_id')::uuid);
  v_mc := (meta->>'model_call_id')::uuid;
  if not exists (select 1 from agents.model_call where id = v_mc and run_id = r.id and status = 'ok') then
    raise exception 'MODEL_CALL_MISSING: a proposal must cite a logged, successful model call of its own run';
  end if;
  begin
    v_conf := (meta->>'confidence')::numeric;
  exception when others then
    v_conf := null;
  end;
  if v_conf is null or v_conf < 0 or v_conf > 1 then
    raise exception 'BAD_CONFIDENCE: agent.confidence must be a number from 0 to 1';
  end if;

  select * into pol from agents.agent_policy where agent_id = a.id;
  if not found then raise exception 'NO_POLICY: agent % has no policy; agents may propose nothing without one', a.name; end if;
  if v_conf < pol.min_confidence then
    raise exception 'POLICY_CONFIDENCE: confidence % is below the policy minimum %', v_conf, pol.min_confidence;
  end if;
  if p_total > pol.max_amount then
    raise exception 'POLICY_AMOUNT: proposal total % exceeds the agent limit %', p_total, pol.max_amount;
  end if;
  if not coalesce(p->>'source_type' = any (pol.allowed_source_types), false) then
    raise exception 'POLICY_SOURCE_TYPE: % is not a source type this agent may propose', p->>'source_type';
  end if;
  if pol.allowed_account_ids is not null and exists (
       select 1 from jsonb_array_elements(p->'lines') l where not coalesce((l->>'account_id')::uuid = any (pol.allowed_account_ids), false)) then
    raise exception 'POLICY_ACCOUNT: a line uses an account this agent may not propose to';
  end if;
  if pol.allowed_location_ids is not null and exists (
       select 1 from jsonb_array_elements(p->'lines') l where not coalesce((l->>'location_id')::uuid = any (pol.allowed_location_ids), false)) then
    raise exception 'POLICY_LOCATION: a line uses a location this agent may not propose for';
  end if;
  if pol.allowed_vendor_ids is not null and p->>'vendor_id' is not null
     and not coalesce((p->>'vendor_id')::uuid = any (pol.allowed_vendor_ids), false) then
    raise exception 'POLICY_VENDOR: vendor % is outside this agent''s policy', p->>'vendor_id';
  end if;

  out.tenant_id := a.tenant_id;
  out.agent_id := a.id;
  out.run_id := r.id;
  out.model_call_id := v_mc;
  out.confidence := v_conf;
  return out;
end $$;

-- 4. Corrections -----------------------------------------------------------------------------
create or replace function agents._payload_diff(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_object('from', a->k, 'to', b->k)), '{}')
    from (select jsonb_object_keys(a) k union select jsonb_object_keys(b)) keys
   where k not in ('created_by', 'actor_type') and (a->k) is distinct from (b->k)
$$;

-- When a person decides an agent's draft, record the outcome as a labeled example.
create or replace function agents.record_decision() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  pr agents.agent_proposal;
  a  agents.agent;
begin
  if old.state <> 'pending' or new.state = 'pending' then return null; end if;
  select * into pr from agents.agent_proposal where draft_id = new.id;
  if not found then return null; end if;
  select * into a from agents.agent where id = pr.agent_id;
  -- A proposer withdrawing its own draft is not a person's judgement.
  if new.decided_by = a.principal_id then return null; end if;
  insert into agents.agent_correction (tenant_id, agent_id, agent_version, draft_id, outcome, proposed, reason, decided_by)
  values (new.tenant_id, a.id, a.version, new.id, case new.state when 'posted' then 'approved' else 'rejected' end,
          new.payload, new.reason, new.decided_by);
  return null;
end $$;

drop trigger if exists agent_decision on ledger.je_draft;
create trigger agent_decision after update on ledger.je_draft
  for each row execute function agents.record_decision();

reset role;
