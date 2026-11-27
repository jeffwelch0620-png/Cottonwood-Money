// Phase 0 step 8 (database side of the admin console): drafts with two-person approval,
// last-owner rule, audited role/limit/setup changes, COA template, JE viewer, audit export.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { appClient, superClient, makeFixture, dsj, post, actAs, authOf, expectCode, waitUntilBlocked, TEST_URL, type Fixture } from './helpers.js';

let db: pg.Client;
let su: pg.Client;
let f: Fixture;
beforeAll(async () => {
  db = await appClient();
  su = await superClient();
  f = await makeFixture(db);
});
afterAll(async () => {
  await db.end();
  await su.end();
});

const draftOf = (fx: Fixture, over: Record<string, unknown> = {}) => {
  const e = dsj(fx, over) as Record<string, unknown>;
  delete e.created_by; delete e.actor_type; delete e.idempotency_key;
  return e;
};
const propose = async (as: string, entry: Record<string, unknown>) => {
  await actAs(db, as);
  return (await db.query('select ledger.propose_entry($1::jsonb) id', [JSON.stringify(entry)])).rows[0].id as string;
};
const approve = async (as: string, draft: string, soft = false) => {
  await actAs(db, as);
  return (await db.query('select ledger.approve_draft($1, $2) r', [draft, soft])).rows[0].r;
};
const manualLines = (fx: Fixture, amt: string) => [
  { account_id: fx.acct.cogs, location_id: fx.locA1, debit: amt },
  { account_id: fx.acct.cash, location_id: fx.locA1, credit: amt },
];

describe('drafts: propose, then a different person approves', () => {
  it('an agent proposes; an integration cannot approve; a person approves and is recorded', async () => {
    const d = await propose(f.agent, draftOf(f, { source_type: 'ap_bill' }));
    await expectCode(approve(f.agent, d), 'SELF_APPROVAL');
    await expectCode(approve(f.integration, d), 'APPROVER_NOT_USER');
    const r = await approve(f.user1, d);
    const { rows } = await db.query('select created_by, approved_by, actor_type from ledger.journal_entry where id = $1', [r.id]);
    expect(rows[0]).toEqual({ created_by: f.agent, approved_by: f.user1, actor_type: 'agent' });
    const dr = (await db.query('select state, decided_by, entry_id from ledger.je_draft where id = $1', [d])).rows[0];
    expect(dr).toEqual({ state: 'posted', decided_by: f.user1, entry_id: r.id });
    await expectCode(approve(f.user2, d), 'REQUEST_DECIDED');
  });

  it('manual draft: no self-approval; approval limit applies; a failed approval leaves it pending', async () => {
    const d = await propose(f.user1, draftOf(f, { source_type: 'manual', evidence_ids: [], lines: manualLines(f, '1500') }));
    await expectCode(approve(f.user1, d), 'SELF_APPROVAL');
    await expectCode(approve(f.clerk, d), 'APPROVAL_LIMIT'); // clerk's limit is 1,000
    expect((await db.query('select state from ledger.je_draft where id = $1', [d])).rows[0].state).toBe('pending');
    const r = await approve(f.user2, d);
    expect(r.seq).toBeGreaterThan(0);
  });

  it('approval re-runs every ledger rule: a draft dated in a soft period needs the override', async () => {
    const d = await propose(f.clerk, draftOf(f, { entry_date: '2026-10-08', lines: [
      { account_id: f.acct.clearing, location_id: f.locA1, debit: '10' }, { account_id: f.acct.sales, location_id: f.locA1, credit: '10' }] }));
    await expectCode(approve(f.user1, d), 'PERIOD_CLOSED');
    const r = await approve(f.user1, d, true); // controller with override
    expect(r.seq).toBeGreaterThan(0);
  });

  it('reject needs a reason; reviewers or the proposer may reject; others may not', async () => {
    const d1 = await propose(f.agent, draftOf(f, { source_type: 'ap_bill' }));
    await actAs(db, f.clerk);
    await expectCode(db.query(`select ledger.reject_draft($1, '  ')`, [d1]), 'MISSING_FIELD');
    await actAs(db, f.integration);
    await expectCode(db.query(`select ledger.reject_draft($1, 'no')`, [d1]), 'ROLE_FORBIDDEN');
    await actAs(db, f.clerk);
    await db.query(`select ledger.reject_draft($1, 'Duplicate of invoice 4411')`, [d1]);
    await expectCode(approve(f.user1, d1), 'REQUEST_DECIDED');
    const d2 = await propose(f.agent, draftOf(f, { source_type: 'ap_bill' }));
    await actAs(db, f.agent);
    await db.query(`select ledger.reject_draft($1, 'withdrawn')`, [d2]); // proposer withdraws
  });

  it('refuses bad drafts at the door and keeps drafts immutable', async () => {
    await expectCode(propose(f.viewer, draftOf(f)), 'ROLE_FORBIDDEN');
    await expectCode(propose(f.user1, draftOf(f, { lines: [
      { account_id: f.acct.cash, location_id: f.locA1, debit: '10' }, { account_id: f.acct.sales, location_id: f.locA1, credit: '9' }] })), 'UNBALANCED');
    await expectCode(propose(f.user1, draftOf(f, { approved_by: f.user2 })), 'BAD_INPUT');
    await expectCode(propose(f.user1, { ...draftOf(f), created_by: f.user2 }), 'CREATOR_NOT_CALLER');
    await expectCode(propose(f.user1, draftOf(f, { source_type: 'reversal' })), 'BAD_SOURCE_TYPE');
    const other = await makeFixture(db);
    await expectCode(propose(f.user1, draftOf(other)), 'TENANT_MISMATCH');
    const d = await propose(f.user1, draftOf(f));
    await expectCode(su.query(`update ledger.je_draft set payload = '{}' where id = $1`, [d]), 'IMMUTABLE');
    await expectCode(su.query(`delete from ledger.je_draft where id = $1`, [d]), 'IMMUTABLE');
    await actAs(db, f.user1);
    await expect(db.query(`update ledger.je_draft set state = 'rejected' where id = $1`, [d])).rejects.toThrow(/permission denied/);
  });
});

