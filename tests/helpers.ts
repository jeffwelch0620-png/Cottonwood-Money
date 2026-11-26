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
  entityA: string;
  entityB: string;
  locA1: string;
  locA2: string;
  locB1: string;
  acct: Record<'cash' | 'clearing' | 'ap' | 'sales' | 'cogs' | 'dueFrom' | 'dueTo' | 'inactive', string>;
  periods: Record<'sepA' | 'octA' | 'novA' | 'decA' | 'novB', string>;
  doc: string;
}

/** Builds a complete tenant using the app role (which also proves the app's grants work). */
export async function makeFixture(db: pg.ClientBase): Promise<Fixture> {
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0].id as string;

  const tenant = await one(`insert into tenant (name) values ($1) returning id`, [`Test group ${randomUUID().slice(0, 8)}`]);
  const principal = (kind: string, name: string) =>
    one(`insert into principal (tenant_id, kind, name) values ($1,$2,$3) returning id`, [tenant, kind, name]);
  const user1 = await principal('user', 'Controller');
  const user2 = await principal('user', 'Owner');
  const agent = await principal('agent', 'AP agent v1');
  const integration = await principal('integration', 'Toast connector');

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

  return { tenant, user1, user2, agent, integration, entityA, entityB, locA1, locA2, locB1, acct, periods, doc };
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

export async function post(db: pg.ClientBase, entry: unknown) {
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
