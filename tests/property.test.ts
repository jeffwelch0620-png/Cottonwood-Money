// Random entries, valid and invalid, thrown at the ledger. Whatever is accepted, the
// books must balance to the cent, location totals must add up to the entity total, and
// the chain must verify. PROPERTY_N=1000000 for the exit-gate run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { randomUUID } from 'node:crypto';
import { appClient, makeFixture, dsj, post, type Fixture } from './helpers.js';

const N = Number(process.env.PROPERTY_N ?? 2000);

let db: pg.Client;
let f: Fixture;
beforeAll(async () => {
  db = await appClient();
  f = await makeFixture(db);
});
afterAll(async () => db.end());

const cents = fc.integer({ min: 1, max: 5_000_000 }).map((c) => new Decimal(c).div(100));

// 1-4 debit lines and 1-4 credit lines; the last credit is a plug so the entry balances.
const arbEntry = fc.record({
  debits: fc.array(cents, { minLength: 1, maxLength: 4 }),
  creditSplits: fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 4 }),
  acctIdx: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 8, maxLength: 8 }),
  locIdx: fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 8, maxLength: 8 }),
  day: fc.integer({ min: 1, max: 30 }),
  corrupt: fc.integer({ min: 0, max: 9 }), // 0 => knock the entry out of balance by 0.0001
});

describe(`property: ${N} random entries`, () => {
  it('accepted entries always leave the books balanced and the chain valid', async () => {
    const accts = [f.acct.cash, f.acct.clearing, f.acct.ap, f.acct.sales, f.acct.cogs];
    const locs = [f.locA1, f.locA2];
    let accepted = 0;
    let rejected = 0;

    await fc.assert(
      fc.asyncProperty(arbEntry, async (g) => {
        const total = g.debits.reduce((a, b) => a.plus(b), new Decimal(0));
        const weightSum = g.creditSplits.reduce((a, b) => a + b, 0);
        const credits: Decimal[] = [];
        let running = new Decimal(0);
        g.creditSplits.forEach((w, i) => {
          const amt = i === g.creditSplits.length - 1 ? total.minus(running) : total.mul(w).div(weightSum).toDecimalPlaces(2, Decimal.ROUND_DOWN);
          running = running.plus(amt);
          credits.push(amt);
        });
        type Line = { account_id: string; location_id: string; debit?: string; credit?: string };
        const lines: Line[] = [
          ...g.debits.map((d, i) => ({ account_id: accts[g.acctIdx[i]], location_id: locs[g.locIdx[i]], debit: d.toFixed(4) })),
          ...credits
            .filter((c) => c.gt(0))
            .map((c, i) => ({ account_id: accts[g.acctIdx[4 + i]], location_id: locs[g.locIdx[4 + i]], credit: c.toFixed(4) })),
        ];
        if (lines.length < 2) return;
        const shouldFail = g.corrupt === 0;
        if (shouldFail) lines[0] = { ...lines[0], debit: new Decimal(lines[0].debit!).plus('0.0001').toFixed(4) };

        const e = dsj(f, { entry_date: `2026-11-${String(g.day).padStart(2, '0')}`, idempotency_key: randomUUID(), lines });
        try {
          await post(db, e);
          expect(shouldFail).toBe(false);
          accepted++;
        } catch (err) {
          expect(shouldFail).toBe(true);
          expect((err as Error).message).toMatch(/^UNBALANCED/);
          rejected++;
        }
      }),
      { numRuns: N },
    );

    // Trial balance nets to exactly zero.
    const tb = await db.query(
      `select sum(debit)::text d, sum(credit)::text c, count(distinct entry_id)::int n
         from ledger.journal_line where entity_id = $1`, [f.entityA]);
    expect(tb.rows[0].d).toBe(tb.rows[0].c);
    expect(tb.rows[0].n).toBe(accepted);

    // Location totals add up to the entity total, per account.
    const byLoc = await db.query(
      `with per_loc as (
         select account_id, location_id, sum(debit - credit) bal from ledger.journal_line
          where entity_id = $1 group by account_id, location_id),
       per_ent as (
         select account_id, sum(debit - credit) bal from ledger.journal_line
          where entity_id = $1 group by account_id)
       select count(*)::int bad from per_ent e
        where e.bal <> (select sum(bal) from per_loc l where l.account_id = e.account_id)`, [f.entityA]);
    expect(byLoc.rows[0].bad).toBe(0);

    const v = await db.query('select * from ledger.verify_chain($1)', [f.entityA]);
    expect(v.rows[0].ok).toBe(true);
    console.log(`property: ${accepted} accepted, ${rejected} correctly rejected; TB debits = credits = ${tb.rows[0].d}`);
  });
});
