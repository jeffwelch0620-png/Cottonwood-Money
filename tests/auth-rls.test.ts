// Phase 0 step 5: auth, membership, row-level security, and the three closed gaps.
// Every refusal here comes from the database, with the app role and a JWT-claims session.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  appClient, superClient, makeFixture, dsj, post, actAs, setClaims, authOf, createAuthUsers,
  expectCode, count, TEST_URL, type Fixture,
} from './helpers.js';
import { withSession } from '../modules/auth/index.js';

let db: pg.Client;
let su: pg.Client;
let a: Fixture; // tenant A
let b: Fixture; // tenant B

// Tables that are global by design (no tenant data). Everything else must have RLS.
const GLOBAL_TABLES = ['public.schema_migrations'];

beforeAll(async () => {
  db = await appClient();
  su = await superClient();
  a = await makeFixture(db);
  b = await makeFixture(db);
  // Give tenant A rows in every ledger table.
  await post(db, dsj(a));
  await post(db, dsj(a, { entry_date: '2026-11-21', lines: [
    { account_id: a.acct.clearing, location_id: a.locA2, debit: '40' },
    { account_id: a.acct.sales, location_id: a.locA2, credit: '40' },
  ] }));
  await db.query('select ledger.take_manifest($1)', [a.entityA]);
  await post(db, dsj(b));
});
afterAll(async () => {
  await db.end();
  await su.end();
});

const manual = (f: Fixture, over: Record<string, unknown> = {}) =>
  dsj(f, { source_type: 'manual', actor_type: 'user', created_by: f.user1, evidence_ids: [], ...over });

describe('CI guard: every tenant table has row-level security', () => {
  it('fails if any table in public/ledger/audit/app lacks RLS or an app_role policy', async () => {
    const { rows } = await su.query(`
      select n.nspname || '.' || c.relname as t, c.relrowsecurity as rls,
             (select count(*) from pg_policy p
               where p.polrelid = c.oid and 'app_role'::regrole::oid = any(p.polroles))::int as app_policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p') and n.nspname in ('public', 'ledger', 'audit', 'app')`);
    const missing = rows
      .filter((r) => !GLOBAL_TABLES.includes(r.t))
      .filter((r) => !r.rls || r.app_policies === 0)
      .map((r) => r.t);
    expect(missing).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(14);
  });

  it('app_role cannot bypass RLS', async () => {
    const { rows } = await su.query(`select rolbypassrls, rolsuper from pg_roles where rolname = 'app_role'`);
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("a member of tenant B sees none of tenant A's rows in any tenant table", async () => {
    const { rows: tables } = await su.query(`
      select format('%I.%I', table_schema, table_name) t from information_schema.columns
       where column_name = 'tenant_id' and table_schema in ('public', 'ledger', 'audit')`);
    expect(tables.length).toBeGreaterThanOrEqual(11);
    for (const { t } of tables) {
      await actAs(db, a.user2);
      const mine = await count(db, `select count(*) n from ${t} where tenant_id = $1`, [a.tenant]);
      await actAs(db, b.user2);
      const theirs = await count(db, `select count(*) n from ${t} where tenant_id = $1`, [a.tenant]);
      expect({ t, mine: mine > 0, theirs }).toEqual({ t, mine: true, theirs: 0 });
    }
    // tenant (keyed by id) and chain_manifest (keyed by entity)
    expect(await count(db, 'select count(*) n from tenant where id = $1', [a.tenant])).toBe(0);
    expect(await count(db, 'select count(*) n from ledger.chain_manifest where entity_id = $1', [a.entityA])).toBe(0);
    await actAs(db, a.user2);
    expect(await count(db, 'select count(*) n from ledger.chain_manifest where entity_id = $1', [a.entityA])).toBe(1);
  });
});

describe('RLS does not weaken the commit-time balance backstop', () => {
  it('still refuses an unbalancing line at commit when the session has no claims', async () => {
    const posted = await post(db, dsj(a));
    const c = await superClient();
    try {
      await c.query('begin');
      await c.query('set local role ledger_owner');
      await c.query(
        `insert into ledger.journal_line (entry_id, line_no, tenant_id, entity_id, account_id, location_id, debit)
         values ($1, 99, $2, $3, $4, $5, 5)`, [posted.id, a.tenant, a.entityA, a.acct.cash, a.locA1]);
      await c.query('set local role app_role');            // commit-time trigger now fires as app_role
      await c.query(`select set_config('request.jwt.claims', '', true)`); // with no tenant: RLS hides every line
      await expect(c.query('commit')).rejects.toThrow(/^UNBALANCED/);
    } finally {
      await c.end();
    }
  });
});

describe('session identity: auth.uid() + tenant claim, verified against membership', () => {
  it('no claims: no tenant, no rows, no posting', async () => {
    await setClaims(db, null);
    const { rows } = await db.query('select app.current_tenant() t');
    expect(rows[0].t).toBeNull();
    expect(await count(db, 'select count(*) n from ledger.journal_entry')).toBe(0);
    expect(await count(db, 'select count(*) n from principal')).toBe(0);
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(dsj(a))]), 'NOT_AUTHENTICATED');
  });

  it("a forged tenant claim (a tenant you're not a member of) gives no tenant", async () => {
    await setClaims(db, { sub: authOf(a.user1), tenant_id: b.tenant, aal: 'aal2' });
    expect((await db.query('select app.current_tenant() t')).rows[0].t).toBeNull();
    expect(await count(db, 'select count(*) n from entity')).toBe(0);
    await setClaims(db, { sub: authOf(a.user1), tenant_id: 'not-a-uuid', aal: 'aal2' });
    expect((await db.query('select app.current_tenant() t')).rows[0].t).toBeNull();
  });

  it('people need MFA (aal2); service logins do not', async () => {
    await actAs(db, a.user1, { aal: 'aal1' });
    expect((await db.query('select app.current_tenant() t')).rows[0].t).toBeNull();
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(dsj(a))]), 'NOT_AUTHENTICATED');
    await actAs(db, a.integration, { aal: 'aal1' });
    expect((await db.query('select app.current_tenant() t')).rows[0].t).toBe(a.tenant);
    await setClaims(db, { sub: authOf(a.user1), aal: 'aal1' });
    await expectCode(db.query(`select app.create_tenant('x')`), 'MFA_REQUIRED');
  });

  it('an inactive membership gives no tenant', async () => {
    const f = await makeFixture(db);
    await actAs(db, f.user2);
    await db.query('update membership set active = false where user_id = $1', [authOf(f.user1)]);
    await actAs(db, f.user1);
    expect((await db.query('select app.current_tenant() t')).rows[0].t).toBeNull();
  });

  it('app role cannot create a tenant directly, only through sign-up', async () => {
    await actAs(db, a.user2);
    await expect(db.query(`insert into tenant (name) values ('x')`)).rejects.toThrow(/permission denied/);
  });

  it('withSession sets claims for one transaction only, so pooled connections never leak identity', async () => {
    const pool = new pg.Pool({ connectionString: TEST_URL, max: 1 });
    pool.on('connect', (c) => { c.query('set role app_role'); });
    try {
      const t = await withSession(pool, { sub: authOf(a.user1), tenant_id: a.tenant, aal: 'aal2' },
        async (c) => (await c.query('select app.current_tenant() t')).rows[0].t);
      expect(t).toBe(a.tenant);
      const after = await pool.query('select app.current_tenant() t');
      expect(after.rows[0].t).toBeNull();
    } finally {
      await pool.end();
    }
  });
});

