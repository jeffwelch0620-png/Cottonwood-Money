-- Immutability, balance, and privileges. Enforced by the database, so an application
-- bug or a compromised app server cannot get around them.

set role ledger_owner;

create function ledger.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'IMMUTABLE: % on %.% is not allowed; post a reversal instead',
    tg_op, tg_table_schema, tg_table_name;
end $$;

create trigger je_immutable before update or delete on ledger.journal_entry
  for each row execute function ledger.forbid_change();
create trigger je_no_truncate before truncate on ledger.journal_entry
  for each statement execute function ledger.forbid_change();

create trigger jl_immutable before update or delete on ledger.journal_line
  for each row execute function ledger.forbid_change();
create trigger jl_no_truncate before truncate on ledger.journal_line
  for each statement execute function ledger.forbid_change();

create trigger ev_immutable before update or delete on ledger.entry_evidence
  for each row execute function ledger.forbid_change();
create trigger ev_no_truncate before truncate on ledger.entry_evidence
  for each statement execute function ledger.forbid_change();

create trigger mf_immutable before update or delete on ledger.chain_manifest
  for each row execute function ledger.forbid_change();
create trigger mf_no_truncate before truncate on ledger.chain_manifest
  for each statement execute function ledger.forbid_change();

create trigger au_immutable before update or delete on audit.event
  for each row execute function ledger.forbid_change();
create trigger au_no_truncate before truncate on audit.event
  for each statement execute function ledger.forbid_change();

-- I1 backstop: checked at commit for every entry that received lines.
create function ledger.check_balanced() returns trigger language plpgsql as $$
begin
  if (select sum(debit) - sum(credit) from ledger.journal_line where entry_id = new.entry_id) <> 0 then
    raise exception 'UNBALANCED: entry % does not balance at commit', new.entry_id;
  end if;
  return null;
end $$;

create constraint trigger jl_balanced after insert on ledger.journal_line
  deferrable initially deferred
  for each row execute function ledger.check_balanced();

reset role;

-- Source documents are insert-only too.
create trigger sd_immutable before update or delete on source_document
  for each row execute function ledger.forbid_change();
create trigger sd_no_truncate before truncate on source_document
  for each statement execute function ledger.forbid_change();

-- Privileges for the application role.
grant usage on schema ledger, audit to app_role;
grant select on all tables in schema ledger to app_role;
grant select on audit.event to app_role;
revoke insert, update, delete, truncate on all tables in schema ledger from app_role;
revoke insert, update, delete, truncate on audit.event from app_role;

grant select, insert, update on tenant, principal, entity, location, account, period to app_role;
grant select, insert on source_document to app_role;
