// Phase 0 step 8: the admin/API server, end to end through HTTP with signed JWTs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../apps/api/server.js';
import { appClient, superClient, makeFixture, dsj, post, actAs, authOf, createAuthUsers, expectCode, TEST_URL, type Fixture } from './helpers.js';

const SECRET = 'test-jwt-secret-that-is-at-least-32-bytes';
let app: FastifyInstance;
let pool: pg.Pool;
let db: pg.Client;
let f: Fixture;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL, max: 5 });
  app = await buildServer({ pool, jwtSecret: SECRET, audience: 'authenticated' });
  db = await appClient();
  f = await makeFixture(db);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.end();
});

async function token(sub: string, claims: Record<string, unknown> = {}, opts: { secret?: string; exp?: string } = {}) {
  return new SignJWT({ aal: 'aal2', role: 'authenticated', ...claims })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setAudience('authenticated')
    .setIssuedAt().setExpirationTime(opts.exp ?? '10m')
    .sign(new TextEncoder().encode(opts.secret ?? SECRET));
}
/** A token for a fixture principal, in its tenant. */
const as = (fx: Fixture, principal: string, claims: Record<string, unknown> = {}) =>
  token(authOf(principal), { tenant_id: fx.tenant, ...claims });

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, tok?: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  let body: any = res.body;
  try { body = res.json(); } catch { /* raw body */ }
  return { status: res.statusCode, body, headers: res.headers };
}

describe('authentication', () => {
  it('refuses missing, forged and expired tokens; requires MFA for people', async () => {
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', '/v1/me', await token(authOf(f.user1), { tenant_id: f.tenant }, { secret: 'x'.repeat(40) }))).status).toBe(401);
    expect((await call('GET', '/v1/me', await token(authOf(f.user1), { tenant_id: f.tenant }, { exp: '-1m' }))).status).toBe(401);
    const aal1 = await call('GET', '/v1/me', await as(f, f.user1, { aal: 'aal1' }));
    expect([aal1.status, aal1.body.code]).toEqual([401, 'NOT_AUTHENTICATED']);
    const me = await call('GET', '/v1/me', await as(f, f.user1));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ tenant_id: f.tenant, role: 'controller', principal_id: f.user1, kind: 'user' });
  });

  it('a forged tenant claim gets nothing', async () => {
    const other = await makeFixture(db);
    const r = await call('GET', '/v1/accounts', await token(authOf(f.user1), { tenant_id: other.tenant }));
    expect([r.status, r.body]).toEqual([200, []]);
  });
});

describe('admin flow: sign up, set up, two-person manual JE, close, export', () => {
  it('runs the whole Phase 0 admin journey through the API', async () => {
    const [ownerId, ctrlId] = await createAuthUsers(2);
    // Sign up: no tenant yet.
    const t = await call('POST', '/v1/tenants', await token(ownerId), { name: 'Bistro Group', display_name: 'Pat (owner)' });
    expect(t.status).toBe(200);
    const owner = await token(ownerId, { tenant_id: t.body.tenant_id });
    // Chart of accounts from the template, an entity, a location, a fiscal year.
    const coa = await call('POST', '/v1/coa/template', owner, { template: 'usar' });
    expect(coa.body.added).toBeGreaterThan(50);
    const ent = await call('POST', '/v1/entities', owner, { legal_name: 'Bistro One LLC', fiscal_calendar: '445' });
    expect([ent.status, ent.body.fiscal_calendar]).toEqual([200, '445']);
    const loc = await call('POST', '/v1/locations', owner, { entity_id: ent.body.id, name: 'Main St' });
    const fy = await call('POST', '/v1/fiscal-years', owner, { entity_id: ent.body.id, year: 2026 });
    expect(fy.body).toMatchObject({ start_date: '2025-12-29', end_date: '2027-01-03', periods: 12 });
    // Add a controller.
    const mem = await call('POST', '/v1/members', owner, { user_id: ctrlId, name: 'Chris (controller)', role: 'controller' });
    expect(mem.status).toBe(200);
    const ctrl = await token(ctrlId, { tenant_id: t.body.tenant_id });
    // Controller proposes a manual entry; cannot approve it; the owner approves.
    const accts = (await call('GET', '/v1/accounts', ctrl)).body as { id: string; number: string }[];
    const acc = (n: string) => accts.find((a) => a.number === n)!.id;
    const draft = await call('POST', '/v1/drafts', ctrl, {
      entity_id: ent.body.id, entry_date: '2026-11-20', source_type: 'manual', memo: 'Opening cash',
      lines: [{ account_id: acc('1010'), location_id: loc.body.id, debit: '25000' }, { account_id: acc('3010'), location_id: loc.body.id, credit: '25000' }],
    });
    expect(draft.status).toBe(200);
    const self = await call('POST', `/v1/drafts/${draft.body.draft_id}/approve`, ctrl, {});
    expect([self.status, self.body.code]).toEqual([403, 'SELF_APPROVAL']);
    const ok = await call('POST', `/v1/drafts/${draft.body.draft_id}/approve`, owner, {});
    expect([ok.status, ok.body.seq]).toEqual([200, 1]);
    // JE viewer.
    const je = await call('GET', `/v1/entries/${ok.body.id}`, ctrl);
    expect(je.body).toMatchObject({ seq: 1, hash_ok: true, link_ok: true, approved_by: { name: 'Pat (owner)' }, created_by: { name: 'Chris (controller)' } });
    const list = await call('GET', `/v1/entries?entity_id=${ent.body.id}`, ctrl);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].total).toBe('25000.0000');
    // Reports: money comes back as strings, never JS numbers.
    const tb = await call('GET', `/v1/reports/trial-balance?entity_id=${ent.body.id}&to=2026-12-31`, ctrl);
    expect(tb.body).toMatchObject({ basis: 'accrual', balanced: true });
    expect(tb.body.totals.debits).toBe('25000');
    const bs = await call('GET', `/v1/reports/balance-sheet?entity_id=${ent.body.id}&as_of=2026-12-31&basis=cash`, ctrl);
    expect([bs.body.basis, bs.body.balanced]).toEqual(['cash', true]);
    // Close the first period, two-person reopen.
    const periods = (await call('GET', `/v1/periods?entity_id=${ent.body.id}`, ctrl)).body;
    expect((await call('POST', `/v1/periods/${periods[0].id}/close`, ctrl, { status: 'hard' })).status).toBe(200);
    const rq = await call('POST', `/v1/periods/${periods[0].id}/reopen-requests`, ctrl, { target: 'open', reason: 'Late invoice' });
    expect((await call('POST', `/v1/reopen-requests/${rq.body.request_id}/approve`, ctrl)).body.code).toBe('SELF_APPROVAL');
    expect((await call('POST', `/v1/reopen-requests/${rq.body.request_id}/approve`, owner)).body.status).toBe('open');
    // Chain verifies; audit export with chain status and a hash of the exact bytes.
    expect((await call('GET', `/v1/entities/${ent.body.id}/verify`, ctrl)).body).toMatchObject({ ok: true, checked: 1 });
    const exp = await call('GET', '/v1/audit/export?format=jsonl', owner);
    expect(exp.status).toBe(200);
    expect(exp.headers['x-audit-chain-ok']).toBe('true');
    expect(exp.headers['x-export-sha256']).toBe(createHash('sha256').update(typeof exp.body === 'string' ? exp.body : '').digest('hex'));
    const lines = String(exp.body).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(expect.arrayContaining(
      ['tenant.create', 'coa.template_load', 'membership.insert', 'draft.propose', 'draft.approve', 'ledger.post', 'period.close', 'period.reopen']));
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
    const csv = await call('GET', '/v1/audit/export?format=csv', owner);
    expect(String(csv.body).split('\n')[0]).toBe('seq,at,actor_type,actor_id,actor_name,action,object_type,object_id,detail,prev_hash,hash');
  });
});

