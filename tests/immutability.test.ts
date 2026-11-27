// I4: posted rows can't change - not by the app, not by the ledger owner, not even by a
// superuser who leaves triggers on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { appClient, superClient, makeFixture, dsj, post, actAs, expectCode, type Fixture } from './helpers.js';

let db: pg.Client;
let su: pg.Client;
let f: Fixture;
let entryId: string;

beforeAll(async () => {
  db = await appClient();
  su = await superClient();
  f = await makeFixture(db);
  entryId = (await post(db, dsj(f))).id;
});
afterAll(async () => {
  await db.end();
  await su.end();
});

describe('as app_role', () => {
  it('has no UPDATE or DELETE on ledger tables', async () => {
    await expect(db.query(`update ledger.journal_entry set memo = 'x' where id = $1`, [entryId])).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from ledger.journal_line where entry_id = $1`, [entryId])).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from audit.event where tenant_id = $1`, [f.tenant])).rejects.toThrow(/permission denied/);
  });
});

describe('as ledger_owner and superuser', () => {
  const asOwner = async (sql: string, params: unknown[] = []) => {
    await su.query('begin');
    try {
      await su.query('set local role ledger_owner');
      await su.query(sql, params);
      await su.query('commit');
    } catch (e) {
      await su.query('rollback');
      throw e;
    }
  };

  it('UPDATE, DELETE and TRUNCATE are refused by trigger', async () => {
    await expectCode(asOwner(`update ledger.journal_line set debit = debit + 1 where entry_id = $1`, [entryId]), 'IMMUTABLE');
    await expectCode(asOwner(`delete from ledger.journal_entry where id = $1`, [entryId]), 'IMMUTABLE');
    await expectCode(asOwner(`truncate ledger.journal_line cascade`), 'IMMUTABLE');
    await expectCode(asOwner(`update audit.event set action = 'x' where tenant_id = $1`, [f.tenant]), 'IMMUTABLE');
  });

  it('a superuser with triggers on is refused too', async () => {
    await expectCode(su.query(`update ledger.journal_entry set memo = 'edited' where id = $1`, [entryId]), 'IMMUTABLE');
    await expectCode(su.query(`update source_document set storage_uri = 'x' where id = $1`, [f.doc]), 'IMMUTABLE');
  });

  it('row counts are unchanged after all the attempts', async () => {
    const { rows } = await db.query(`select count(*)::int n from ledger.journal_line where entry_id = $1`, [entryId]);
    expect(rows[0].n).toBe(2);
  });
});

describe('chart of accounts', () => {
  it('accounts are never deleted and their identity never changes', async () => {
    // app_role has no DELETE grant at all; the trigger stops even a superuser.
    await actAs(db, f.user2);
    await expect(db.query(`delete from account where id = $1`, [f.acct.cogs])).rejects.toThrow(/permission denied/);
    await expectCode(su.query(`delete from account where id = $1`, [f.acct.cogs]), 'ACCOUNT_IMMUTABLE');
    await expectCode(db.query(`update account set number = '5999' where id = $1`, [f.acct.cogs]), 'ACCOUNT_IMMUTABLE');
    await expectCode(db.query(`update account set type = 'asset' where id = $1`, [f.acct.cogs]), 'ACCOUNT_IMMUTABLE');
    await db.query(`update account set name = 'Food cost - all' where id = $1`, [f.acct.cogs]);
  });
});
