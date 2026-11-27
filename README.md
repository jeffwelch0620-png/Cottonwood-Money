# Restaurant Ledger — Phase 0 (ledger foundation)

The audit-grade core of the restaurant accounting platform. Weeks 1–6 of the Phase 0
build spec: schema, posting function, guards, hash chain, verifier (steps 1–4), then
auth, membership and row-level security (step 5), and the tests that prove them.

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
db/functions/    session identity (app.*) · audit chain · canonical form + hash · post_entry ·
                 reverse/intercompany · verify/manifest/seal · RLS policies · grants
db/migrate.ts    migration runner (numbered files once; functions re-applied every run)
modules/shared/  money (Decimal, never JS numbers)
modules/ledger/  TypeScript entry points + typed LedgerError codes
modules/auth/    withSession(): verified JWT claims set per transaction
tests/           invariants · immutability · idempotency/concurrency · tamper · property · module · auth-rls
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
             caller = creator → no approver;  caller ≠ creator → approver = caller
             approved_by in input ≠ caller             → APPROVER_NOT_CALLER
             caller is an agent                        → AGENT_CANNOT_POST
             line outside caller's location_ids        → LOCATION_NOT_PERMITTED
             approved total > caller's approval_limit  → APPROVAL_LIMIT
             human creator without active membership   → CREATOR_NOT_MEMBER
seal_period(period): sealer = session principal; must be a person with owner/controller role
```

Roles: `owner` (members/principals + everything a controller can do) · `controller` (COA, periods, soft-close posting, seal) ·
`bookkeeper` / `manager` (post and approve within scope and limit) · `viewer` (read) ·
`service` (machine login for an agent or integration principal; no MFA, never approves).
Tenants are created only by `app.create_tenant()` (sign-up), which makes the caller owner.

Errors come back as `CODE: detail` (`UNBALANCED`, `PERIOD_CLOSED`, `SELF_APPROVAL`, …) and
are mapped to `LedgerError.code` in TypeScript.

## Test results (this build)

- 77 / 77 tests pass on a fresh database; TypeScript type check clean.
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
| Last-owner protection | An owner can deactivate the only owner membership | Step 8 |
| Manifest is stored in the DB only | Export to write-once storage + owner email is a worker job | Weeks 4–5 follow-up |
| Audit chain serializes all postings in a tenant | Fine at restaurant volumes (~400/s measured per entity) | Revisit if a tenant exceeds it |
| Reversing an intercompany pair | Needs a paired reversal function | Phase 1 |
| Exit-gate 1M-entry run | 50k run done here; 1M takes ~40 min | Week 10–11 |
