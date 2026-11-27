-- Review fix (PR #1): two concurrent reversal requests could both pass request_reversal's
-- pending-draft check. One pending reversal draft per original entry, enforced by the database.
set role ledger_owner;
create unique index one_pending_reversal on ledger.je_draft ((payload->>'reverses_id'))
  where state = 'pending' and payload ? 'reverses_id';
reset role;