describe('gap 1: post_entry checks input.tenant_id = app.current_tenant()', () => {
  it("refuses an entry for another tenant, even with that tenant's own ids", async () => {
    await actAs(db, a.integration);
    const before = await (async () => { await actAs(db, b.user2); return count(db, 'select count(*) n from ledger.journal_entry'); })();
    await actAs(db, a.integration);
    const forB = { ...dsj(b), created_by: a.integration };
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(forB)]), 'TENANT_MISMATCH');
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(dsj(b))]), 'TENANT_MISMATCH');
    await actAs(db, b.user2);
    expect(await count(db, 'select count(*) n from ledger.journal_entry')).toBe(before);
  });

  it('refuses an intercompany side in another tenant', async () => {
    await actAs(db, a.user1);
    const side = (f: Fixture, entity: string, loc: string, dr: string, cr: string) => ({
      tenant_id: f.tenant, entity_id: entity, entry_date: '2026-11-21', idempotency_key: `ic:${randomUUID()}`,
      actor_type: 'user', created_by: f.user1, evidence_ids: [f.doc],
      lines: [{ account_id: dr, location_id: loc, debit: '10' }, { account_id: cr, location_id: loc, credit: '10' }],
    });
    const pair = { sides: [side(b, b.entityA, b.locA1, b.acct.cogs, b.acct.dueTo), side(b, b.entityB, b.locB1, b.acct.dueFrom, b.acct.sales)] };
    await expectCode(db.query('select ledger.post_intercompany($1::jsonb)', [JSON.stringify(pair)]), 'TENANT_MISMATCH');
  });

  it("verify, manifest, reverse and audit-verify refuse another tenant's objects", async () => {
    await actAs(db, b.user2);
    const bEntry = (await db.query('select id from ledger.journal_entry limit 1')).rows[0].id;
    await actAs(db, a.user2);
    await expectCode(db.query('select * from ledger.verify_chain($1)', [b.entityA]), 'UNKNOWN_ENTITY');
    await expectCode(db.query('select ledger.take_manifest($1)', [b.entityA]), 'UNKNOWN_ENTITY');
    await expectCode(db.query('select * from audit.verify_chain($1)', [b.tenant]), 'TENANT_MISMATCH');
    await expectCode(db.query('select ledger.reverse_entry($1::jsonb)', [JSON.stringify({ entry_id: bEntry, created_by: a.user1 })]), 'REVERSAL_LINK');
  });
});

