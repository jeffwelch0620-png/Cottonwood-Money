# Restaurant Ledger — Phase 0 (ledger foundation)

The audit-grade core of the restaurant accounting platform. Weeks 1–4 of the Phase 0
build spec: schema, posting function, guards, hash chain, verifier, and the tests
that prove them.

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
db/functions/    audit chain · canonical form + hash · post_entry · reverse/intercompany · verify/manifest/seal · grants
db/migrate.ts    migration runner (numbered files once; functions re-applied every run)
modules/shared/  money (Decimal, never JS numbers)
modules/ledger/  TypeScript entry points + typed LedgerError codes
tests/           invariants · immutability · idempotency/concurrency · tamper · property · module
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

Errors come back as `CODE: detail` (`UNBALANCED`, `PERIOD_CLOSED`, `SELF_APPROVAL`, …) and
are mapped to `LedgerError.code` in TypeScript.

## Test results (this build)

- 50 / 50 tests pass on a fresh database; TypeScript type check clean.
- Property test: 50,000 random entries → 44,305 accepted, 5,695 deliberately-unbalanced entries
  rejected; trial balance debits = credits = 2,697,101,590.0700; location totals = entity totals.
- Concurrency: 50 parallel workers on one entity, ~410 posts/second, gap-free chain.
- Tamper: changed amounts, changed accounts, back-dating, deleted middle entries, deleted tail,
  and a tail rewritten with recomputed hashes are all detected at the right sequence number.

## Known gaps (scheduled, not forgotten)

| Gap | Why it's open | Closes in |
|---|---|---|
| `post_entry` trusts the caller's `tenant_id` | Auth/membership/RLS not built yet | Weeks 5–6 (build spec §8) |
| `allow_soft_close` is a caller flag | Needs the controller-role check from membership | Weeks 5–6 |
| `seal_period` takes the actor id as a parameter | Will come from `auth.uid()` | Weeks 5–6 |
| Manifest is stored in the DB only | Export to write-once storage + owner email is a worker job | Weeks 4–5 follow-up |
| Audit chain serializes all postings in a tenant | Fine at restaurant volumes (~400/s measured per entity) | Revisit if a tenant exceeds it |
| Reversing an intercompany pair | Needs a paired reversal function | Phase 1 |
| Exit-gate 1M-entry run | 50k run done here; 1M takes ~40 min | Week 10–11 |
