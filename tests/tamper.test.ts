// A superuser who disables triggers can physically change rows. These tests play that
// attacker and prove the verifier finds every kind of edit, at the right sequence number.
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import type pg from 'pg';
import { appClient, superClient, makeFixture, dsj, post, type Fixture } from './helpers.js';

let db: pg.Client;
let su: pg.Client;
let f: Fixture;
let ids: string[];

beforeAll(async () => {
  db = await appClient();
  su = await superClient();
});
afterAll(async () => {
  await db.end();
  await su.end();
});

beforeEach(async () => {
  f = await makeFixture(db);
  ids = [];
  for (let i = 0; i < 10; i++) ids.push((await post(db, dsj(f))).id);
  await db.query('select ledger.take_manifest($1)', [f.entityA]);
});

/** Runs SQL as a superuser with all triggers disabled (session_replication_role = replica). */
async function attack(sql: string, params: unknown[] = []) {
  await su.query('begin');
  await su.query('set local session_replication_role = replica');
  await su.query(sql, params);
  await su.query('commit');
}

const verify = async () => (await db.query('select * from ledger.verify_chain($1)', [f.entityA])).rows[0];

describe('the verifier detects', () => {
  it('nothing on an untouched chain', async () => {
    expect(await verify()).toMatchObject({ ok: true, checked: '10' });
  });

  it('a changed amount, even when both sides are changed to stay balanced', async () => {
    await attack(`update ledger.journal_line set debit = debit + 100 where entry_id = $1 and debit > 0`, [ids[4]]);
    await attack(`update ledger.journal_line set credit = credit + 100 where entry_id = $1 and credit > 0`, [ids[4]]);
    expect(await verify()).toMatchObject({ ok: false, first_bad_seq: '5', reason: 'CONTENT_CHANGED' });
  });

  it('a changed account on one line', async () => {
    await attack(`update ledger.journal_line set account_id = $2 where entry_id = $1 and line_no = 1`, [ids[2], f.acct.cash]);
    expect(await verify()).toMatchObject({ ok: false, first_bad_seq: '3', reason: 'CONTENT_CHANGED' });
  });

  it('a back-dated entry', async () => {
    await attack(`update ledger.journal_entry set entry_date = '2026-11-01' where id = $1`, [ids[6]]);
    expect(await verify()).toMatchObject({ ok: false, first_bad_seq: '7', reason: 'CONTENT_CHANGED' });
  });

  it('a deleted entry in the middle', async () => {
    await attack(`delete from ledger.journal_line where entry_id = $1`, [ids[3]]);
    await attack(`delete from ledger.entry_evidence where entry_id = $1`, [ids[3]]);
    await attack(`delete from ledger.journal_entry where id = $1`, [ids[3]]);
    expect(await verify()).toMatchObject({ ok: false, first_bad_seq: '4', reason: 'SEQ_GAP' });
  });

  it('a deleted tail (chain still self-consistent) via the manifest', async () => {
    await attack(`delete from ledger.journal_line where entry_id = $1`, [ids[9]]);
    await attack(`delete from ledger.entry_evidence where entry_id = $1`, [ids[9]]);
    await attack(`delete from ledger.journal_entry where id = $1`, [ids[9]]);
    expect(await verify()).toMatchObject({ ok: false, first_bad_seq: '10', reason: 'MANIFEST_MISMATCH' });
  });

  it('a rewritten tail with recomputed hashes, via the manifest', async () => {
    await attack(`update ledger.journal_line set debit = debit * 2 where entry_id = $1 and debit > 0`, [ids[9]]);
    await attack(`update ledger.journal_line set credit = credit * 2 where entry_id = $1 and credit > 0`, [ids[9]]);
    // The attacker knows the algorithm and re-hashes the edited entry.
    await attack(`update ledger.journal_entry e set hash = ledger.entry_hash(e) where id = $1`, [ids[9]]);
    expect(await verify()).toMatchObject({ ok: false, first_bad_seq: '10', reason: 'MANIFEST_MISMATCH' });
  });

  it('an edited audit event', async () => {
    await attack(`update audit.event set detail = detail || '{"x":1}' where tenant_id = $1 and seq = 3`, [f.tenant]);
    const { rows } = await db.query('select * from audit.verify_chain($1)', [f.tenant]);
    expect(rows[0]).toMatchObject({ ok: false, first_bad_seq: '3', reason: 'CONTENT_CHANGED' });
  });
});