describe('membership: last owner and audited changes', () => {
  it('the only owner cannot demote or deactivate themselves; with a second owner they can', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user2);
    const me = authOf(fx.user2);
    await expectCode(db.query(`update membership set role = 'controller' where user_id = $1`, [me]), 'LAST_OWNER');
    await expectCode(db.query(`update membership set active = false where user_id = $1`, [me]), 'LAST_OWNER');
    await db.query(`update membership set role = 'owner' where user_id = $1`, [authOf(fx.user1)]);
    await db.query(`update membership set role = 'controller' where user_id = $1`, [me]);
  });

  it('two owners demoting each other at the same moment: exactly one succeeds', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user2);
    await db.query(`update membership set role = 'owner' where user_id = $1`, [authOf(fx.user1)]);
    const conn = async (who: string) => {
      const c = new pg.Client({ connectionString: TEST_URL });
      await c.connect();
      await c.query('set role app_role');
      await actAs(c, who);
      return c;
    };
    const c1 = await conn(fx.user1);
    const c2 = await conn(fx.user2);
    try {
      await c1.query('begin');
      await c2.query('begin');
      await c1.query(`update membership set role = 'controller' where user_id = $1`, [authOf(fx.user2)]);
      const c2Pid = (await c2.query('select pg_backend_pid() p')).rows[0].p;
      const second = c2.query(`update membership set role = 'controller' where user_id = $1`, [authOf(fx.user1)])
        .then(() => 'ok', (e) => e.message.split(':')[0]);
      await waitUntilBlocked(c2Pid); // c2 is now waiting on the owners lock
      await c1.query('commit');
      expect(await second).toBe('LAST_OWNER');
      await c2.query('rollback');
    } finally {
      await c1.end();
      await c2.end();
    }
    await actAs(db, fx.user1);
    const { rows } = await db.query(`select count(*)::int n from membership where tenant_id = $1 and role = 'owner' and active`, [fx.tenant]);
    expect(rows[0].n).toBe(1);
  });

  it('role and limit changes are audit events with before/after and the actor', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user2);
    await db.query(`update membership set approval_limit = 2500, role = 'manager' where user_id = $1`, [authOf(fx.clerk)]);
    const { rows } = await db.query(
      `select actor_id, detail from audit.event where action = 'membership.update' order by seq desc limit 1`);
    expect(rows[0].actor_id).toBe(fx.user2);
    expect(rows[0].detail.role).toEqual({ from: 'bookkeeper', to: 'manager' });
    expect(rows[0].detail.approval_limit).toEqual({ from: 1000, to: 2500 });
  });

  it('COA, entity, location and principal changes are audit events too', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.user1);
    await db.query(`update account set name = 'Food cost - all stores' where id = $1`, [fx.acct.cogs]);
    const { rows } = await db.query(
      `select action, actor_id, detail from audit.event where object_id = $1 order by seq`, [fx.acct.cogs]);
    expect(rows.map((r) => r.action)).toEqual(['account.insert', 'account.update']);
    expect(rows[1]).toMatchObject({ actor_id: fx.user1, detail: { name: { from: 'Food cost', to: 'Food cost - all stores' } } });
    const kinds = await db.query(
      `select distinct action from audit.event where tenant_id = $1 and action like '%.insert'`, [fx.tenant]);
    expect(kinds.rows.map((r) => r.action).sort()).toEqual(
      ['account.insert', 'entity.insert', 'location.insert', 'membership.insert', 'principal.insert']);
    expect((await db.query('select ok from audit.verify_chain($1)', [fx.tenant])).rows[0].ok).toBe(true);
  });
});

