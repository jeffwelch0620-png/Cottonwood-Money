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
