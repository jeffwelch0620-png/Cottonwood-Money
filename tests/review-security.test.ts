// Security findings from the Greptile review of PR #1 (pending owner decision) (each written to fail before its fix).
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

describe('review (security): location scope on payments and drafts', () => {
  it("a store-scoped bookkeeper cannot apply or unapply another store's payment", async () => {
    const fx = await makeFixture(db); // clerk is scoped to locA1
    const bill = await entry(fx, 'ap_bill', '2026-11-03', [[fx.acct.cogs, '50', 0, fx.locA2], [fx.acct.ap, 0, '50', fx.locA2]]);
    const pay = await entry(fx, 'ap_payment', '2026-11-04', [[fx.acct.ap, '50', 0, fx.locA2], [fx.acct.cash, 0, '50', fx.locA2]]);
    await expectCode(apply(fx, pay.id, bill.id, '50', fx.clerk), 'LOCATION_NOT_PERMITTED');
    const a = await apply(fx, pay.id, bill.id, '50');
    await actAs(db, fx.clerk);
    await expectCode(db.query('select ledger.unapply_payment($1)', [a.id]), 'LOCATION_NOT_PERMITTED');
  });

  it("a store-scoped member does not see drafts touching other stores", async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    await db.query('select ledger.propose_entry($1::jsonb)', [JSON.stringify({ tenant_id: fx.tenant, entity_id: fx.entityA, entry_date: '2026-11-10',
      source_type: 'manual', memo: 'store 2 only', lines: [{ account_id: fx.acct.cogs, location_id: fx.locA2, debit: '9' }, { account_id: fx.acct.cash, location_id: fx.locA2, credit: '9' }] })]);
    await actAs(db, fx.clerk);
    const { rows } = await db.query(`select count(*)::int n from ledger.je_draft where payload->>'memo' = 'store 2 only'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('review (security): the creator must act in their own session', () => {
  it('direct posting cannot name another person as creator; it must come through their draft', async () => {
    const fx = await makeFixture(db);
    const manual = dsj(fx, { source_type: 'manual', actor_type: 'user', created_by: fx.user1, evidence_ids: [] });
    await actAs(db, fx.user2);
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(manual)]), 'CREATOR_NOT_CALLER');
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify({ ...manual, approved_by: fx.user2 })]), 'CREATOR_NOT_CALLER');
    // An agent's bill can't be posted by a person directly either; it must be the agent's draft.
    const bill = dsj(fx, { source_type: 'ap_bill', actor_type: 'agent', created_by: fx.agent });
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(bill)]), 'CREATOR_NOT_CALLER');
    // Intercompany sides follow the same rule.
    const side = (entity: string, loc: string, dr: string, cr: string) => ({ tenant_id: fx.tenant, entity_id: entity, entry_date: '2026-11-21',
      idempotency_key: randomUUID(), actor_type: 'user', created_by: fx.user1, evidence_ids: [fx.doc],
      lines: [{ account_id: dr, location_id: loc, debit: '1' }, { account_id: cr, location_id: loc, credit: '1' }] });
    await expectCode(db.query('select ledger.post_intercompany($1::jsonb)', [JSON.stringify({ sides: [
      side(fx.entityA, fx.locA1, fx.acct.cogs, fx.acct.dueTo), side(fx.entityB, fx.locB1, fx.acct.dueFrom, fx.acct.sales)] })]), 'CREATOR_NOT_CALLER');
  });

  it('reversals: the requester files a draft in their own session; a different person approves', async () => {
    const fx = await makeFixture(db);
    const orig = await post(db, dsj(fx));
    await actAs(db, fx.user1);
    const d = (await db.query('select ledger.request_reversal($1::jsonb) id', [JSON.stringify({ entry_id: orig.id })])).rows[0].id;
    await expectCode(db.query('select ledger.request_reversal($1::jsonb)', [JSON.stringify({ entry_id: orig.id })]), 'REVERSAL_PENDING');
    await expectCode(db.query('select ledger.approve_draft($1)', [d]), 'SELF_APPROVAL');
    await actAs(db, fx.user2);
    const r = (await db.query('select ledger.approve_draft($1) r', [d])).rows[0].r;
    const { rows } = await db.query('select created_by, approved_by, reverses_id from ledger.journal_entry where id = $1', [r.id]);
    expect(rows[0]).toEqual({ created_by: fx.user1, approved_by: fx.user2, reverses_id: orig.id });
    await expectCode(db.query('select ledger.request_reversal($1::jsonb)', [JSON.stringify({ entry_id: orig.id })]), 'ALREADY_REVERSED');
    await actAs(db, fx.integration);
    await expectCode(db.query('select ledger.request_reversal($1::jsonb)', [JSON.stringify({ entry_id: orig.id })]), 'APPROVER_NOT_USER');
    const { rows: fn } = await db.query(`select to_regprocedure('ledger.reverse_entry(jsonb)') old, to_regprocedure('ledger._post(jsonb, uuid)') old_post`);
    expect(fn[0]).toEqual({ old: null, old_post: null });
  });

  it('a manual entry (no source documents) can be reversed; evidence must match the original', async () => {
    const fx = await makeFixture(db);
    const m = await post(db, dsj(fx, { source_type: 'manual', actor_type: 'user', created_by: fx.user1, approved_by: fx.user2, evidence_ids: [] }));
    await actAs(db, fx.user1);
    const d = (await db.query('select ledger.request_reversal($1::jsonb) id', [JSON.stringify({ entry_id: m.id })])).rows[0].id;
    await actAs(db, fx.user2);
    const r = (await db.query('select ledger.approve_draft($1) r', [d])).rows[0].r;
    expect(r.seq).toBeGreaterThan(m.seq);
    // A reversal draft whose evidence was swapped (by a superuser) is refused.
    const orig = await post(db, dsj(fx));
    await actAs(db, fx.user1);
    const d2 = (await db.query('select ledger.request_reversal($1::jsonb) id', [JSON.stringify({ entry_id: orig.id })])).rows[0].id;
    const su = await superClient();
    await su.query('begin');
    await su.query('set local session_replication_role = replica');
    await su.query(`update ledger.je_draft set payload = jsonb_set(payload, '{evidence_ids}', '[]') where id = $1`, [d2]);
    await su.query('commit');
    await su.end();
    await actAs(db, fx.user2);
    await expectCode(db.query('select ledger.approve_draft($1)', [d2]), 'REVERSAL_MISMATCH');
  });

  it('a store-scoped member cannot reject a draft or request a reversal outside their stores', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    const d = (await db.query('select ledger.propose_entry($1::jsonb) id', [JSON.stringify({ tenant_id: fx.tenant, entity_id: fx.entityA, entry_date: '2026-11-10',
      source_type: 'manual', lines: [{ account_id: fx.acct.cogs, location_id: fx.locA2, debit: '9' }, { account_id: fx.acct.cash, location_id: fx.locA2, credit: '9' }] })])).rows[0].id;
    const e = await post(db, dsj(fx, { lines: [{ account_id: fx.acct.clearing, location_id: fx.locA2, debit: '3' }, { account_id: fx.acct.sales, location_id: fx.locA2, credit: '3' }] }));
    await actAs(db, fx.clerk);
    await expectCode(db.query(`select ledger.reject_draft($1, 'no')`, [d]), 'LOCATION_NOT_PERMITTED');
    await expectCode(db.query('select ledger.request_reversal($1::jsonb)', [JSON.stringify({ entry_id: e.id })]), 'LOCATION_NOT_PERMITTED');
  });
});
void authOf; void superClient;
