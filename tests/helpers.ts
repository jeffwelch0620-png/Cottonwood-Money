import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { expect } from 'vitest';

const BASE = process.env.PG_BASE_URL ?? 'postgres://postgres:postgres@localhost:5432';
export const TEST_DB = 'ledger_test';
export const ADMIN_URL = `${BASE}/postgres`;
export const TEST_URL = `${BASE}/${TEST_DB}`;

/** A connection acting as the application: SET ROLE app_role. */
export async function appClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query('set role app_role');
  return c;
}

/** A pool of app_role connections, for concurrency tests. */
export function appPool(max = 20): pg.Pool {
  const p = new pg.Pool({ connectionString: TEST_URL, max });
  p.on('connect', (c) => {
    c.query('set role app_role');
  });
  return p;
}

/** Sets (or clears, with null) the JWT claims for this session, as Supabase/PostgREST would. */
export async function setClaims(db: pg.ClientBase, claims: Record<string, unknown> | null) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims ? JSON.stringify(claims) : '']);
}

/** principal id -> its login and tenant, so tests can act as any fixture principal. */
const actors = new Map<string, { auth: string; tenant: string }>();

/** Act as a fixture principal: verified member of its tenant, MFA complete unless overridden. */
export async function actAs(db: pg.ClientBase, principalId: string, over: Record<string, unknown> = {}) {
  const a = actors.get(principalId);
  if (!a) throw new Error(`no login registered for principal ${principalId}`);
  await setClaims(db, { sub: a.auth, tenant_id: a.tenant, aal: 'aal2', role: 'authenticated', ...over });
}

export function authOf(principalId: string) {
  const a = actors.get(principalId);
  if (!a) throw new Error(`no login registered for principal ${principalId}`);
  return a.auth;
}

/** Creates Supabase-style auth users (in production, Supabase Auth does this). */
export async function createAuthUsers(n: number): Promise<string[]> {
  const su = await superClient();
  try {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push((await su.query(`insert into auth.users (email) values ($1) returning id`, [`u${randomUUID()}@test.local`])).rows[0].id);
    }
    return ids;
  } finally {
    await su.end();
  }
}

/** A superuser connection: used only to simulate attackers and to inspect. */
export async function superClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: TEST_URL });
  await c.connect();
  return c;
}

export interface Fixture {
  tenant: string;
  user1: string;
  user2: string;
  agent: string;
  integration: string;
  clerk: string;   // bookkeeper, location A1 only, approval limit 1000
  viewer: string;
  entityA: string;
  entityB: string;
  locA1: string;
  locA2: string;
  locB1: string;
  acct: Record<'cash' | 'clearing' | 'ap' | 'sales' | 'cogs' | 'dueFrom' | 'dueTo' | 'inactive', string>;
  periods: Record<'sepA' | 'octA' | 'novA' | 'decA' | 'novB', string>;
  doc: string;
}

/**
 * Builds a complete tenant through the app role, the way the product will: the owner signs
 * up (app.create_tenant), then adds members and principals under RLS. Leaves the session
 * acting as the owner.
 */
