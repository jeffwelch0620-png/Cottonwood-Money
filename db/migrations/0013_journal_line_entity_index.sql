-- Tuning (step 9 bulk run): per-entity reports (accrual lines, cash view, entry shapes) filter
-- journal_line by entity_id, which had no index: every report scanned all entities' lines.
set role ledger_owner;
create index journal_line_entity_idx on ledger.journal_line (entity_id, account_id);
reset role;
