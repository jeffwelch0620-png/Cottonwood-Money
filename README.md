# Restaurant Ledger — Phase 0 (ledger foundation)

The audit-grade core of the restaurant accounting platform. Weeks 1–6 of the Phase 0
build spec: schema, posting function, guards, hash chain, verifier (steps 1–4), then
auth, membership and row-level security (step 5), fiscal calendars and the close
workflow (step 6), payment application, cash/accrual views and reports (step 7), the admin
database layer and API (step 8a), the admin console (step 8b), and the tests that prove them.

**Design rule:** the database enforces the books, not the app. The application role
can only `EXECUTE` the posting functions; it has no INSERT/UPDATE/DELETE on ledger
tables. Even a buggy or compromised app server can't write an unbalanced, back-dated
or edited entry.

## Run it

```bash
npm install
# Postgres 14+ running locally; superuser postgres/postgres by default
PG_BASE_URL=postgres://postgres:postgres@localhost:5432 npm test
npm run typecheck

# API server (Supabase HS256 secret, or SUPABASE_JWKS_URL for asymmetric keys)
DATABASE_URL=... SUPABASE_JWT_SECRET=... npm run api

# Admin console (Next.js). API_URL is compiled into the build's /v1 proxy.
cd apps/admin && npm install && API_URL=http://localhost:3000 npm run build && npm start   # :3100
# Supabase sign-in: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY at build time.
# Without them the console offers dev sign-in with a pasted token:
SUPABASE_JWT_SECRET=... npm run dev:token -- <auth_user_id> <tenant_id>
# Demo tenant with a year of activity, plus tokens for owner/controller/bookkeeper:
DATABASE_URL=<superuser url> SUPABASE_JWT_SECRET=... npm run dev:seed
# Console end-to-end flows (fresh DB, seed, build, both servers, Playwright, cleanup):
npm run e2e:admin

# Migrate a real database
DATABASE_URL=postgres://user:pass@host:5432/db npm run migrate

# Bigger runs
PROPERTY_N=1000000 CONCURRENCY_SECONDS=60 npm test
```

The test setup drops and recreates `ledger_test` on every run, so the migrations are
proven against an empty database each time.

## Layout

```
db/migrations/   0000 roles · 0001 tenancy/COA/periods · 0002 evidence/audit · 0003 ledger · 0004 guards
                 0005 auth shim/membership/principal login · 0006 balance backstop runs as owner
                 0007 fiscal calendar settings, period position, reopen requests
                 0008 payment_application, AR source types
                 0009 JE drafts, last-owner rule, setup audit trail · 0010 cash_view fixed once posted
db/functions/    session identity (app.*) · audit chain · canonical form + hash · post_entry ·
                 reverse/intercompany · verify/manifest/seal · periods/close/reopen ·
                 cash view + reports + payment application · admin (drafts, COA template,
                 JE viewer, audit export) · RLS policies · grants
apps/api/        Fastify server: Supabase JWT → withSession(app_role) → database functions
apps/admin/      Next.js console over the API (own package); e2e/flows.cjs drives it in a browser
scripts/         dev-token · dev-seed (demo tenant) · e2e-admin.sh
db/migrate.ts    migration runner (numbered files once; functions re-applied every run)
modules/shared/  money (Decimal, never JS numbers)
modules/ledger/  TypeScript entry points + typed LedgerError codes
modules/auth/    withSession(): verified JWT claims set per transaction
modules/reporting/ trialBalance · profitAndLoss · balanceSheet · cashAccrualTieOut (Decimal totals)
tests/           invariants · immutability · idempotency/concurrency · tamper · property · module · auth-rls ·
                 periods · cash-accrual · admin · api
```

## What the database enforces

| # | Invariant | How |
|---|---|---|
| I1 | Debits = credits | Checked in `post_entry`; deferred constraint trigger re-checks at commit (even for the ledger owner) |
| I2 | Valid entity / location / account | Composite foreign keys + checks; cross-tenant ids rejected |
| I3 | Open period only | Periods move forward only (open → soft → hard → sealed); soft needs an override; sealing only via `seal_period` |
| I4 | Posted rows immutable | No grants for the app + triggers blocking UPDATE/DELETE/TRUNCATE for everyone |
| I5 | Evidence and approval | Non-manual entries cite source documents; manual/reversal/opening need a different *person* to approve; agents can never approve |
| I6 | Intercompany nets to zero | `post_intercompany` posts both sides in one transaction; IC accounts are refused anywhere else |
| I7 | Tamper evidence | Gap-free `seq` + SHA-256 hash chain per entity; `verify_chain` + daily manifest anchors |
| A1 | Tenant isolation | RLS on every tenant table, keyed on `app.current_tenant()`; CI test fails if any table lacks RLS |
| A2 | Verified identity | `app.current_tenant()` = membership matching `auth.uid()` + JWT `tenant_id`, active, and MFA (`aal2`) for people |
| A3 | Actor from session | Tenant, poster, approver and sealer come from the session, never from parameters |

