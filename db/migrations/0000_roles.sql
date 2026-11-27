-- Cluster-level roles. Idempotent: roles are shared across databases.
--   ledger_owner : owns the ledger and audit schemas and the posting functions (NOLOGIN)
--   app_role     : what the application connects as; may only EXECUTE posting functions
do $$
begin
  if not exists (select from pg_roles where rolname = 'ledger_owner') then
    create role ledger_owner nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'app_role') then
    create role app_role nologin;
  end if;
end $$;

create extension if not exists btree_gist;

create schema if not exists ledger authorization ledger_owner;
create schema if not exists audit  authorization ledger_owner;

revoke all on schema ledger from public;
revoke all on schema audit  from public;
