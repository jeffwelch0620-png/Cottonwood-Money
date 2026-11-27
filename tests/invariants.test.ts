// One failing case (at least) per invariant I1-I7. Every call goes straight to the
// database as app_role, proving the database refuses bad entries on its own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { appClient, superClient, makeFixture, dsj, post, actAs, expectCode, count, type Fixture } from './helpers.js';

let db: pg.Client;
let f: Fixture;
let other: Fixture; // a second tenant, for cross-tenant checks

beforeAll(async () => {
  db = await appClient();
  f = await makeFixture(db);
  other = await makeFixture(db);
  await actAs(db, f.user1);
});
afterAll(async () => db.end());

const linesFor = (fx: Fixture) => count(db, 'select count(*) n from ledger.journal_line where tenant_id = $1', [fx.tenant]);

describe('I1 - debits equal credits', () => {
  it('rejects an unbalanced entry and writes nothing', async () => {
    const before = await linesFor(f);
    const e = dsj(f, {
      lines: [
        { account_id: f.acct.clearing, location_id: f.locA1, debit: '100.00' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '99.99' },
      ],
    });
    await expectCode(post(db, e), 'UNBALANCED');
    expect(await linesFor(f)).toBe(before);
  });

  it('rejects an entry with fewer than two lines', async () => {
    await expectCode(post(db, dsj(f, { lines: [{ account_id: f.acct.cash, location_id: f.locA1, debit: '1' }] })), 'TOO_FEW_LINES');
  });

  it('rejects a line with both a debit and a credit, or a negative amount', async () => {
    const both = dsj(f, {
      lines: [
        { account_id: f.acct.clearing, location_id: f.locA1, debit: '10', credit: '10' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '0' },
      ],
    });
    await expectCode(post(db, both), 'BAD_LINE_AMOUNT');
    const neg = dsj(f, {
      lines: [
        { account_id: f.acct.clearing, location_id: f.locA1, debit: '-10' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '-10' },
      ],
    });
    await expectCode(post(db, neg), 'BAD_LINE_AMOUNT');
  });

  it('rejects amounts with more than 4 decimal places', async () => {
    const e = dsj(f, {
      lines: [
        { account_id: f.acct.clearing, location_id: f.locA1, debit: '10.00005' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '10.00005' },
      ],
    });
    await expectCode(post(db, e), 'BAD_PRECISION');
  });

  it('app_role cannot insert lines directly', async () => {
    await expect(
      db.query(`insert into ledger.journal_line (entry_id, line_no, tenant_id, entity_id, account_id, location_id, debit)
                values ($1, 99, $2, $3, $4, $5, 1)`, [randomUUID(), f.tenant, f.entityA, f.acct.cash, f.locA1]),
    ).rejects.toThrow(/permission denied/);
  });

  it('backstop: even the ledger owner cannot commit an unbalancing line', async () => {
    const posted = await post(db, dsj(f));
    const su = await superClient();
    try {
      await su.query('begin');
      await su.query('set local role ledger_owner');
      await su.query(
        `insert into ledger.journal_line (entry_id, line_no, tenant_id, entity_id, account_id, location_id, debit)
         values ($1, 99, $2, $3, $4, $5, 5)`,
        [posted.id, f.tenant, f.entityA, f.acct.cash, f.locA1],
      );
      await expect(su.query('commit')).rejects.toThrow(/^UNBALANCED/);
    } finally {
      await su.end();
    }
  });
});

describe('I2 - every line has a valid entity, location and account', () => {
  it('rejects a location that belongs to another entity', async () => {
    const e = dsj(f, {
      lines: [
        { account_id: f.acct.clearing, location_id: f.locB1, debit: '5' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '5' },
      ],
    });
    await expectCode(post(db, e), 'LOCATION_NOT_IN_ENTITY');
  });

  it("rejects another tenant's account", async () => {
    const e = dsj(f, {
      lines: [
        { account_id: other.acct.clearing, location_id: f.locA1, debit: '5' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '5' },
      ],
    });
    await expectCode(post(db, e), 'UNKNOWN_ACCOUNT');
  });

  it('rejects an inactive account', async () => {
    const e = dsj(f, {
      lines: [
        { account_id: f.acct.inactive, location_id: f.locA1, debit: '5' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '5' },
      ],
    });
    await expectCode(post(db, e), 'INACTIVE_ACCOUNT');
  });

  it("rejects another tenant's entity", async () => {
    await expectCode(post(db, dsj(f, { entity_id: other.entityA })), 'UNKNOWN_ENTITY');
  });
});

