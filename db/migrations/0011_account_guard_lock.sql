-- Review fix (PR #1): the cash_view guard could race the first posting on an account. The guard
-- saw no committed lines while a post was in flight; both then committed. Taking a SHARE lock on
-- journal_line waits for in-flight inserts to commit (then the check sees them) and holds new
-- posts until this change commits. cash_view changes are rare admin actions, so the brief pause
-- on posting is acceptable.
-- CREATE OR REPLACE resets attributes, so SECURITY DEFINER (owner: ledger_owner, from 0010) and the
-- pinned search_path are restated here.
create or replace function account_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ACCOUNT_IMMUTABLE: accounts are never deleted; set active = false';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.number <> old.number
     or new.type <> old.type or new.normal_balance <> old.normal_balance
     or new.is_intercompany <> old.is_intercompany then
    raise exception 'ACCOUNT_IMMUTABLE: number, type, normal balance and intercompany flag are fixed';
  end if;
  if new.cash_view <> old.cash_view then
    lock table ledger.journal_line in share mode;
    if exists (select 1 from ledger.journal_line where account_id = old.id) then
      raise exception 'ACCOUNT_IMMUTABLE: cash_view is fixed once the account has postings (it would rewrite cash-basis history)';
    end if;
  end if;
  return new;
end $$;

-- Review fix (PR #1): ledger.create_fiscal_year locks the entity row (SELECT ... FOR UPDATE) before
-- reading calendar settings. FOR UPDATE needs UPDATE privilege on at least one column; id is
-- immutable (entity_guard), so this grants the lock and nothing else.
grant update (id) on entity to ledger_owner;
