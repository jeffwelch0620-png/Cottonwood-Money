// Reproductions of the Greptile review findings on PR #1 (each written to fail before its fix).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { appClient, superClient, makeFixture, dsj, post, actAs, authOf, expectCode, TEST_URL, type Fixture } from './helpers.js';

let db: pg.Client;
let f: Fixture;
beforeAll(async () => {
  db = await appClient();
  f = await makeFixture(db);
});
afterAll(async () => db.end());

type L = [string, string | 0, string | 0, string?];
const entry = (fx: Fixture, source: string, date: string, lines: L[], over: Record<string, unknown> = {}) =>
  post(db, dsj(fx, {
    source_type: source, entry_date: date, idempotency_key: `${source}:${randomUUID()}`,
    lines: lines.map(([account_id, d, c, loc]) => ({ account_id, location_id: loc ?? fx.locA1, debit: String(d), credit: String(c) })),
    ...over,
  }));
const apply = async (fx: Fixture, pay: string, doc: string, amt: string, as = fx.integration) => {
  await actAs(db, as);
  return (await db.query('select ledger.apply_payment($1, $2, $3) r', [pay, doc, amt])).rows[0].r;
};
async function newAccount(fx: Fixture, number: string, type: string, nb: string, cv: string) {
  await actAs(db, fx.user1);
  return (await db.query(`insert into account (tenant_id, number, name, type, normal_balance, cash_view)
    values ($1,$2,$2,$3,$4,$5) returning id`, [fx.tenant, number, type, nb, cv])).rows[0].id as string;
}

describe('review: reversed payments must not keep settling documents', () => {
  it('a payment (or document) with active applications cannot be reversed; reversed entries cannot be applied', async () => {
    const fx = await makeFixture(db);
    const bill = await entry(fx, 'ap_bill', '2026-11-03', [[fx.acct.cogs, '100', 0], [fx.acct.ap, 0, '100']]);
    const pay = await entry(fx, 'ap_payment', '2026-11-04', [[fx.acct.ap, '100', 0], [fx.acct.cash, 0, '100']]);
    const a = await apply(fx, pay.id, bill.id, '100');
    await actAs(db, fx.user2);
    const rev = (id: string) => db.query('select ledger.reverse_entry($1::jsonb)', [JSON.stringify({ entry_id: id, created_by: fx.user1, idempotency_key: randomUUID() })]);
    await expectCode(rev(pay.id), 'HAS_APPLICATIONS');
    await expectCode(rev(bill.id), 'HAS_APPLICATIONS');
    await actAs(db, fx.integration);
    await db.query('select ledger.unapply_payment($1)', [a.id]);
    await actAs(db, fx.user2);
    await rev(pay.id); // allowed once unapplied
    await expectCode(apply(fx, pay.id, bill.id, '100'), 'ENTRY_REVERSED');
  });
});

describe('review: split payments track capacity per funding account', () => {
  it('a payment clearing AP 100 and accrued 100 can settle both documents', async () => {
    const fx = await makeFixture(db);
    const accrued = await newAccount(fx, '2120', 'liability', 'C', 'never');
    const bill = await entry(fx, 'ap_bill', '2026-11-03', [[fx.acct.cogs, '100', 0], [fx.acct.ap, 0, '100']]);
    const accrual = await entry(fx, 'manual', '2026-11-03', [[fx.acct.cogs, '100', 0], [accrued, 0, '100']],
      { actor_type: 'user', created_by: fx.user1, approved_by: fx.user2, evidence_ids: [] });
    const pay = await entry(fx, 'bank', '2026-11-05', [[fx.acct.ap, '100', 0], [accrued, '100', 0], [fx.acct.cash, 0, '200']]);
    await apply(fx, pay.id, bill.id, '100');
    const r = await apply(fx, pay.id, accrual.id, '100');
    expect(r.document_open).toBe('0.0000');
    await expectCode(apply(fx, pay.id, accrual.id, '0.01'), 'OVER_APPLIED');
  });
});

describe('review: backfill cannot put open periods before closed ones', () => {
  it('refuses a prior fiscal year when the earliest existing period is not open', async () => {
    const fx = await makeFixture(db); // FY2026: Jan-Sep hard
    await actAs(db, fx.user1);
    await expectCode(db.query('select ledger.create_fiscal_year($1, 2025)', [fx.entityA]), 'BACKFILL_CLOSED');
    await db.query('select ledger.create_fiscal_year($1, 2025)', [fx.entityB]); // entity B: all open, allowed
  });
});

describe('review: concurrency on first use', () => {
  const conn = async (who: string) => {
    const c = new pg.Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query('set role app_role');
    await actAs(c, who);
    return c;
  };

  it('a cash_view change waits for an in-flight first posting, then is refused', async () => {
    const fx = await makeFixture(db);
    const acct = await newAccount(fx, '6555', 'expense', 'D', 'settle');
    const poster = await conn(fx.integration);
    const editor = await conn(fx.user1);
    try {
      await poster.query('begin');
      await poster.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(dsj(fx, { lines: [
        { account_id: acct, location_id: fx.locA1, debit: '5' }, { account_id: fx.acct.cash, location_id: fx.locA1, credit: '5' }] }))]);
      const edit = editor.query(`update account set cash_view = 'always' where id = $1`, [acct]).then(() => 'ok', (e) => e.message.split(':')[0]);
      await new Promise((r) => setTimeout(r, 200));
      await poster.query('commit');
      expect(await edit).toBe('ACCOUNT_IMMUTABLE');
    } finally {
      await poster.end();
      await editor.end();
    }
  });

  it('first fiscal year waits for an in-flight calendar change and uses the new settings', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    const ent = (await db.query(`insert into entity (tenant_id, legal_name) values ($1, 'Race LLC') returning id`, [fx.tenant])).rows[0].id;
    const editor = await conn(fx.user1);
    const gen = await conn(fx.user2);
    try {
      await editor.query('begin');
      await editor.query(`update entity set fiscal_calendar = '13_period' where id = $1`, [ent]);
      const made = gen.query('select ledger.create_fiscal_year($1, 2027)', [ent]).then(() => 'ok', (e) => e.message.split(':')[0]);
      await new Promise((r) => setTimeout(r, 200));
      await editor.query('commit');
      expect(await made).toBe('ok');
    } finally {
      await editor.end();
      await gen.end();
    }
    const { rows } = await db.query('select count(*)::int n from period where entity_id = $1', [ent]);
    expect(rows[0].n).toBe(13); // built from the committed 13-period setting, not stale calendar months
  });
});

describe('review: report details keep exact amounts; empty reports keep their basis', () => {
  it('tie-out detail amounts are strings; an empty trial balance reports its basis', async () => {
    const fx = await makeFixture(db);
    const bill = await entry(fx, 'ap_bill', '2026-11-03', [[fx.acct.cogs, '123456789012.3456', 0], [fx.acct.ap, 0, '123456789012.3456']]);
    void bill;
    await actAs(db, fx.user1);
    const { rows } = await db.query(`select detail from ledger.cash_accrual_tieout($1, '2026-11-01', '2026-11-30')`, [fx.entityA]);
    expect(rows[0].detail['2010'].accrual).toBe('-123456789012.3456');
    const { trialBalance } = await import('../modules/reporting/index.js');
    const tb = await trialBalance(db, fx.entityB, null, '2026-11-30');
    expect(tb.basis).toBe('accrual');
  });
});

void authOf; void superClient;