describe('I3 - posting date must fall in an open period', () => {
  it('rejects a soft-closed period, unless a controller sets the soft-close override', async () => {
    await expectCode(post(db, dsj(f, { entry_date: '2026-10-15' })), 'PERIOD_CLOSED');
    const ok = await post(db, dsj(f, { entry_date: '2026-10-15', allow_soft_close: true }), f.user1);
    expect(ok.seq).toBeGreaterThan(0);
  });

  it('rejects a hard-closed period even with the override', async () => {
    await expectCode(post(db, dsj(f, { entry_date: '2026-09-10', allow_soft_close: true }), f.user1), 'PERIOD_CLOSED');
  });

  it('rejects a date with no period', async () => {
    await expectCode(post(db, dsj(f, { entry_date: '2027-01-05' })), 'NO_PERIOD');
  });

  it('periods only move forward, and only seal_period can seal', async () => {
    await actAs(db, f.user1);
    await expect(db.query(`update period set status = 'hard' where id = $1`, [f.periods.octA])).rejects.toThrow(/permission denied/);
    await expectCode(db.query(`select ledger.close_period($1, 'soft')`, [f.periods.octA]), 'PERIOD_BACKWARD');
    await db.query(`select ledger.close_period($1, 'hard')`, [f.periods.octA]);
    const su0 = await superClient();
    await expectCode(su0.query(`update period set status = 'open' where id = $1`, [f.periods.octA]), 'PERIOD_BACKWARD');
    await expectCode(
      su0.query(`update period set status = 'sealed', seal_hash = '\\x00'::bytea where id = $1`, [f.periods.octA]),
      'PERIOD_SEAL_DIRECT',
    );
    await su0.end();
    for (const id of f.monthsA.slice(0, 9)) await db.query('select ledger.seal_period($1)', [id]);
    await actAs(db, f.agent);
    await expectCode(db.query('select ledger.seal_period($1)', [f.periods.octA]), 'APPROVER_NOT_USER');
    await actAs(db, f.user1);
    const { rows } = await db.query('select ledger.seal_period($1) as r', [f.periods.octA]);
    expect(rows[0].r.seal_hash).toMatch(/^[0-9a-f]{64}$/);
    await expectCode(post(db, dsj(f, { entry_date: '2026-10-20', allow_soft_close: true }), f.user1), 'PERIOD_CLOSED');
    await expect(db.query(`delete from period where id = $1`, [f.periods.octA])).rejects.toThrow(/permission denied/);
    const su = await superClient();
    await expectCode(su.query(`delete from period where id = $1`, [f.periods.octA]), 'PERIOD_IMMUTABLE');
    await su.end();
  });
});