export async function makeFixture(db: pg.ClientBase): Promise<Fixture> {
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].id as string;

  const [ownerAuth, controllerAuth, agentAuth, integrationAuth, clerkAuth, viewerAuth] = await createAuthUsers(6);
  await setClaims(db, { sub: ownerAuth, aal: 'aal2' });
  const tenant = await one(`select app.create_tenant($1, 'Owner') as id`, [`Test group ${randomUUID().slice(0, 8)}`]);
  await setClaims(db, { sub: ownerAuth, tenant_id: tenant, aal: 'aal2' });
  const user2 = await one(`select id from principal where tenant_id = $1 and auth_user_id = $2`, [tenant, ownerAuth]);
  actors.set(user2, { auth: ownerAuth, tenant });

  const member = (auth: string, role: string, extra: { location_ids?: string[]; approval_limit?: string } = {}) =>
    db.query(`insert into membership (user_id, tenant_id, role, location_ids, approval_limit) values ($1,$2,$3,$4,$5)`,
      [auth, tenant, role, extra.location_ids ?? null, extra.approval_limit ?? null]);
  const principal = async (kind: string, name: string, auth: string) => {
    const id = await one(`insert into principal (tenant_id, kind, name, auth_user_id) values ($1,$2,$3,$4) returning id`,
      [tenant, kind, name, auth]);
    actors.set(id, { auth, tenant });
    return id;
  };
  await member(controllerAuth, 'controller');
  await member(agentAuth, 'service');
  await member(integrationAuth, 'service');
  await member(viewerAuth, 'viewer');
  const user1 = await principal('user', 'Controller', controllerAuth);
  const agent = await principal('agent', 'AP agent v1', agentAuth);
  const integration = await principal('integration', 'Toast connector', integrationAuth);
  const viewer = await principal('user', 'Read-only investor', viewerAuth);

  const entity = (name: string) =>
    one(`insert into entity (tenant_id, legal_name) values ($1,$2) returning id`, [tenant, name]);
  const entityA = await entity('Concept A LLC');
  const entityB = await entity('Commissary LLC');

  const location = (e: string, name: string) =>
    one(`insert into location (tenant_id, entity_id, name) values ($1,$2,$3) returning id`, [tenant, e, name]);
  const locA1 = await location(entityA, 'Store 1');
  const locA2 = await location(entityA, 'Store 2');
  const locB1 = await location(entityB, 'Central kitchen');

  const account = (number: string, name: string, type: string, nb: string, cashView: string, ic = false, active = true) =>
    one(
      `insert into account (tenant_id, number, name, type, normal_balance, cash_view, is_intercompany, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [tenant, number, name, type, nb, cashView, ic, active],
    );
  const acct = {
    cash: await account('1010', 'Operating cash', 'asset', 'D', 'always'),
    clearing: await account('1210', 'Card clearing', 'asset', 'D', 'always'),
    dueFrom: await account('1910', 'Due from affiliates', 'asset', 'D', 'never', true),
    ap: await account('2010', 'Accounts payable', 'liability', 'C', 'never'),
    dueTo: await account('2910', 'Due to affiliates', 'liability', 'C', 'never', true),
    sales: await account('4010', 'Food sales', 'revenue', 'C', 'settle'),
    cogs: await account('5010', 'Food cost', 'expense', 'D', 'settle'),
    inactive: await account('6999', 'Retired account', 'expense', 'D', 'settle', false, false),
  };

  const period = (e: string, start: string, end: string) =>
    one(`insert into period (tenant_id, entity_id, start_date, end_date) values ($1,$2,$3,$4) returning id`, [tenant, e, start, end]);
  const periods = {
    sepA: await period(entityA, '2026-09-01', '2026-09-30'),
    octA: await period(entityA, '2026-10-01', '2026-10-31'),
    novA: await period(entityA, '2026-11-01', '2026-11-30'),
    decA: await period(entityA, '2026-12-01', '2026-12-31'),
    novB: await period(entityB, '2026-11-01', '2026-11-30'),
  };
  await db.query(`update period set status = 'soft' where id = $1`, [periods.octA]);
  await db.query(`update period set status = 'soft' where id = $1`, [periods.sepA]);
  await db.query(`update period set status = 'hard' where id = $1`, [periods.sepA]);

  const doc = await one(
    `insert into source_document (tenant_id, doc_type, storage_uri, sha256) values ($1,'pos_eod',$2,$3) returning id`,
    [tenant, `s3://evidence/${randomUUID()}.json`, createHash('sha256').update(randomUUID()).digest()],
  );

  await member(clerkAuth, 'bookkeeper', { location_ids: [locA1], approval_limit: '1000' });
  const clerk = await principal('user', 'Store 1 bookkeeper', clerkAuth);

  return { tenant, user1, user2, agent, integration, clerk, viewer, entityA, entityB, locA1, locA2, locB1, acct, periods, doc };
}

/** A valid daily-sales entry for entity A; override any field. */
export function dsj(f: Fixture, over: Record<string, unknown> = {}) {
  return {
    tenant_id: f.tenant,
    entity_id: f.entityA,
    entry_date: '2026-11-20',
    source_type: 'pos_dsj',
    idempotency_key: `dsj:${randomUUID()}`,
    memo: 'Daily sales journal',
    actor_type: 'integration',
    created_by: f.integration,
    evidence_ids: [f.doc],
    lines: [
      { account_id: f.acct.clearing, location_id: f.locA1, debit: '1250.5000', credit: '0' },
      { account_id: f.acct.sales, location_id: f.locA1, debit: '0', credit: '1250.5000' },
    ],
    ...over,
  };
}

/**
 * Posts an entry. The session acts as `as`, else the entry's approver (approval is given in
 * the approver's own session), else its creator.
 */
export async function post(db: pg.ClientBase, entry: unknown, as?: string) {
  const e = entry as { approved_by?: string; created_by?: string };
  const caller = as ?? e.approved_by ?? e.created_by;
  if (caller && actors.has(caller)) await actAs(db, caller);
  const { rows } = await db.query('select ledger.post_entry($1::jsonb) as r', [JSON.stringify(entry)]);
  return rows[0].r as { id: string; seq: number; hash: string; entity_id: string };
}

/** Asserts the promise rejects with a message starting with the given code. */
export async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toThrow(new RegExp(`^${code}`));
}

export async function count(db: pg.ClientBase, sql: string, params: unknown[] = []) {
  const { rows } = await db.query(sql, params);
  return Number(rows[0].n);
}
