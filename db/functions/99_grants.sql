-- Functions are executable by PUBLIC by default in Postgres. Remove that, then grant
-- the application role exactly the entry points it needs. ledger._post is never granted.
revoke execute on all functions in schema ledger from public;
revoke execute on all functions in schema audit  from public;
revoke execute on all functions in schema app    from public;

grant execute on function ledger.post_entry(jsonb)          to app_role;
grant execute on function ledger.post_intercompany(jsonb)   to app_role;
grant execute on function ledger.request_reversal(jsonb)    to app_role;
grant execute on function ledger.verify_chain(uuid)         to app_role;
grant execute on function ledger.take_manifest(uuid)        to app_role;
grant execute on function ledger.seal_period(uuid)          to app_role;
grant execute on function ledger.create_fiscal_year(uuid, int)    to app_role;
grant execute on function ledger.close_period(uuid, text)         to app_role;
grant execute on function ledger.request_reopen(uuid, text, text) to app_role;
grant execute on function ledger.approve_reopen(uuid)             to app_role;
grant execute on function ledger.reject_reopen(uuid)              to app_role;
grant execute on function ledger.apply_payment(uuid, uuid, numeric, boolean) to app_role;
grant execute on function ledger.unapply_payment(uuid, boolean)              to app_role;
grant execute on function ledger.cash_lines(uuid)                            to app_role;
grant execute on function ledger.accrual_lines(uuid)                         to app_role;
grant execute on function ledger.trial_balance(uuid, date, date, text)       to app_role;
grant execute on function ledger.profit_and_loss(uuid, date, date, text, uuid) to app_role;
grant execute on function ledger.balance_sheet(uuid, date, text)             to app_role;
grant execute on function ledger.cash_accrual_tieout(uuid, date, date)       to app_role;
grant execute on function ledger.propose_entry(jsonb)                        to app_role;
grant execute on function ledger.approve_draft(uuid, boolean)                to app_role;
grant execute on function ledger.reject_draft(uuid, text)                    to app_role;
grant execute on function ledger.load_coa_template(text)                     to app_role;
grant execute on function ledger.entry_detail(uuid)                          to app_role;
grant execute on function audit.export(timestamptz, timestamptz)             to app_role;
grant execute on function audit.verify_chain(uuid)          to app_role;
-- Pure helper; lets external tools recompute chain starts.
grant execute on function ledger.genesis_hash(uuid)         to app_role;

-- Session helpers: used by RLS policies (which run as app_role) and at sign-up.
grant execute on function app.current_tenant()            to app_role;
grant execute on function app.current_principal()         to app_role;
grant execute on function app.has_role(text[])            to app_role;
grant execute on function app.allowed_locations()         to app_role;
grant execute on function app.create_tenant(text, text)   to app_role;

-- Integration (Phase 1 step 1.1). app_role: tenant-side calls. worker_role: queue and secrets.
revoke execute on all functions in schema integration from public;
grant execute on function integration.create_connector(jsonb)                 to app_role;
grant execute on function integration.set_connector_status(uuid, text)        to app_role;
grant execute on function integration.set_connector_secret(uuid, bytea, text) to app_role;
grant execute on function integration.request_sync(uuid, text)                to app_role;
grant execute on function integration.start_sync_run(uuid, text, uuid, int)   to app_role;
grant execute on function integration.finish_sync_run(uuid, text, jsonb, text) to app_role;
grant execute on function integration.register_evidence(jsonb)                to app_role;
grant execute on function integration.min_retention()                         to app_role, worker_role;
grant execute on function integration.enqueue_due_syncs(date)                 to worker_role;
grant execute on function integration.claim_job(text, int)                    to worker_role;
grant execute on function integration.heartbeat_job(uuid, text, int)          to worker_role;
grant execute on function integration.complete_job(uuid, text, jsonb)         to worker_role;
grant execute on function integration.fail_job(uuid, text, text, int)         to worker_role;
grant execute on function integration.read_secret(uuid, text)                 to worker_role;

-- Agents (Phase 1 step 1.2).
revoke execute on all functions in schema agents from public;
grant execute on function agents.known_tools()                          to app_role;
grant execute on function agents.create_agent(jsonb)                    to app_role;
grant execute on function agents.set_agent_tools(uuid, text[])          to app_role;
grant execute on function agents.set_agent_policy(uuid, jsonb)          to app_role;
grant execute on function agents.set_agent_enabled(uuid, boolean, text) to app_role;
grant execute on function agents.start_run(text)                        to app_role;
grant execute on function agents.finish_run(uuid, text, jsonb, text)    to app_role;
grant execute on function agents.log_model_call(uuid, jsonb)            to app_role;
grant execute on function agents.authorize_tool(uuid, text, jsonb, uuid) to app_role;