describe('I5 - evidence and approvals', () => {
  it('rejects a non-manual entry with no source document', async () => {
    await expectCode(post(db, dsj(f, { evidence_ids: [] })), 'NO_EVIDENCE');
  });

  it("rejects another tenant's source document", async () => {
    await expectCode(post(db, dsj(f, { evidence_ids: [other.doc] })), 'UNKNOWN_EVIDENCE');
  });

  it('manual entries need a second person', async () => {
    const manual = (over: object) =>
      dsj(f, { source_type: 'manual', actor_type: 'user', created_by: f.user1, evidence_ids: [], ...over });
    await expectCode(post(db, manual({})), 'APPROVAL_REQUIRED');
    await expectCode(post(db, manual({ approved_by: f.user1 })), 'SELF_APPROVAL');
    await expectCode(post(db, manual({ approved_by: f.agent })), 'AGENT_CANNOT_POST');
    await expectCode(post(db, manual({}), f.integration), 'APPROVER_NOT_USER');
    const ok = await post(db, manual({ approved_by: f.user2 }));
    expect(ok.seq).toBeGreaterThan(0);
  });

  it('the declared actor type must match the principal', async () => {
    await expectCode(post(db, dsj(f, { actor_type: 'user' })), 'ACTOR_MISMATCH'); // the integration claiming to be a user
  });

  it('an agent can create (with evidence) but never post; the person who posts it is the approver', async () => {
    const bill = () => dsj(f, { actor_type: 'agent', created_by: f.agent, source_type: 'ap_bill' });
    await expectCode(post(db, bill()), 'AGENT_CANNOT_POST');
    const ok = await post(db, bill(), f.user1);
    const { rows } = await db.query('select created_by, approved_by from ledger.journal_entry where id = $1', [ok.id]);
    expect(rows[0]).toEqual({ created_by: f.agent, approved_by: f.user1 });
  });
});

describe('I6 - intercompany entries post in pairs that net to zero', () => {
  const sides = (amountB = '500') => ({
    sides: [
      {
        tenant_id: f.tenant, entity_id: f.entityA, entry_date: '2026-11-21', idempotency_key: `ic:${randomUUID()}`,
        actor_type: 'user', created_by: f.user1, evidence_ids: [f.doc],
        lines: [
          { account_id: f.acct.cogs, location_id: f.locA1, debit: '500' },
          { account_id: f.acct.dueTo, location_id: f.locA1, credit: '500' },
        ],
      },
      {
        tenant_id: f.tenant, entity_id: f.entityB, entry_date: '2026-11-21', idempotency_key: `ic:${randomUUID()}`,
        actor_type: 'user', created_by: f.user1, evidence_ids: [f.doc],
        lines: [
          { account_id: f.acct.dueFrom, location_id: f.locB1, debit: amountB },
          { account_id: f.acct.sales, location_id: f.locB1, credit: amountB },
        ],
      },
    ],
  });

  it('rejects intercompany accounts outside a pair', async () => {
    const e = dsj(f, {
      lines: [
        { account_id: f.acct.dueFrom, location_id: f.locA1, debit: '5' },
        { account_id: f.acct.sales, location_id: f.locA1, credit: '5' },
      ],
    });
    await expectCode(post(db, e), 'IC_REQUIRES_PAIR');
    await expectCode(post(db, dsj(f, { source_type: 'intercompany' })), 'IC_REQUIRES_PAIR');
  });

  it('posts a netting pair atomically with a shared group id', async () => {
    await actAs(db, f.user1);
    const { rows } = await db.query('select ledger.post_intercompany($1::jsonb) as r', [JSON.stringify(sides())]);
    const r = rows[0].r;
    expect(r.sides).toHaveLength(2);
    const groups = await db.query('select distinct ic_group_id from ledger.journal_entry where ic_group_id = $1', [r.ic_group_id]);
    expect(groups.rowCount).toBe(1);
  });

  it('rejects a pair that does not net, and writes neither side', async () => {
    await actAs(db, f.user1);
    const before = await linesFor(f);
    await expectCode(db.query('select ledger.post_intercompany($1::jsonb)', [JSON.stringify(sides('400'))]), 'IC_NOT_NETTING');
    expect(await linesFor(f)).toBe(before);
  });

  it('rejects a pair within one entity', async () => {
    await actAs(db, f.user1);
    const s = sides();
    s.sides[1].entity_id = f.entityA;
    await expectCode(db.query('select ledger.post_intercompany($1::jsonb)', [JSON.stringify(s)]), 'IC_SAME_ENTITY');
  });
});

