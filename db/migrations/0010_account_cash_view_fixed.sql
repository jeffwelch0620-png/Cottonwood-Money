-- account.cash_view decides where an account's lines land on the cash basis. Changing it after
-- the account has postings would silently rewrite historical cash reports, closed periods
-- included. Fix it once the account has any journal line (same rule as number/type/normal balance).
create or replace function account_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ACCOUNT_IMMUTABLE: accounts are never deleted; set active = false';
  end if;
  if new.id <> old.id or new.tenant_id <> old.tenant_id or new.number <> old.number
     or new.type <> old.type or new.normal_balance <> old.normal_balance
     or new.is_intercompany <> old.is_intercompany then
    raise exception 'ACCOUNT_IMMUTABLE: number, type, normal balance and intercompany flag are fixed';
  end if;
  if new.cash_view <> old.cash_view
     and exists (select 1 from ledger.journal_line where account_id = old.id) then
    raise exception 'ACCOUNT_IMMUTABLE: cash_view is fixed once the account has postings (it would rewrite cash-basis history)';
  end if;
  return new;
end $$;

-- account_guard reads journal_line to check for postings; it runs as the caller (app_role),
-- whose RLS would hide other locations' lines, so it runs as ledger_owner (owner of journal_line).
alter function account_guard() owner to ledger_owner;
alter function account_guard() security definer;
alter function account_guard() set search_path = pg_catalog, public, pg_temp;