describe('gap 2: allow_soft_close is honored only for owner and controller roles', () => {
  const soft = (f: Fixture) => dsj(f, { entry_date: '2026-10-12', allow_soft_close: true });

  it('refuses the override from an integration and a bookkeeper', async () => {
    await expectCode(post(db, soft(a), a.integration), 'SOFT_CLOSE_FORBIDDEN');
    await expectCode(post(db, soft(a), a.clerk), 'SOFT_CLOSE_FORBIDDEN');
  });

  it('accepts it from a controller and an owner, and records the override in the audit log', async () => {
    for (const who of [a.user1, a.user2]) {
      const r = await post(db, soft(a), who);
      const { rows } = await db.query(
        `select detail from audit.event where action = 'ledger.post' and object_id = $1`, [r.id]);
      expect(rows[0].detail).toMatchObject({ soft_close_override: true, posted_by: who, approved_by: who });
    }
  });
});

describe('gap 3: seal_period and approvals take the actor from the session', () => {
  it('seal_period no longer accepts an actor parameter', async () => {
    const { rows } = await su.query(`select to_regprocedure('ledger.seal_period(uuid, uuid)') old, to_regprocedure('ledger.seal_period(uuid)') new`);
    expect(rows[0].old).toBeNull();
    expect(rows[0].new).not.toBeNull();
  });

  it('records the session user as the sealer; refuses agents, bookkeepers and other tenants', async () => {
    const f = await makeFixture(db);
    await actAs(db, f.user1);
    await db.query(`update period set status = 'soft' where id = $1`, [f.periods.octA]);
    await db.query(`update period set status = 'hard' where id = $1`, [f.periods.octA]);
    await actAs(db, f.agent);
    await expectCode(db.query('select ledger.seal_period($1)', [f.periods.octA]), 'APPROVER_NOT_USER');
    await actAs(db, f.clerk);
    await expectCode(db.query('select ledger.seal_period($1)', [f.periods.octA]), 'ROLE_FORBIDDEN');
    await actAs(db, a.user1);
    await expectCode(db.query('select ledger.seal_period($1)', [f.periods.octA]), 'NO_PERIOD');
    await actAs(db, f.user1);
    await db.query('select ledger.seal_period($1)', [f.periods.octA]);
    const { rows } = await db.query(`select actor_id from audit.event where action = 'period.seal' and object_id = $1`, [f.periods.octA]);
    expect(rows[0].actor_id).toBe(f.user1);
  });

  it('the approver is the session user; a claimed approver who is not the caller is refused', async () => {
    await actAs(db, a.user1);
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(manual(a, { approved_by: a.user2 }))]), 'APPROVER_NOT_CALLER');
    await actAs(db, a.clerk);
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(manual(a, { approved_by: a.user2 }))]), 'APPROVER_NOT_CALLER');
    const r = await post(db, manual(a), a.user2); // no approved_by in input: derived
    const { rows } = await db.query('select approved_by from ledger.journal_entry where id = $1', [r.id]);
    expect(rows[0].approved_by).toBe(a.user2);
  });

  it('reverse_entry derives the approver from the session', async () => {
    const orig = await post(db, dsj(a));
    await actAs(db, a.user2);
    const { rows } = await db.query('select ledger.reverse_entry($1::jsonb) r', [JSON.stringify({ entry_id: orig.id, created_by: a.user1 })]);
    const e = await db.query('select created_by, approved_by from ledger.journal_entry where id = $1', [rows[0].r.id]);
    expect(e.rows[0]).toEqual({ created_by: a.user1, approved_by: a.user2 });
  });
});