describe('I7 - numbering, hash chain and reversals', () => {
  it('numbers entries gap-free and links each hash to the previous one', async () => {
    const fx = await makeFixture(db);
    const a = await post(db, dsj(fx));
    const b = await post(db, dsj(fx));
    const c = await post(db, dsj(fx));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    const { rows } = await db.query(
      `select seq, encode(prev_hash,'hex') prev, encode(hash,'hex') h,
              encode(ledger.genesis_hash(entity_id),'hex') genesis
         from ledger.journal_entry where entity_id = $1 order by seq`,
      [fx.entityA],
    );
    expect(rows[0].prev).toBe(rows[0].genesis);
    expect(rows[1].prev).toBe(rows[0].h);
    expect(rows[2].prev).toBe(rows[1].h);
    const v = await db.query('select * from ledger.verify_chain($1)', [fx.entityA]);
    expect(v.rows[0]).toMatchObject({ ok: true, checked: '3' });
  });

  it('reverses an entry exactly once, with two-person approval', async () => {
    const orig = await post(db, dsj(f));
    const request = async (id: string, as = f.user1) => {
      await actAs(db, as);
      return (await db.query('select ledger.request_reversal($1::jsonb) id', [JSON.stringify({ entry_id: id })])).rows[0].id as string;
    };
    const d = await request(orig.id);
    await expectCode(db.query('select ledger.approve_draft($1)', [d]), 'SELF_APPROVAL');
    await actAs(db, f.user2);
    const r = (await db.query('select ledger.approve_draft($1) r', [d])).rows[0].r;
    const net = await db.query(
      `select sum(debit - credit)::text n from ledger.journal_line where entry_id = any($1::uuid[])`,
      [[orig.id, r.id]],
    );
    expect(net.rows[0].n).toBe('0.0000');
    await expectCode(request(orig.id), 'ALREADY_REVERSED');
    await expectCode(request(r.id), 'REVERSAL_LINK');
  });

  it('a "reversal" can only come from a reversal request, and its lines must mirror the original', async () => {
    const orig = await post(db, dsj(f));
    const fake = dsj(f, {
      source_type: 'reversal', reverses_id: orig.id, actor_type: 'user', created_by: f.user1,
      lines: [
        { account_id: f.acct.sales, location_id: f.locA1, debit: '1.0000' },
        { account_id: f.acct.clearing, location_id: f.locA1, credit: '1.0000' },
      ],
    });
    await expectCode(post(db, fake), 'APPROVAL_REQUIRED'); // posted directly by its creator
    await actAs(db, f.user1);
    const { evidence_ids: _e, idempotency_key: _k, created_by: _c, actor_type: _t, ...draft } = fake as Record<string, unknown>;
    await expectCode(db.query('select ledger.propose_entry($1::jsonb)', [JSON.stringify(draft)]), 'BAD_SOURCE_TYPE');
    // Backstop: even a reversal draft whose payload a superuser tampered with is refused at approval.
    const d = (await db.query('select ledger.request_reversal($1::jsonb) id', [JSON.stringify({ entry_id: orig.id })])).rows[0].id;
    const su = await superClient();
    await su.query('begin');
    await su.query('set local session_replication_role = replica');
    // Still balanced, but line 1 now hits cash instead of mirroring the original's clearing line.
    await su.query(`update ledger.je_draft set payload = jsonb_set(payload, '{lines,0,account_id}', to_jsonb($2::text)) where id = $1`, [d, f.acct.cash]);
    await su.query('commit');
    await su.end();
    await actAs(db, f.user2);
    await expectCode(db.query('select ledger.approve_draft($1)', [d]), 'REVERSAL_MISMATCH');
  });

  it('app_role cannot call the internal posting function', async () => {
    await expect(db.query('select ledger._post($1::jsonb, null)', [JSON.stringify(dsj(f))])).rejects.toThrow(/permission denied/);
  });

  it('writes one hash-chained audit event per posting', async () => {
    const fx = await makeFixture(db);
    await post(db, dsj(fx));
    await post(db, dsj(fx));
    const n = await count(db, `select count(*) n from audit.event where tenant_id = $1 and action = 'ledger.post'`, [fx.tenant]);
    expect(n).toBe(2);
    const v = await db.query('select * from audit.verify_chain($1)', [fx.tenant]);
    expect(v.rows[0].ok).toBe(true);
  });
});
