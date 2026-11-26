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

## Status (2026-11-26)
Phase 0 steps 1–4 done: migrations 0000–0004, posting/reversal/intercompany functions,
hash chain + verifier + manifest + seal. 50/50 tests pass; 50k-entry property run clean;
~410 posts/s on one entity with 50 parallel writers.

## Next: Phase 0 step 5 (weeks 5–6) — auth, membership, RLS
- `membership` table (user_id, tenant_id, role, location_ids, approval_limit); Supabase Auth with MFA.
- `app.current_tenant()` from `auth.uid()` + JWT tenant claim, verified against membership.
- RLS on every tenant table + CI test that fails if any tenant table lacks RLS.
- Close the open gaps (see README "Known gaps"):
  - post_entry must check `input.tenant_id = app.current_tenant()`.
  - `allow_soft_close` only honored for the controller role.
  - `seal_period` / approvals take the actor from `auth.uid()`, not a parameter.
- Then steps 6–10 per the Phase 0 Build Spec §10 (fiscal calendars, cash/accrual views +
  reports, admin console, 1M-entry run + CPA review, exit gate).

## Working style for this owner
Logic first, short explanations, show the math in summary form, diagrams welcome.
Keep pulling back to the current step if the conversation drifts.
