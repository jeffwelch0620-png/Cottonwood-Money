-- Security (PR #2 review): PostgreSQL grants EXECUTE on every new function to PUBLIC. Functions
-- in this system are SECURITY DEFINER helpers that must only be callable once 99_grants.sql has
-- granted them. Default privileges remove PUBLIC EXECUTE at creation for functions created by the
-- ledger owner and by the role running migrations, so a new function is closed from its first
-- moment. (Together with migrate.ts applying all function files in one transaction.)
alter default privileges for role ledger_owner revoke execute on functions from public;
alter default privileges revoke execute on functions from public;