describe('COA template', () => {
  it('loads the USAR-style chart, skipping numbers in use; idempotent; owner/controller only', async () => {
    const fx = await makeFixture(db);
    await actAs(db, fx.clerk);
    await expectCode(db.query(`select ledger.load_coa_template()`), 'ROLE_FORBIDDEN');
    await actAs(db, fx.user1);
    const before = (await db.query('select count(*)::int n from account')).rows[0].n;
    const r1 = (await db.query(`select ledger.load_coa_template('usar') r`)).rows[0].r;
    const after = (await db.query('select count(*)::int n from account')).rows[0].n;
    expect(after - before).toBe(r1.added);
    expect(r1.added).toBeGreaterThan(50);
    expect((await db.query(`select ledger.load_coa_template('usar') r`)).rows[0].r.added).toBe(0);
    await expectCode(db.query(`select ledger.load_coa_template('gaap')`), 'BAD_INPUT');
    const { rows } = await db.query(`select name, usar_code, cash_view from account where number = '7410'`);
    expect(rows[0]).toEqual({ name: 'Credit card fees', usar_code: 'General and administrative', cash_view: 'settle' });
    // Every template account is in a valid normal-balance direction for its type, contra accounts aside.
    const odd = await db.query(`select number from account where usar_code is not null and
      ((type in ('asset','expense') and normal_balance = 'C') or (type in ('liability','equity','revenue') and normal_balance = 'D'))
      order by number`);
    expect(odd.rows.map((r) => r.number)).toEqual(['1590', '3020', '4310']); // accumulated depreciation, distributions, comps
  });
});

describe('JE viewer', () => {
  it('shows lines, evidence with sha256, approvals, and verified hash and chain link', async () => {
    const fx = await makeFixture(db);
    const r1 = await post(db, dsj(fx));
    const d = await propose(fx.user1, draftOf(fx, { source_type: 'manual', evidence_ids: [], lines: manualLines(fx, '42') }));
    const r2 = await approve(fx.user2, d);
    await actAs(db, fx.user1);
    const v = (await db.query('select ledger.entry_detail($1) d', [r2.id])).rows[0].d;
    expect(v).toMatchObject({ seq: 2, hash_ok: true, link_ok: true, draft_id: d, source_type: 'manual',
      created_by: { id: fx.user1, kind: 'user' }, approved_by: { id: fx.user2, name: 'Owner' } });
    expect(v.lines.map((l: { account: string; debit: string }) => [l.account, l.debit])).toEqual([['5010', '42.0000'], ['1010', '0.0000']]);
    const v1 = (await db.query('select ledger.entry_detail($1) d', [r1.id])).rows[0].d;
    const doc = (await su.query(`select encode(sha256, 'hex') h, storage_uri from source_document where id = $1`, [fx.doc])).rows[0];
    expect(v1.evidence).toEqual([expect.objectContaining({ sha256: doc.h, storage_uri: doc.storage_uri })]);
    expect(v1.link_ok).toBe(true);
  });

  it('flags a tampered entry, hides other stores from scoped users, and refuses other tenants', async () => {
    const fx = await makeFixture(db);
    const r = await post(db, dsj(fx, { lines: [
      { account_id: fx.acct.clearing, location_id: fx.locA1, debit: '10' }, { account_id: fx.acct.sales, location_id: fx.locA2, credit: '10' }] }));
    await actAs(db, fx.clerk);
    const scoped = (await db.query('select ledger.entry_detail($1) d', [r.id])).rows[0].d;
    expect(scoped.lines).toHaveLength(1);
    await su.query('begin');
    await su.query('set local session_replication_role = replica');
    await su.query(`update ledger.journal_entry set memo = 'edited' where id = $1`, [r.id]);
    await su.query('commit');
    await actAs(db, fx.user1);
    expect((await db.query('select ledger.entry_detail($1) d', [r.id])).rows[0].d.hash_ok).toBe(false);
    await actAs(db, f.user1);
    await expectCode(db.query('select ledger.entry_detail($1)', [r.id]), 'UNKNOWN_ENTRY');
  });
});

describe('audit export', () => {
  it('owner/controller export events with chain status; a tampered event is reported', async () => {
    const fx = await makeFixture(db);
    await post(db, dsj(fx));
    await actAs(db, fx.clerk);
    await expectCode(db.query('select * from audit.export(null, null)'), 'ROLE_FORBIDDEN');
    await actAs(db, fx.user1);
    const { rows } = await db.query('select * from audit.export(null, null)');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => r.chain_ok)).toBe(true);
    expect(rows.map((r) => Number(r.seq))).toEqual(rows.map((_, i) => i + 1));
    expect(rows.find((r) => r.action === 'ledger.post').actor_name).toBe('Toast connector');
    await su.query('begin');
    await su.query('set local session_replication_role = replica');
    await su.query(`update audit.event set detail = '{}' where tenant_id = $1 and seq = 5`, [fx.tenant]);
    await su.query('commit');
    const t = (await db.query('select * from audit.export(null, null)')).rows[0];
    expect([t.chain_ok, Number(t.chain_first_bad_seq)]).toEqual([false, 5]);
  });
});