describe('error mapping and enforcement', () => {
  it('maps database refusals to HTTP: 400 validation, 403 forbidden/RLS, 404 other tenant, 409 conflicts', async () => {
    const ctrl = await as(f, f.user1);
    expect((await call('POST', '/v1/periods/not-a-uuid/close', ctrl, { status: 'hard' })).status).toBe(400);
    expect((await call('POST', `/v1/periods/${f.periods.novA}/close`, ctrl, { status: 'sealed' })).status).toBe(400);
    const rls = await call('POST', '/v1/members', ctrl, { user_id: (await createAuthUsers(1))[0], name: 'x', role: 'owner' });
    expect([rls.status, rls.body.code]).toEqual([403, 'FORBIDDEN']); // only owners manage members
    const clerk = await call('POST', '/v1/coa/template', await as(f, f.clerk), {});
    expect([clerk.status, clerk.body.code]).toEqual([403, 'ROLE_FORBIDDEN']);
    const other = await makeFixture(db);
    const entry = await post(db, dsj(f));
    const foreign = await call('GET', `/v1/entries/${entry.id}`, await as(other, other.user1));
    expect([foreign.status, foreign.body.code]).toEqual([404, 'UNKNOWN_ENTRY']);
    const patch = await call('PATCH', `/v1/accounts/${f.acct.cogs}`, await as(other, other.user1), { name: 'hijack' });
    expect(patch.status).toBe(404);
    const owner = await as(f, f.user2);
    const last = await call('PATCH', `/v1/members/${(await call('GET', '/v1/members', owner)).body.find((m: { principal_id: string }) => m.principal_id === f.user2).id}`, owner, { role: 'controller' });
    expect([last.status, last.body.code]).toEqual([409, 'LAST_OWNER']);
    const back = await call('POST', `/v1/periods/${f.periods.sepA}/close`, ctrl, { status: 'soft' });
    expect([back.status, back.body.code]).toEqual([409, 'PERIOD_BACKWARD']);
    const exportClerk = await call('GET', '/v1/audit/export', await as(f, f.clerk));
    expect(exportClerk.status).toBe(403);
  });

  it("an account's cash_view is fixed once it has postings (API and database)", async () => {
    const ctrl = await as(f, f.user1);
    const fresh = await call('POST', '/v1/accounts', ctrl, { number: `69${randomUUID().slice(0, 2)}`, name: 'Smallwares', type: 'expense', normal_balance: 'D', cash_view: 'settle' });
    expect((await call('PATCH', `/v1/accounts/${fresh.body.id}`, ctrl, { cash_view: 'always' })).status).toBe(200); // no postings yet
    await post(db, dsj(f)); // sales account now has postings
    const r = await call('PATCH', `/v1/accounts/${f.acct.sales}`, ctrl, { cash_view: 'always' });
    expect([r.status, r.body.code]).toEqual([409, 'ACCOUNT_IMMUTABLE']);
    await actAs(db, f.user1);
    await expectCode(db.query(`update account set cash_view = 'never' where id = $1`, [f.acct.sales]), 'ACCOUNT_IMMUTABLE');
    // Even a superuser with triggers on, and even when the postings are in a location the caller can't see.
    const su = await superClient();
    await expectCode(su.query(`update account set cash_view = 'never' where id = $1`, [f.acct.sales]), 'ACCOUNT_IMMUTABLE');
    await su.end();
  });
});