## Auth model (step 5)

```
JWT (sub, tenant_id, aal) ─► app.current_member()   membership: user_id = auth.uid(), tenant = claim,
                                                     active, aal2 unless role = 'service'
                           ├► app.current_tenant()  ─► RLS on every tenant table
                           └► caller principal      ─► principal.auth_user_id = auth.uid()

post_entry:  input.tenant_id ≠ session tenant          → TENANT_MISMATCH
             allow_soft_close from non-owner/controller → SOFT_CLOSE_FORBIDDEN
             caller = creator → no approver
             caller ≠ creator → only via approve_draft of the creator's own draft
                                (otherwise CREATOR_NOT_CALLER); approver = caller
             approved_by in input ≠ caller             → APPROVER_NOT_CALLER
             caller is an agent                        → AGENT_CANNOT_POST
             line outside caller's location_ids        → LOCATION_NOT_PERMITTED
             approved total > caller's approval_limit  → APPROVAL_LIMIT
             human creator without active membership   → CREATOR_NOT_MEMBER
seal_period(period): sealer = session principal; must be a person with owner/controller role
```

## Fiscal calendars and close (step 6)

```
Entity settings (fixed once it has periods): fiscal_calendar, fy_end_month, week_end_dow, fy_week_rule
  calendar_month : FY = 12 months ending the last day of fy_end_month
  445 / 13_period: FY ends on week_end_dow nearest to (or last on/before) that day
                   → 364 or 371 days; start(Y) = end(Y-1) + 1, so years tile with no gaps
     445        4 4 5 | 4 4 5 | 4 4 5 | 4 4 5   (+1 week in period 12 in a 53-week year)
     13-period  4 × 13                          (+1 week in period 13 in a 53-week year)
  e.g. Sunday nearest Dec 31 → FY2026 = Dec 29 2025 – Jan 3 2027 (53 weeks)

Status   open → soft → hard → sealed,  and always: earlier period ≥ later period
  ledger.create_fiscal_year(entity, year)   contiguous years only (next, or prior to back-fill)
  ledger.close_period(period, soft|hard)    forward only; takes the posting lock
  ledger.seal_period(period)                earlier periods must be sealed
  ledger.request_reopen(period, open|soft, reason) → ledger.approve_reopen(request) by a different person
                                            never sealed; later periods must be ≤ target; audit event
```
Periods are written only by these functions (owner/controller, person). Direct period INSERT/UPDATE
is revoked from the app; backward moves are refused by trigger unless made inside an approved reopen.

## Cash/accrual views and reports (step 7)

```
Per entry (debit-positive):  S = settle lines, A = always lines,
  F = never lines funding S (sign opposite S), R = other never lines (e.g. sales tax payable)
  S + A + F + R = 0      G = A + F      α = A / G
  document ⇔ S ≠ 0, F ≠ 0, 0 ≤ α < 1
  entry date         A × 1,   S,R × α                       (A − α·G = 0)
  each settlement x  S,R × x/|G|,   F × x/|F|               (−x + x = 0)
  non-documents (sales, payments, depreciation): every line on its entry date
```
Every date balances by construction; rounding is cumulative per line with the residual on the
largest settle line, so a fully settled document re-dates exactly its own amounts.

| Document | Cash view |
|---|---|
| Bill 1,000 paid 600 + 400 | COGS 600 / 400 on the payment dates (spec example) |
| COD bill: 100 cash + 900 AP | 100 on the bill date, 900 on payment |
| Payroll: 700 net + 300 tax payable | 700 on payday, 300 when remitted |
| Invoice 1,000 + 80 tax → AR 1,080 | on receipt: sales 1,000 and tax liability 80 |
| Payment with discount (bank 980, discount 20) | not a document; settles the bill in full |
| Credit memo applied to a bill | nets to zero |
| Unapplied payment | stays in AP/AR on the cash basis (so the cash TB balances) |

