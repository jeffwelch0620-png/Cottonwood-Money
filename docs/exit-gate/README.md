# Phase 0 exit-gate review

Build Spec §1 lists six conditions for leaving Phase 0. Phase 1 (Toast daily sales, bank feeds, AP,
inventory counts) starts only when every one holds.

**Status (2026-11-27): five of six met; the sixth is provisionally approved by the owner, with the
formal CPA review outstanding.**

| # | Gate condition (Build Spec §1) | Status | Evidence |
|---|---|---|---|
| 1 | Every invariant I1–I7 (Product Spec §4) has a failing-case test that the DB rejects | Met | `tests/invariants.test.ts` (I1–I7), `tests/immutability.test.ts` (I4), plus the auth, period, cash and admin suites; 150 tests, run by CI on every pull request |
| 2 | 1M randomly generated entries post; trial balance nets to exactly 0.0000 for every entity | Met | [`1m-run.md`](1m-run.md): 1,000,000 entries across 10 entities, every trial balance 0.0000 on accrual and cash bases, every hash and audit chain verifies |
| 3 | Tamper test: a direct edit to any posted row (as DB superuser) is detected by the verifier | Met | `tests/tamper.test.ts`: changed amounts (even kept balanced), changed accounts, back-dating, deleted middle and tail entries, a rewritten tail with recomputed hashes, an edited audit event — each detected at the right sequence number |
| 4 | Concurrency test: 50 parallel posters on one entity produce an unbroken hash chain | Met | `tests/idempotency-concurrency.test.ts`: 50 workers on one entity, gap-free sequence, chain verifies; opposite intercompany pairs don't deadlock |
| 5 | Cash and accrual trial balances reconcile with the §10 tie-out formula | Met | `tests/cash-accrual.test.ts` (worked cases plus a 600-document property run) and the 1M run: tie-out difference 0.0000 for every entity |
| 6 | A restaurant CPA has reviewed the COA template, period-close rules and reversal policy | **Provisionally approved by the owner (2026-11-27); formal CPA review outstanding** | CPA Review Packet (Claude Doc "Restaurant Ledger — CPA Review Packet"): chart template, controls, cash-basis rules, close rules, reversal policy, 12 decisions with recommendations, sign-off table |

## Owner decisions recorded during Phase 0

| Step | Decision |
|---|---|
| 5 | People need MFA for any database access; service logins exempt. Sealing and soft-close override: owner or controller. Agents never post, even their own entries. The database trusts claims set by the app (Supabase model) |
| 6 | 52/53-week fiscal years default to "nearest"; close order is strict |
| 7 | Unapplied payments stay visible in AP/AR on the cash basis |
| 9 | Stored (materialized) balances deferred to Phase 1, built if real volumes need them |
| 10 | CPA sign-off provisionally approved by the owner pending a CPA's review |

## Closing condition 6

When a restaurant CPA reviews the packet: record their decisions on the 12 questions, build and test
any changes they request (each with a test proving the database enforces it), fill in the packet's
sign-off table, and update row 6 above to **Met** with the reviewer and date.
