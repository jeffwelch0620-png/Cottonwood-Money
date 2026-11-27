-- Functions are executable by PUBLIC by default in Postgres. Remove that, then grant
-- the application role exactly the entry points it needs. ledger._post is never granted.
revoke execute on all functions in schema ledger from public;
revoke execute on all functions in schema audit  from public;

grant execute on function ledger.post_entry(jsonb)          to app_role;
grant execute on function ledger.post_intercompany(jsonb)   to app_role;
grant execute on function ledger.reverse_entry(jsonb)       to app_role;
grant execute on function ledger.verify_chain(uuid)         to app_role;
grant execute on function ledger.take_manifest(uuid)        to app_role;
grant execute on function ledger.seal_period(uuid, uuid)    to app_role;
grant execute on function audit.verify_chain(uuid)          to app_role;
-- Pure helper; lets external tools recompute chain starts.
grant execute on function ledger.genesis_hash(uuid)         to app_role;