- `ledger.apply_payment(payment, document, amount)` / `unapply_payment(application)`: insert-only;
  `settled_on` = the payment's date (derived); its period must be open (soft: owner/controller
  override); refuses over-application of the document or the payment, non-documents, non-payments,
  cross-entity links; agents and viewers refused; audit event per application.
- Reports (basis = accrual | cash, default the entity's, echoed on every row): `trial_balance`,
  `profit_and_loss` (optional location), `balance_sheet` (prior-year and current-year earnings lines),
  `cash_accrual_tieout`: NI_cash = NI_accrual − ΔWC_accrual + ΔWC_cash, where ΔWC_cash is zero when all
  cash is applied (then it is exactly the spec formula) and otherwise the unapplied-cash movement.
- Location-scoped users get their store's lines, weighted from the whole document.

## Admin layer (step 8a)

```
propose_entry (any member but viewers; agents too)  ┐
request_reversal (a person; mirror of an entry)      ┘→ je_draft (pending, immutable)
      └─ approve_draft by a different person ─→ ledger._post (every rule re-checked) → posted
      └─ reject_draft (reviewer with a reason, or the proposer withdrawing)
membership change → audit event {field: {from, to}}; last active owner can't be demoted (LAST_OWNER)
entity / location / account / principal insert or update → audit event with actor and diff
```
- `ledger.load_coa_template('usar')`: 62-account USAR-style restaurant chart with cash_view set per
  account; adds only unused numbers. Input to the CPA review.
- `ledger.entry_detail(entry)`: lines, evidence with sha256, creator/approver, `hash_ok` (recomputed
  via entry_hash) and `link_ok` (previous entry's hash), reversal links, draft, applications.
- `audit.export(from, to)`: owner/controller; events with actor names plus full-chain verification.
  The API serves JSONL or CSV with `x-audit-chain-ok` and `x-export-sha256` headers.
- `account.cash_view` is fixed once an account has postings (it would rewrite cash-basis history).
- Location scope covers writes beyond posting: payment application/unapplication, draft visibility
  and rejection, and reversal requests all require every line to be in the member's stores.
- A reversal cites exactly its original's source documents (none for manual/opening entries) and
  is refused while the original still has payment applications (`HAS_APPLICATIONS`).
- API: `/v1/me`, tenants, entities, locations, members, accounts, COA template, periods + fiscal years +
  close/seal/reopen, drafts, entries (list, viewer, post, reverse), payment applications, source
  documents, reports, chain verify, audit export. Error codes map to 400/401/403/404/409/422.

## Admin console (step 8b)

```
Browser (Next.js client) ──Bearer JWT──► /v1/* proxy ──► API ──withSession(app_role)──► Postgres
   sign-in: Supabase password + TOTP (aal2) · dev: pasted token from `npm run dev:token`
   the console holds no rules; refusals are shown with the ledger's code (APPROVAL_LIMIT, LAST_OWNER, …)
```
| Screen | What it does |
|---|---|
| Overview | Pending drafts and reopens, hash-chain status, earliest open period, latest entries |
| Approvals | Draft queue with lines and proposer; approve (own drafts disabled) or reject with a reason; reopen requests |
| Journal | Entry list (date filter, paging); viewer with hash/link checks, evidence SHA-256, people, links; reversal; new-entry form with a live Decimal balance check, submitted as a draft |
| Reports | P&L (by location), balance sheet, trial balance, cash/accrual tie-out; basis toggle printed on each |
| Periods | Fiscal years and periods; soft/hard close, seal (confirm), reopen request |
| Chart of accounts | Accounts, add, rename, deactivate, load the restaurant template |
| Entities | Entities with calendar settings, locations |
| Members | Roles, location scope, approval limits, deactivate (owner only) |
| Audit | JSONL/CSV export with chain status and file SHA-256; per-entity chain verification |

Roles: `owner` (members/principals + everything a controller can do) · `controller` (COA, periods, soft-close posting, seal) ·
`bookkeeper` / `manager` (post and approve within scope and limit) · `viewer` (read) ·
`service` (machine login for an agent or integration principal; no MFA, never approves).
Tenants are created only by `app.create_tenant()` (sign-up), which makes the caller owner.

Errors come back as `CODE: detail` (`UNBALANCED`, `PERIOD_CLOSED`, `SELF_APPROVAL`, …) and
are mapped to `LedgerError.code` in TypeScript.

## Test results (this build)

- 133 / 133 tests pass on a fresh database; TypeScript type check clean.
- Step 8a: the full admin journey (sign-up → COA template → 4-4-5 entity → member → two-person manual
  JE → reports → close → two-person reopen → audit export) runs through HTTP in one test. Mutation
  check: removing the last-owner lock lets two owners demote each other (test fails).
- Step 8b: `npm run e2e:admin` drives the console as three people on a fresh seeded tenant: own-draft
  approval disabled, APPROVAL_LIMIT shown, unbalanced form blocked (0.01 off), controller drafts →
  owner approves → viewer shows both people and a verified hash, hard close → two-person reopen,
  sealed period locked, LAST_OWNER shown, audit export intact, bookkeeper denied export, phone width
  without horizontal scroll, no page errors.
- Cash property run: 600 random documents (bills, COD, payroll, invoices with tax, credit memos),
  885 applications, 441 undone, 313 over-applications refused; every cash-view date balances, tie-out
  difference 0.0000 for each month and both together, TB and balance sheet balance on both bases.
  Mutation checks: removing the rounding plug or using the wrong weight both fail the run.
- Period suite: calendars checked for every week-based setting over 2000–2060 (336 settings × 61 years:
  all 364/371 days, all end on the week-end day, 53-week years every 5–6 years); close-vs-post race
  verified, and shown to fail if the close lock is removed.
- Step 5 throughput: ~426 posts/s on one entity with 50 workers (baseline on the same machine ~450/s;
  the per-post membership check costs ~5%).
- Property test: 50,000 random entries → 44,305 accepted, 5,695 deliberately-unbalanced entries
  rejected; trial balance debits = credits = 2,697,101,590.0700; location totals = entity totals.
- Concurrency: 50 parallel workers on one entity, ~410 posts/second, gap-free chain.
- Tamper: changed amounts, changed accounts, back-dating, deleted middle entries, deleted tail,
  and a tail rewritten with recomputed hashes are all detected at the right sequence number.

## Known gaps (scheduled, not forgotten)

| Gap | Why it's open | Closes in |
|---|---|---|
| DB trusts the `request.jwt.claims` setting | Same model as Supabase/PostgREST: the caller verifies the JWT and sets the claim. A compromised app server holding `app_role` could set any claim | Decide: verify JWT signature in-DB, or route through PostgREST |
| Supabase deploy not yet tried | Local shim stands in for `auth.users` / `auth.uid()` / `auth.jwt()`; need to confirm grants on `auth` to `ledger_owner` and the custom-claims hook that adds `tenant_id` | Before first staging deploy |
| Manifest worker needs a tenant session | `verify_chain` / `take_manifest` now check the session tenant | Run the nightly worker as a per-tenant `service` member, or add a maintenance role |
| Journal entry headers aren't location-scoped | Lines are filtered by `location_ids`; headers (memo) are tenant-wide | Phase 0 step 8 (admin console) if needed |
| Changing an entity's calendar | Settings are fixed once periods exist; switching at a year boundary needs a conversion workflow | When a customer asks |
| Tenant switching in the console | The JWT's tenant_id comes from a Supabase custom access token hook (not built); one tenant per login until then | Supabase deployment |
| Member invite by email | Members are added by Supabase user id | Supabase deployment |
| Evidence upload in the console | Drafts from the console are manual/opening; documents for other types attach via the API | Phase 1 evidence module |
| Console e2e not in `npm test` | Needs a browser and two servers; run `npm run e2e:admin` in CI as its own job | CI setup |
| Cash view is computed per request | Fine at Phase 0 volumes; spec calls for materialized balances refreshed on post | Week 10–11 tuning (1M run) |
| Applications into closed periods | A prepaid or deposit applied after its payment's period closed is refused | CPA review (week 10–11) |
| Applications aren't hash-chained | Each is in the hash-chained audit log; the verifier doesn't cross-check them yet | With the manifest worker |
| Sealing doesn't anchor externally | Seal hash is stored; optional external timestamp anchor (Product Spec) not built | With the manifest export worker |
| Manifest is stored in the DB only | Export to write-once storage + owner email is a worker job | Weeks 4–5 follow-up |
| Audit chain serializes all postings in a tenant | Fine at restaurant volumes (~400/s measured per entity) | Revisit if a tenant exceeds it |
| Reversing an intercompany pair | Needs a paired reversal function | Phase 1 |
| Exit-gate 1M-entry run | 50k run done here; 1M takes ~40 min | Week 10–11 |
