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
1. The database enforces the books. App role may only EXECUTE the ledger functions
   (`post_entry`, `post_intercompany`, `propose_entry`/`approve_draft`, `request_reversal`,
   period, payment and report functions). Never grant it INSERT/UPDATE/DELETE on `ledger.*` or `audit.*`.
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

Step 6 decisions (approved 2026-11-27): 52/53-week rule defaults to "nearest"; close order
strict (reopen later periods first).

Step 7 done (2026-11-27): migration 0008 + `db/functions/80_cash_reports.sql` +
`modules/reporting`. Cash view per spec §7 with the document math in README "Cash/accrual views";
reports take basis and echo it; tie-out to the cent. 115/115 tests; ~433 posts/s.

Step 7 decision (approved 2026-11-27): unapplied payments stay visible in AP/AR on the cash basis.

Step 8a done (2026-11-27): migrations 0009–0010, `db/functions/85_admin.sql`, `apps/api` (Fastify,
`npm run api`). Drafts with two-person approval (agents may propose), last-owner rule, audited
membership/setup changes, USAR-style COA template, JE viewer, audit export, cash_view fixed once
posted. 133/133 tests; ~430 posts/s. See README "Admin layer".

Step 8b done (2026-11-27): `apps/admin` (Next.js 16, own package) over the 8a API — overview,
approvals, journal (list, viewer, new draft, reversal), reports, periods, COA, entities, members,
audit. `npm run e2e:admin` runs all console flows in a browser on a fresh seeded tenant.
Next.js bakes API_URL (the /v1 proxy) into the build.

Step 9 (2026-11-27): CI (`.github/workflows/ci.yml`: ledger tests on Postgres 16, type checks,
console build, browser e2e). 1M-entry exit-gate run PASS (`docs/exit-gate/1m-run.md`, rerun with
`scripts/bulk-run.ts`). Tuning found by the runs: per-entry shape in apply_payment (index-friendly),
procedural basis_lines, report scope computed once (MATERIALIZED CTE), journal_line entity index
(0013). CPA review packet drafted (Claude Doc "Restaurant Ledger — CPA Review Packet"), awaiting a CPA.
Step 9 decision (approved 2026-11-27): stored (materialized) balances deferred to Phase 1, to be
built if real volumes need them (measured: cash reports ~2.2 s, accrual < 1 s at 100k entries per
entity).

Step 10 (2026-11-27): exit-gate review in `docs/exit-gate/README.md`. Gate items 1–5 met; item 6
(CPA review) provisionally approved by the owner, formal CPA review outstanding — when a CPA
responds, follow "Closing condition 6" in that file. Phase 0 is complete on that basis.

## Phase 1 (plan: "Phase 1 Build Spec" tab of the spec doc; steps 1.0–1.9, approved 2026-11-27)
Step 1.1 done (2026-11-27): migration 0015 + `db/functions/50_integration.sql` + `modules/integration`
+ `apps/worker`. Connectors (run as an integration principal), write-only AES-GCM secrets readable
only by `worker_role` holding the job lease, Postgres job queue (leases, SKIP LOCKED, 5 attempts →
dead, insert-only attempt log), repeat-safe sync runs, content-addressed evidence in S3 Object Lock
(7-year floor; an existing object's lock is extended before it is recorded), leases renewed while a
handler runs, nightly manifest export. 180/180 tests. See README "Integration base".
Step 1.0 (Supabase/Render/AWS accounts) waits on the owner; S3 is tested at the request level until then.
Pilot store (owner decision 2026-11-27): Rudd's. Runs Toast; DoorDash direct ordering is connected to
its Toast (third-party delivery flows through it); its kitchen ships bulk product to Bert's (a
location transfer, not a sale — intercompany only if they are separate entities).
Next: step 1.2 (Toast daily sales) — needs Toast API access for Rudd's (owner input).

## Test conventions (step 5+)
- Every app_role session needs claims: `actAs(db, principalId)` in tests; `withSession()` in app code.
- `post(db, entry, as?)` acts as `as`, else the entry's approver, else its creator.
- RLS filters silently: an UPDATE from the wrong role affects 0 rows, not an error. Assert rowCount.
- Fixtures: FY2026 calendar months for both entities; entity A Jan–Sep hard, Oct soft (`f.monthsA`).
  Periods change only via ledger.close_period / seal_period / reopen functions.
- Race tests must prove the race happened (both outcomes observed), not just pass.
- New tenant tables must be seeded in auth-rls.test.ts beforeAll (the isolation guard needs rows;
  integration tables via `seedIntegration`).
- Worker tests: a `pg.Pool` as the worker; queue calls `set local role worker_role`; tenant work via
  `ctx.asTenant`. Pass `retryInSeconds: () => 0` to retry at once; simulate time passing by moving
  `locked_until` / `run_after` / `lease_until` as superuser.
- API tests: `buildServer` + `app.inject` with HS256 tokens (tests/api.test.ts `as(fx, principal)`).
- Two people = two sessions: a different creator is only accepted through `approve_draft`
  (`_post`'s `p_draft`); `post()` in tests routes caller≠creator through propose → approve.
- Performance: run `BULK_N=200000 npx tsx scripts/bulk-run.ts` after changing posting or reports;
  the report's first-vs-last window rate must stay flat. Avoid `x = p OR p IS NULL` filters and
  per-row calls to app.* functions (materialize the scope once).
- Console: client components only; `useApi` keys results by path; money via lib/money (Decimal).
  Run servers with setsid and kill the process group (next-server outlives npx).

## Working style for this owner
Logic first, short explanations, show the math in summary form, diagrams welcome.
Keep pulling back to the current step if the conversation drifts.