describe('membership: roles, location scope, approval limits', () => {
  it('a viewer cannot post', async () => {
    await expectCode(post(db, manual(a), a.viewer), 'ROLE_FORBIDDEN');
  });

  it('a location-scoped member cannot post outside their locations, and reads only their lines', async () => {
    const atA2 = dsj(a, { lines: [
      { account_id: a.acct.clearing, location_id: a.locA2, debit: '5' },
      { account_id: a.acct.sales, location_id: a.locA2, credit: '5' },
    ] });
    await expectCode(post(db, atA2, a.clerk), 'LOCATION_NOT_PERMITTED');
    await post(db, dsj(a, { lines: [
      { account_id: a.acct.clearing, location_id: a.locA1, debit: '5' },
      { account_id: a.acct.sales, location_id: a.locA1, credit: '5' },
    ] }), a.clerk);
    await actAs(db, a.clerk);
    const { rows } = await db.query('select distinct location_id from ledger.journal_line');
    expect(rows.map((r) => r.location_id)).toEqual([a.locA1]);
  });

  it('an approver cannot approve above their approval limit', async () => {
    const big = manual(a, { lines: [
      { account_id: a.acct.cogs, location_id: a.locA1, debit: '1000.0001' },
      { account_id: a.acct.cash, location_id: a.locA1, credit: '1000.0001' },
    ] });
    await expectCode(post(db, big, a.clerk), 'APPROVAL_LIMIT');
    const atLimit = manual(a, { lines: [
      { account_id: a.acct.cogs, location_id: a.locA1, debit: '1000' },
      { account_id: a.acct.cash, location_id: a.locA1, credit: '1000' },
    ] });
    expect((await post(db, atLimit, a.clerk)).seq).toBeGreaterThan(0);
  });

  it('only the owner manages members and principals; no self-promotion', async () => {
    const [newUser] = await createAuthUsers(1);
    await actAs(db, a.user1); // controller
    await expect(db.query(`insert into membership (user_id, tenant_id, role) values ($1, $2, 'owner')`, [newUser, a.tenant]))
      .rejects.toThrow(/row-level security/);
    await expect(db.query(`insert into principal (tenant_id, kind, name) values ($1, 'user', 'ghost')`, [a.tenant]))
      .rejects.toThrow(/row-level security/);
    const upd = await db.query(`update membership set role = 'owner' where user_id = $1`, [authOf(a.user1)]);
    expect(upd.rowCount).toBe(0);
    await actAs(db, a.user2); // owner
    await expect(db.query(`insert into membership (user_id, tenant_id, role) values ($1, $2, 'viewer')`, [newUser, b.tenant]))
      .rejects.toThrow(/row-level security/);
  });

  it("membership location_ids must belong to the tenant, and user/tenant can't change", async () => {
    const [newUser] = await createAuthUsers(1);
    await actAs(db, a.user2);
    await expectCode(db.query(`insert into membership (user_id, tenant_id, role, location_ids) values ($1, $2, 'manager', $3)`,
      [newUser, a.tenant, [b.locA1]]), 'LOCATION_NOT_IN_TENANT');
    await expectCode(db.query(`update membership set user_id = $1 where user_id = $2`, [newUser, authOf(a.user1)]), 'MEMBERSHIP_IMMUTABLE');
  });

  it("a principal's kind and login are fixed", async () => {
    await actAs(db, a.user2);
    await expectCode(db.query(`update principal set kind = 'user' where id = $1`, [a.agent]), 'PRINCIPAL_IMMUTABLE');
    await expectCode(db.query(`update principal set auth_user_id = $1 where id = $2`, [authOf(a.user1), a.agent]), 'PRINCIPAL_IMMUTABLE');
  });

  it('a person principal with no active membership cannot be the creator (no ghost second person)', async () => {
    const [ghostLogin] = await createAuthUsers(1);
    await actAs(db, a.user2);
    const ghost = (await db.query(`insert into principal (tenant_id, kind, name, auth_user_id) values ($1, 'user', 'Ghost', $2) returning id`,
      [a.tenant, ghostLogin])).rows[0].id;
    await expectCode(post(db, manual(a, { created_by: ghost }), a.user1), 'CREATOR_NOT_MEMBER');
  });

  it('a service login cannot act as a person principal', async () => {
    const [svc] = await createAuthUsers(1);
    await actAs(db, a.user2);
    await db.query(`insert into membership (user_id, tenant_id, role) values ($1, $2, 'service')`, [svc, a.tenant]);
    await db.query(`insert into principal (tenant_id, kind, name, auth_user_id) values ($1, 'user', 'Not a person', $2)`, [a.tenant, svc]);
    await setClaims(db, { sub: svc, tenant_id: a.tenant, aal: 'aal1' });
    await expectCode(db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify(dsj(a))]), 'MEMBERSHIP_KIND_MISMATCH');
  });
});
