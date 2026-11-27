// The TypeScript ledger module: friendly validation before the database, and typed
// errors carrying the database's codes after it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { appClient, makeFixture, dsj, type Fixture } from './helpers.js';
import { postEntry, reverseEntry, verifyChain, trialBalance, LedgerError, type PostEntryInput } from '../modules/ledger/index.js';

let db: pg.Client;
let f: Fixture;
beforeAll(async () => {
  db = await appClient();
  f = await makeFixture(db);
});
afterAll(async () => db.end());

const input = (over: Record<string, unknown> = {}) => dsj(f, over) as unknown as PostEntryInput;

describe('ledger module', () => {
  it('posts and returns seq and hash', async () => {
    const r = await postEntry(db, input());
    expect(r.seq).toBe(1);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('catches an unbalanced entry before the database', async () => {
    const bad = input({
      lines: [
        { account_id: f.acct.clearing, location_id: f.locA1, debit: '10' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '9.99' },
      ],
    });
    await expect(postEntry(db, bad)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('maps database refusals to typed LedgerError codes', async () => {
    const err = await postEntry(db, input({ entry_date: '2026-09-15' })).catch((e) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err.code).toBe('PERIOD_CLOSED');
  });

  it('reverses, verifies and reports a zero trial balance', async () => {
    const r = await postEntry(db, input());
    await reverseEntry(db, { entry_id: r.id, created_by: f.user1, approved_by: f.user2 });
    expect((await verifyChain(db, f.entityA)).ok).toBe(true);
    const tb = await trialBalance(db, f.entityA);
    const d = tb.reduce((a, r) => a + Number(r.debit), 0);
    const c = tb.reduce((a, r) => a + Number(r.credit), 0);
    expect(d).toBeCloseTo(c, 4);
  });
});
