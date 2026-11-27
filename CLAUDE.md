# CLAUDE.md — Restaurant Ledger

Read this first in every session. Product spec and decisions live in the "Restaurant
Accounting Platform — Product & Technical Spec" doc (tabs: Product Spec, Phase 0 Build Spec)
in the claude.ai project "Accounting Package". This repo is the code.

## What this is
A QuickBooks-level accounting platform for single and multi-location restaurant groups,
sold and hosted by us as multi-tenant SaaS, with AI agents doing bookkeeping labor and
audit-grade records. Generic product first; the owner's own group is configured later.

## Settled decisions (do not reopen without the owner)
- Accrual ledger; cash basis is a computed view with a per-report toggle and a per-entity default.
- Calendar months default; 4-4-5 and 13-period optional per entity.
- Native inventory + recipe costing module (counts/COGS in Phase 1, recipes in Phase 2).
- Native ACH/check bill pay in Phase 2.
- Stack: TypeScript modular monolith, PostgreSQL (Supabase), Render; S3-style object-locked evidence storage.

## Non-negotiable rules
1. The database enforces the books. App role may only EXECUTE `ledger.post_entry`,
   `post_intercompany`, `reverse_entry` (+ verify/manifest/seal). Never grant it
   INSERT/UPDATE/DELETE on `ledger.*` or `audit.*`.
2. Posted rows are never updated or deleted. Corrections are reversals (two-person approval).
3. Agents propose, never post or approve. Approvers must be principals of kind `user`.
4. Money: `Decimal` in TS, `NUMERIC(19,4)` in SQL. Never JS numbers.
5. Every hash goes through `ledger.entry_hash()` / `ledger.canonical()`; never compute a
   ledger hash anywhere else.
6. New migrations are new numbered files; never edit an applied migration.
   Function files in `db/functions` are CREATE OR REPLACE and re-applied each run.
7. Every new rule gets a test that proves the DATABASE refuses the bad case (not just the app).

## Run
```bash
npm install
PG_BASE_URL=postgres://postgres:postgres@localhost:5432 npm test   # drops/recreates ledger_test
npm run typecheck
```
Needs Postgres 14+ with btree_gist. In a fresh Linux container: `service postgresql start`,
then set the postgres password to `postgres`.

## Status (2026-11-27)
Phase 0 steps 1–5 done. Step 5: migrations 0005 (membership, principal.auth_user_id, auth
shim) and 0006 (balance backstop runs as owner, so RLS can't hide lines from it);
`db/functions/05_auth.sql` (app.current_member/tenant/principal, create_tenant) and
`90_rls.sql` (RLS on all 13 tenant tables). The three gaps are closed (tenant check,
controller-only soft close, actor from session). 77/77 tests pass; ~426 posts/s on one entity.
See README "Auth model" and "Known gaps".

Step 5 decisions (approved by owner 2026-11-27):
- People need MFA (aal2) for ANY database access; `service` logins are exempt.
- Sealing and the soft-close override: owner or controller.
- Agents cannot post even their own entries; whoever posts an agent's entry becomes its approver.
- The DB trusts claims set by the app (Supabase model), not in-DB JWT verification.

Step 6 done (2026-11-27): migration 0007 + `db/functions/70_periods.sql`. Fiscal years are
generated per entity (calendar month / 4-4-5 / 13-period, 52/53-week rule nearest or last);
close is forward-only and in date order; two-person reopen, never for sealed periods.
96/96 tests pass; ~419 posts/s. See README "Fiscal calendars and close".

## Next: Phase 0 step 7 (weeks 7–8)
payment_application, cash/accrual views, trial balance, P&L and balance sheet API;
cash/accrual suite green. Then steps 8–10 per Build Spec §10 (admin console, 1M-entry run +
CPA review, exit gate).

## Test conventions (step 5+)
- Every app_role session needs claims: `actAs(db, principalId)` in tests; `withSession()` in app code.
- `post(db, entry, as?)` acts as `as`, else the entry's approver, else its creator.
- RLS filters silently: an UPDATE from the wrong role affects 0 rows, not an error. Assert rowCount.
- Fixtures: FY2026 calendar months for both entities; entity A Jan–Sep hard, Oct soft (`f.monthsA`).
  Periods change only via ledger.close_period / seal_period / reopen functions.
- Race tests must prove the race happened (both outcomes observed), not just pass.

## Working style for this owner
Logic first, short explanations, show the math in summary form, diagrams welcome.
Keep pulling back to the current step if the conversation drifts.
