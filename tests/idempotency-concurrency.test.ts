// Re-imports can't double-post; parallel posters can't fork the chain; opposite
// intercompany pairs can't deadlock.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { appClient, appPool, makeFixture, dsj, post, actAs, expectCode, count } from './helpers.js';

let db: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  db = await appClient();
  pool = appPool(50);
});
afterAll(async () => {
  await db.end();
  await pool.end();
});

const postVia = async (p: pg.Pool, e: unknown) => {
  const c = await p.connect();
  try {
    return await post(c, e);
  } finally {
    c.release();
  }
};

describe('idempotency', () => {
  it('the same key posted 100 times in parallel creates exactly one entry', async () => {
    const f = await makeFixture(db);
    const e = dsj(f, { idempotency_key: 'toast:store1:2026-11-20' });
    const results = await Promise.all(Array.from({ length: 100 }, () => postVia(pool, e)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await count(db, 'select count(*) n from ledger.journal_entry where entity_id = $1', [f.entityA])).toBe(1);
  });

  it('a key already used by another entity is a conflict, not a silent return', async () => {
    const f = await makeFixture(db);
    await post(db, dsj(f, { idempotency_key: 'k1' }));
    const onB = dsj(f, {
      entity_id: f.entityB, idempotency_key: 'k1',
      lines: [
        { account_id: f.acct.clearing, location_id: f.locB1, debit: '1' },
        { account_id: f.acct.sales, location_id: f.locB1, credit: '1' },
      ],
    });
    await expectCode(post(db, onB), 'IDEMPOTENCY_CONFLICT');
  });
});

describe('concurrency', () => {
  const SECONDS = Number(process.env.CONCURRENCY_SECONDS ?? 10);

  it(`50 workers posting to one entity for ${SECONDS}s keep an unbroken chain`, async () => {
    const f = await makeFixture(db);
    const stopAt = Date.now() + SECONDS * 1000;
    let posted = 0;
    const worker = async () => {
      while (Date.now() < stopAt) {
        await postVia(pool, dsj(f));
        posted++;
      }
    };
    await Promise.all(Array.from({ length: 50 }, worker));

    const { rows } = await db.query(
      'select count(*)::int n, max(seq)::int m from ledger.journal_entry where entity_id = $1', [f.entityA]);
    expect(rows[0].n).toBe(posted);
    expect(rows[0].m).toBe(posted); // gap-free
    const v = await db.query('select * from ledger.verify_chain($1)', [f.entityA]);
    expect(v.rows[0].ok).toBe(true);
    console.log(`concurrency: ${posted} entries in ${SECONDS}s (${Math.round(posted / SECONDS)}/s on one entity)`);
  });

  it('opposite intercompany pairs posted in parallel do not deadlock', async () => {
    const f = await makeFixture(db);
    const side = (entity: string, loc: string, dr: string, cr: string) => ({
      tenant_id: f.tenant, entity_id: entity, entry_date: '2026-11-21', idempotency_key: `ic:${randomUUID()}`,
      actor_type: 'user', created_by: f.user1, evidence_ids: [f.doc],
      lines: [
        { account_id: dr, location_id: loc, debit: '10' },
        { account_id: cr, location_id: loc, credit: '10' },
      ],
    });
    const aToB = () => ({ sides: [side(f.entityA, f.locA1, f.acct.cogs, f.acct.dueTo), side(f.entityB, f.locB1, f.acct.dueFrom, f.acct.sales)] });
    const bToA = () => ({ sides: [side(f.entityB, f.locB1, f.acct.cogs, f.acct.dueTo), side(f.entityA, f.locA1, f.acct.dueFrom, f.acct.sales)] });
    const run = async (payload: unknown) => {
      const c = await pool.connect();
      try {
        await actAs(c, f.user1);
        await c.query('select ledger.post_intercompany($1::jsonb)', [JSON.stringify(payload)]);
      } finally {
        c.release();
      }
    };
    await Promise.all(Array.from({ length: 40 }, (_, i) => run(i % 2 ? aToB() : bToA())));
    for (const e of [f.entityA, f.entityB]) {
      const v = await db.query('select * from ledger.verify_chain($1)', [e]);
      expect(v.rows[0]).toMatchObject({ ok: true, checked: '40' });
    }
  });
});
