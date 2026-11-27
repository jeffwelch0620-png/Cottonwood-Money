-- The commit-time balance backstop (ledger.check_balanced, 0004) ran as the invoking role.
-- With RLS on journal_line (step 5) it would sum only the lines the session can see, and with
-- no session claims it would see none: sum() = null, "null <> 0" is not true, and the backstop
-- would silently pass. Run it as the table owner so it always sees every line of the entry.
set role ledger_owner;
alter function ledger.check_balanced() security definer;
alter function ledger.check_balanced() set search_path = pg_catalog, public, pg_temp;
reset role;
