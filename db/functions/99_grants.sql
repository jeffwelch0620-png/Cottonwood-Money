-- Functions are executable by PUBLIC by default in Postgres. Remove that, then grant
-- the application role exactly the entry points it needs. ledger._post is never granted.
revoke execute on all functions in schema ledger from public;
revoke execute on all functions in schema audit  from public;
revoke execute on all functions in schema app    from public;

grant execute on function ledger.post_entry(jsonb)          to app_role;
grant execute on function ledger.post_intercompany(jsonb)   to app_role;
grant execute on function ledger.reverse_entry(jsonb)       to app_role;
grant execute on function ledger.verify_chain(uuid)         to app_role;
grant execute on function ledger.take_manifest(uuid)        to app_role;
grant execute on function ledger.seal_period(uuid)          to app_role;
grant execute on function ledger.create_fiscal_year(uuid, int)    to app_role;
grant execute on function ledger.close_period(uuid, text)         to app_role;
grant execute on function ledger.request_reopen(uuid, text, text) to app_role;
grant execute on function ledger.approve_reopen(uuid)             to app_role;
grant execute on function ledger.reject_reopen(uuid)              to app_role;
grant execute on function audit.verify_chain(uuid)          to app_role;
-- Pure helper; lets external tools recompute chain starts.
grant execute on function ledger.genesis_hash(uuid)         to app_role;

-- Session helpers: used by RLS policies (which run as app_role) and at sign-up.
grant execute on function app.current_tenant()            to app_role;
grant execute on function app.current_principal()         to app_role;
grant execute on function app.has_role(text[])            to app_role;
grant execute on function app.allowed_locations()         to app_role;
grant execute on function app.create_tenant(text, text)   to app_role;
