// Phase 1 step 1.1: integration base. Acceptance (Phase 1 Build Spec §6, step 1.1):
//   1. re-running a sync posts nothing twice
//   2. evidence can't be overwritten or deleted before retention ends
//   3. app_role can't read connector secrets
//   4. a failed job retries, then stops with a recorded error
// Every refusal below comes from the database (or from S3 Object Lock, for stored bytes).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { appClient, superClient, makeFixture, actAs, authOf, expectCode, count, TEST_URL, type Fixture } from './helpers.js';
import {
  Worker, MemoryWormStore, S3WormStore, EvidenceError, sealSecret, openSecret, sha256, storeEvidence,
  defaultHandlers, enqueueDueSyncs, sampleDay, defaultRetainUntil, type Handler,
} from '../modules/integration/index.js';
import { withSession } from '../modules/auth/index.js';

let db: pg.Client;    // app_role
let su: pg.Client;    // superuser: inspection and simulated attacks only
let pool: pg.Pool;    // what the worker process connects with
let f: Fixture;
let store: MemoryWormStore;
let pos: string;      // sample POS connector (entity A, store 1)
const key = { id: 'k1', key: randomBytes(32) };

async function asWorker<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role worker_role');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const worker = (id: string, handlers: Record<string, Handler> = defaultHandlers, extra: Partial<ConstructorParameters<typeof Worker>[0]> = {}) =>
  new Worker({ pool, workerId: id, store, handlers, keys: [key], retryInSeconds: () => 0, ...extra });

async function newConnector(over: Record<string, unknown> = {}) {
  await actAs(db, f.user2);
  return (await db.query('select integration.create_connector($1::jsonb) id', [JSON.stringify({
    kind: 'sample_pos', name: `Sample POS ${randomUUID().slice(0, 6)}`, entity_id: f.entityA, run_as: f.integration,
    config: { location_id: f.locA1, accounts: { clearing: f.acct.clearing, sales: f.acct.sales } }, ...over,
  })])).rows[0].id as string;
}

async function requestSync(connector: string, scope: string) {
  await actAs(db, f.user2);
  return (await db.query('select integration.request_sync($1, $2) id', [connector, scope])).rows[0].id as string;
}

/** Runs every ready job; returns the outcomes for the given job ids, in order. */
async function runJobs(w: Worker, ids: string[]) {
  return (await w.drain()).filter((r) => r.outcome !== 'idle' && ids.includes(r.jobId));
}

beforeAll(async () => {
  db = await appClient();
  su = await superClient();
  pool = new pg.Pool({ connectionString: TEST_URL, max: 10 });
  f = await makeFixture(db);
  store = new MemoryWormStore();
  pos = await newConnector();
});
afterAll(async () => {
  // Leave nothing queued for other test files' workers.
  await su.query(`update integration.job set status = 'dead', finished_at = now(), last_error = 'test teardown',
                   locked_by = null, locked_until = null where status in ('queued', 'running')`);
  await pool.end();
  await db.end();
  await su.end();
});

describe('1. re-running a sync posts nothing twice', () => {
  it('the same business day synced twice: one entry, one evidence file, two recorded runs', async () => {
    const w = worker('w-sync');
    const j1 = await requestSync(pos, '2026-11-20');
    const [r1] = await runJobs(w, [j1]);
    expect(r1).toMatchObject({ outcome: 'succeeded', result: { posted: 1, already_posted: 0, evidence_new: 1 } });

    const j2 = await requestSync(pos, '2026-11-20');
    const [r2] = await runJobs(w, [j2]);
    expect(r2).toMatchObject({ outcome: 'succeeded', result: { posted: 0, already_posted: 1, evidence_new: 0, evidence_existing: 1 } });

    const k = `sync:${pos}:2026-11-20:dsj:${f.locA1}`;
    expect(await count(su, 'select count(*) n from ledger.journal_entry where idempotency_key = $1', [k])).toBe(1);
    const sha = sha256(Buffer.from(JSON.stringify({ ...sampleDay(pos, '2026-11-20'), location_id: f.locA1 })));
    expect(await count(su, 'select count(*) n from source_document where tenant_id = $1 and sha256 = $2', [f.tenant, sha])).toBe(1);
    expect(await count(su, `select count(*) n from integration.sync_run where connector_id = $1 and scope_key = '2026-11-20' and status = 'succeeded'`, [pos])).toBe(2);

    // The posted entry carries the integration as creator and the stored file as evidence.
    const e = (await su.query(`select je.created_by, je.source_type, ee.source_document_id, sd.doc_type
                                 from ledger.journal_entry je join ledger.entry_evidence ee on ee.entry_id = je.id
                                 join source_document sd on sd.id = ee.source_document_id where je.idempotency_key = $1`, [k])).rows[0];
    expect(e).toMatchObject({ created_by: f.integration, source_type: 'pos_dsj', doc_type: 'pos_eod' });
  });

  it('even bypassing the pre-check, the database returns the original entry for a repeated key', async () => {
    const k = `sync:${pos}:2026-11-20:dsj:${f.locA1}`;
    const before = await count(su, 'select count(*) n from ledger.journal_entry where tenant_id = $1', [f.tenant]);
    const orig = (await su.query('select id from ledger.journal_entry where idempotency_key = $1', [k])).rows[0].id;
    const doc = (await su.query('select source_document_id id from ledger.entry_evidence where entry_id = $1', [orig])).rows[0].id;
    await actAs(db, f.integration);
    const r = (await db.query('select ledger.post_entry($1::jsonb) r', [JSON.stringify({
      tenant_id: f.tenant, entity_id: f.entityA, entry_date: '2026-11-20', source_type: 'pos_dsj', idempotency_key: k,
      actor_type: 'integration', created_by: f.integration, evidence_ids: [doc],
      lines: [{ account_id: f.acct.clearing, location_id: f.locA1, debit: '1' }, { account_id: f.acct.sales, location_id: f.locA1, credit: '1' }],
    })])).rows[0].r;
    expect(r.id).toBe(orig);
    expect(await count(su, 'select count(*) n from ledger.journal_entry where tenant_id = $1', [f.tenant])).toBe(before);
  });

  it('the nightly scheduler is repeat-safe: one job per connector per day', async () => {
    const first = await enqueueDueSyncs(pool, '2026-11-21');
    const second = await enqueueDueSyncs(pool, '2026-11-21');
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0);
    expect(await count(su, `select count(*) n from integration.job where connector_id = $1 and dedupe_key = $2`, [pos, `sync:${pos}:2026-11-21`])).toBe(1);
  });

  it('one running run per connector and scope; a vanished worker\'s run stops blocking once its lease passes', async () => {
    await actAs(db, f.integration);
    const run = (await db.query(`select integration.start_sync_run($1, '2026-11-22') id`, [pos])).rows[0].id;
    await expectCode(db.query(`select integration.start_sync_run($1, '2026-11-22')`, [pos]), 'SYNC_RUNNING');
    await db.query(`select integration.start_sync_run($1, '2026-11-23')`, [pos]); // other scope: fine
    // The worker died; time passes beyond the run's lease (simulated by the superuser clock).
    await su.query(`update integration.sync_run set lease_until = now() - interval '1 second' where id = $1`, [run]);
    const next = (await db.query(`select integration.start_sync_run($1, '2026-11-22') id`, [pos])).rows[0].id;
    expect(next).not.toBe(run);
    expect((await su.query('select status from integration.sync_run where id = $1', [run])).rows[0].status).toBe('abandoned');
    await expectCode(db.query(`select integration.finish_sync_run($1, 'succeeded')`, [run]), 'SYNC_FINISHED');
  });

  it("only the connector's integration (or an owner/controller) runs its sync", async () => {
    await actAs(db, f.clerk);
    await expectCode(db.query(`select integration.start_sync_run($1, '2026-11-24')`, [pos]), 'ROLE_FORBIDDEN');
    const other = await makeFixture(db);
    await expectCode(db.query(`select integration.start_sync_run($1, '2026-11-24')`, [pos]), 'NO_CONNECTOR');
    await actAs(db, other.integration);
    await expectCode(db.query(`select integration.start_sync_run($1, '2026-11-24')`, [pos]), 'NO_CONNECTOR');
  });

  it('a paused connector is not synced: no manual request, and queued jobs wait', async () => {
    const c = await newConnector();
    const j = await requestSync(c, '2026-11-25');
    await actAs(db, f.user2);
    await db.query(`select integration.set_connector_status($1, 'paused')`, [c]);
    await expectCode(db.query(`select integration.request_sync($1, '2026-11-25')`, [c]), 'CONNECTOR_INACTIVE');
    await runJobs(worker('w-paused'), []);
    expect((await su.query('select status from integration.job where id = $1', [j])).rows[0].status).toBe('queued');
    await db.query(`select integration.set_connector_status($1, 'active')`, [c]);
    const [r] = await runJobs(worker('w-paused'), [j]);
    expect(r.outcome).toBe('succeeded');
  });
});

describe('2. evidence cannot be overwritten or deleted before retention ends', () => {
  it('evidence records are insert-only, even for the table owner', async () => {
    const id = (await su.query('select id from integration.evidence_object where tenant_id = $1 limit 1', [f.tenant])).rows[0].id;
    await su.query('begin');
    await su.query('set local role ledger_owner');
    await expect(su.query(`update integration.evidence_object set object_key = 'elsewhere' where id = $1`, [id])).rejects.toThrow(/^IMMUTABLE/);
    await su.query('rollback');
    await su.query('begin');
    await su.query('set local role ledger_owner');
    await expect(su.query(`delete from integration.evidence_object where id = $1`, [id])).rejects.toThrow(/^IMMUTABLE/);
    await su.query('rollback');
    await actAs(db, f.user2);
    await expect(db.query(`update integration.evidence_object set object_key = 'x' where id = $1`, [id])).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from integration.evidence_object where id = $1`, [id])).rejects.toThrow(/permission denied/);
  });

  it('the database refuses evidence locked for less than 7 years, bad hashes, and viewers', async () => {
    const ev = (over: Record<string, unknown>) => JSON.stringify({
      doc_type: 'invoice', sha256: sha256(randomBytes(8)).toString('hex'), size_bytes: 8, content_type: 'application/pdf',
      backend: 's3', bucket: 'b', object_key: 'k', retain_until: defaultRetainUntil().toISOString(), ...over,
    });
    await actAs(db, f.integration);
    const shortly = new Date(Date.now() + 365 * 86400_000).toISOString();
    await expectCode(db.query('select integration.register_evidence($1::jsonb)', [ev({ retain_until: shortly })]), 'RETENTION_TOO_SHORT');
    await expectCode(db.query('select integration.register_evidence($1::jsonb)', [ev({ sha256: 'abc' })]), 'BAD_SHA256');
    await actAs(db, f.viewer);
    await expectCode(db.query('select integration.register_evidence($1::jsonb)', [ev({})]), 'ROLE_FORBIDDEN');
  });

  it('the same bytes always resolve to the same source document', async () => {
    const bytes = Buffer.from(`invoice ${randomUUID()}`);
    const one = await withSession(pool, claimsOf(f.integration), (c) =>
      storeEvidence(c, store, { tenantId: f.tenant, docType: 'invoice', bytes, contentType: 'text/plain' }), { role: 'app_role' });
    const two = await withSession(pool, claimsOf(f.integration), (c) =>
      storeEvidence(c, store, { tenantId: f.tenant, docType: 'invoice', bytes, contentType: 'text/plain' }), { role: 'app_role' });
    expect(one.existed).toBe(false);
    expect(two).toEqual({ ...one, existed: true });
    // and the stored bytes come back exactly
    expect(sha256(await store.get(`${f.tenant}/${one.sha256}`)).toString('hex')).toBe(one.sha256);
  });

  it('storage: no overwrite with different bytes; no delete before retain-until', async () => {
    let now = new Date('2026-11-27T00:00:00Z');
    const s = new MemoryWormStore('test', () => now);
    const until = new Date('2033-11-28T00:00:00Z');
    await s.put('t/a', Buffer.from('original'), { contentType: 'text/plain', retainUntil: until });
    expect((await s.put('t/a', Buffer.from('original'), { contentType: 'text/plain', retainUntil: until })).existed).toBe(true);
    await expect(s.put('t/a', Buffer.from('forged'), { contentType: 'text/plain', retainUntil: until })).rejects.toThrow(/^EVIDENCE_COLLISION/);
    await expect(s.delete('t/a', null)).rejects.toThrow(/^OBJECT_LOCKED/);
    expect((await s.get('t/a')).toString()).toBe('original');
    now = new Date('2033-11-28T00:00:01Z');
    await s.delete('t/a', null);
    await expect(s.get('t/a')).rejects.toThrow(/^EVIDENCE_MISSING/);
  });

  it('S3: every upload is COMPLIANCE-locked, no-overwrite, and checksum-verified', async () => {
    const sent: any[] = [];
    const bytes = Buffer.from('pos file');
    const checksum = sha256(bytes).toString('base64');
    let exists = false;
    const client = {
      async send(cmd: any) {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'PutObjectCommand') {
          if (exists) throw Object.assign(new Error('precondition'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
          exists = true;
          return { VersionId: 'v1' };
        }
        if (cmd.constructor.name === 'HeadObjectCommand') return { ChecksumSHA256: checksum, VersionId: 'v1' };
        throw new Error('unexpected');
      },
    };
    const s3 = new S3WormStore('evidence-prod', client);
    const until = defaultRetainUntil();
    expect(await s3.put('t/x', bytes, { contentType: 'application/json', retainUntil: until }))
      .toEqual({ backend: 's3', bucket: 'evidence-prod', key: 't/x', versionId: 'v1', existed: false });
    expect(sent[0]).toMatchObject({ name: 'PutObjectCommand', input: {
      Bucket: 'evidence-prod', Key: 't/x', IfNoneMatch: '*', ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: until, ChecksumSHA256: checksum } });
    // Second put of the same bytes: S3 refuses the overwrite; the store confirms it is identical.
    expect((await s3.put('t/x', bytes, { contentType: 'application/json', retainUntil: until })).existed).toBe(true);
    expect(sent[2]).toMatchObject({ name: 'HeadObjectCommand', input: { ChecksumMode: 'ENABLED' } });
    // Different bytes under an existing key: refused.
    await expect(s3.put('t/x', Buffer.from('forged'), { contentType: 'application/json', retainUntil: until }))
      .rejects.toBeInstanceOf(EvidenceError);
  });
});

describe('3. app_role cannot read connector secrets', () => {
  const plaintext = 'toast-client-secret-' + randomUUID();
  let jobId: string;

  beforeAll(async () => {
    const sealed = sealSecret(plaintext, pos, key);
    await actAs(db, f.user2);
    await db.query('select integration.set_connector_secret($1, $2, $3)', [pos, sealed.ciphertext, sealed.keyId]);
  });

  it('no role a person or integration logs in as can select the secrets table', async () => {
    for (const p of [f.user2, f.user1, f.integration]) {
      await actAs(db, p);
      await expect(db.query('select * from integration.connector_secret')).rejects.toThrow(/permission denied/);
      await expect(db.query('select ciphertext from integration.connector_secret')).rejects.toThrow(/permission denied/);
    }
    await expect(db.query('select * from integration.read_secret($1, $2)', [randomUUID(), 'x'])).rejects.toThrow(/permission denied/);
  });

  it('only ciphertext is stored, and the audit trail records the change without it', async () => {
    const row = (await su.query('select ciphertext, key_id from integration.connector_secret where connector_id = $1', [pos])).rows[0];
    expect(row.key_id).toBe('k1');
    expect(row.ciphertext.includes(Buffer.from(plaintext))).toBe(false);
    const ev = (await su.query(`select detail from audit.event where object_id = $1 and action = 'connector.secret_set'`, [pos])).rows[0].detail;
    expect(Object.keys(ev).sort()).toEqual(['bytes', 'key_id']);
  });

  it('the database refuses plaintext, and setting secrets needs an owner or controller', async () => {
    await actAs(db, f.user2);
    await expectCode(db.query('select integration.set_connector_secret($1, $2, $3)', [pos, Buffer.from(plaintext), 'k1']), 'NOT_ENCRYPTED');
    await actAs(db, f.integration);
    const sealed = sealSecret('x', pos, key);
    await expectCode(db.query('select integration.set_connector_secret($1, $2, $3)', [pos, sealed.ciphertext, 'k1']), 'ROLE_FORBIDDEN');
  });

  it('the worker reads it only while holding the lease on a job for that connector', async () => {
    await asWorker((c) => expectCode(c.query('select * from integration.read_secret($1, $2)', [randomUUID(), 'w']), 'NO_JOB'));
    jobId = await requestSync(pos, 'secret-check');
    let seen: string | null = null;
    const w = worker('w-secret', { 'sync:sample_pos': async (ctx) => {
      seen = await ctx.secret();
      // Another worker id cannot read it while this one holds the job.
      await asWorker((c) => expectCode(c.query('select * from integration.read_secret($1, $2)', [ctx.job.job_id, 'w-thief']), 'LEASE_LOST'));
      return {};
    } });
    const [r] = await runJobs(w, [jobId]);
    expect(r.outcome).toBe('succeeded');
    expect(seen).toBe(plaintext);
    // Job finished: the lease is gone, so the secret is no longer readable for it.
    await asWorker((c) => expectCode(c.query('select * from integration.read_secret($1, $2)', [jobId, 'w-secret']), 'LEASE_LOST'));
  });

  it('a ciphertext copied to another connector does not decrypt', () => {
    const sealed = sealSecret(plaintext, pos, key);
    expect(openSecret(sealed.ciphertext, 'k1', pos, [key])).toBe(plaintext);
    expect(() => openSecret(sealed.ciphertext, 'k1', randomUUID(), [key])).toThrow();
  });

  it('worker_role has no table access at all', async () => {
    for (const t of ['integration.job', 'integration.connector_secret', 'ledger.journal_entry', 'public.source_document']) {
      await expect(asWorker((c) => c.query(`select 1 from ${t} limit 1`))).rejects.toThrow(/permission denied/);
    }
  });

  it('connector config refuses anything that looks like a credential', async () => {
    await expectCode(newConnector({ config: { api_key: 'x' } }), 'SECRET_IN_CONFIG');
    await expectCode(newConnector({ config: { auth: [{ clientSecret: 'x' }] } }), 'SECRET_IN_CONFIG');
    await expectCode(newConnector({ run_as: f.user1 }), 'BAD_RUN_AS');   // a person
    await expectCode(newConnector({ run_as: f.agent }), 'BAD_RUN_AS');   // an agent
    await actAs(db, f.clerk);
    await expectCode(db.query('select integration.create_connector($1::jsonb)', [JSON.stringify({ kind: 'sample_pos', name: 'x', run_as: f.integration })]), 'ROLE_FORBIDDEN');
  });
});

describe('4. a failed job retries, then stops with a recorded error', () => {
  const failing: Handler = async (ctx) => { throw new Error(`TOAST_DOWN: attempt ${ctx.job.attempt} got 503`); };

  it('5 attempts, each recorded with its error; then dead with the last error', async () => {
    const c = await newConnector();
    const j = await requestSync(c, '2026-11-26');
    const results = await runJobs(worker('w-fail', { 'sync:sample_pos': failing }), [j]);
    expect(results.map((r) => r.outcome === 'failed' && r.status)).toEqual(['queued', 'queued', 'queued', 'queued', 'dead']);
    const job = (await su.query('select status, attempts, last_error, finished_at from integration.job where id = $1', [j])).rows[0];
    expect(job).toMatchObject({ status: 'dead', attempts: 5, last_error: 'TOAST_DOWN: attempt 5 got 503' });
    const attempts = (await su.query('select attempt_no, outcome, error from integration.job_attempt where job_id = $1 order by attempt_no', [j])).rows;
    expect(attempts).toEqual([1, 2, 3, 4, 5].map((n) => ({ attempt_no: n, outcome: 'failed', error: `TOAST_DOWN: attempt ${n} got 503` })));
    // A dead job is never picked up again, and can't be completed after the fact.
    expect((await runJobs(worker('w-fail'), [j])).length).toBe(0);
    await asWorker((c2) => expectCode(c2.query(`select integration.complete_job($1, 'w-fail')`, [j]), 'LEASE_LOST'));
  });

  it('without an override the database backs off before the retry', async () => {
    const c = await newConnector();
    const j = await requestSync(c, '2026-11-26');
    const [r] = await runJobs(worker('w-backoff', { 'sync:sample_pos': failing }, { retryInSeconds: () => undefined }), [j]);
    expect(r).toMatchObject({ outcome: 'failed', status: 'queued' });
    const wait = Number((await su.query(`select extract(epoch from run_after - now()) s from integration.job where id = $1`, [j])).rows[0].s);
    expect(wait).toBeGreaterThan(25);
    expect(wait).toBeLessThanOrEqual(30);
  });

  it('a worker that stops responding loses the job: the lapse is a recorded attempt, and its late result is refused', async () => {
    const c = await newConnector();
    const j = await requestSync(c, '2026-11-26');
    const w1 = worker('w-crash');
    const claimed = await w1.claim();
    expect(claimed?.job_id).toBe(j);
    await su.query(`update integration.job set locked_until = now() - interval '1 second' where id = $1`, [j]); // time passes
    // The next claim sweeps the lapsed lease: a failed attempt, requeued with backoff (crashes may be the job's fault).
    const rescuer = worker('w-rescue');
    await rescuer.drain();
    const swept = (await su.query(`select status, extract(epoch from run_after - now()) s from integration.job where id = $1`, [j])).rows[0];
    expect(swept.status).toBe('queued');
    expect(Number(swept.s)).toBeGreaterThan(25);
    await su.query(`update integration.job set run_after = now() where id = $1`, [j]); // backoff passes
    const [r] = await runJobs(rescuer, [j]);
    expect(r.outcome).toBe('succeeded');
    const attempts = (await su.query('select attempt_no, worker, outcome, error from integration.job_attempt where job_id = $1 order by attempt_no', [j])).rows;
    expect(attempts).toMatchObject([
      { attempt_no: 1, worker: 'w-crash', outcome: 'lease_expired', error: expect.stringMatching(/^LEASE_EXPIRED/) },
      { attempt_no: 2, worker: 'w-rescue', outcome: 'succeeded', error: null },
    ]);
    await asWorker((c2) => expectCode(c2.query(`select integration.complete_job($1, 'w-crash')`, [j]), 'LEASE_LOST'));
    await asWorker((c2) => expectCode(c2.query(`select integration.fail_job($1, 'w-crash', 'late')`, [j]), 'LEASE_LOST'));
  });

  it('parallel workers never run the same job twice', async () => {
    const c = await newConnector();
    const ids: string[] = [];
    for (let d = 1; d <= 12; d++) ids.push(await requestSync(c, `2026-11-${String(d).padStart(2, '0')}`));
    const slow: Handler = async () => { await new Promise((r) => setTimeout(r, 30)); return {}; };
    const results = (await Promise.all([1, 2, 3, 4].map((n) => worker(`w-par${n}`, { 'sync:sample_pos': slow }).drain()))).flat();
    const mine = results.filter((r) => r.outcome === 'succeeded' && ids.includes(r.jobId));
    expect(mine.length).toBe(12);
    expect(new Set(mine.map((r) => r.outcome !== 'idle' && r.jobId)).size).toBe(12);
    // the race happened: more than one worker did some of the work
    const workers = (await su.query('select count(distinct worker) n from integration.job_attempt where job_id = any($1)', [ids])).rows[0].n;
    expect(Number(workers)).toBeGreaterThan(1);
    expect(await count(su, `select count(*) n from integration.job_attempt where job_id = any($1)`, [ids])).toBe(12);
  });

  it('the attempt log is insert-only, and app_role cannot touch the queue', async () => {
    await su.query('begin');
    await su.query('set local role ledger_owner');
    await expect(su.query(`update integration.job_attempt set error = 'rewritten'`)).rejects.toThrow(/^IMMUTABLE/);
    await su.query('rollback');
    await actAs(db, f.user2);
    await expect(db.query(`update integration.job set status = 'succeeded'`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from integration.claim_job('me')`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select integration.enqueue_due_syncs('2026-11-27')`)).rejects.toThrow(/permission denied/);
  });
});

describe('nightly manifest export', () => {
  it('records each entity chain head and verification in a locked evidence file', async () => {
    await actAs(db, f.user2);
    const c = (await db.query('select integration.create_connector($1::jsonb) id', [JSON.stringify({
      kind: 'manifest_export', name: 'Nightly manifest', run_as: f.integration })])).rows[0].id;
    const j = await requestSync(c, '2026-11-27');
    const [r] = await runJobs(worker('w-manifest'), [j]);
    expect(r).toMatchObject({ outcome: 'succeeded', result: { entities: 2, broken_chains: 0, evidence_new: 1 } });
    const doc = (await su.query(`select sd.extracted, eo.object_key from source_document sd
                                   join integration.evidence_object eo on eo.source_document_id = sd.id
                                  where sd.tenant_id = $1 and sd.doc_type = 'chain_manifest'`, [f.tenant])).rows[0];
    const file = JSON.parse((await store.get(doc.object_key)).toString());
    const head = (await su.query('select seq, encode(hash, $2) hash from ledger.journal_entry where entity_id = $1 order by seq desc limit 1', [f.entityA, 'hex'])).rows[0];
    expect(file.entities.find((e: any) => e.entity_id === f.entityA)).toMatchObject({ seq: Number(head.seq), hash: head.hash, chain_ok: true });
    expect(await count(su, 'select count(*) n from ledger.chain_manifest where entity_id = $1 and seq = $2', [f.entityA, head.seq])).toBe(1);
  });

  it('a tampered chain fails the job loudly, and the manifest showing it is still kept', async () => {
    const t = await makeFixture(db);
    await actAs(db, t.integration);
    await db.query('select ledger.post_entry($1::jsonb)', [JSON.stringify({
      tenant_id: t.tenant, entity_id: t.entityA, entry_date: '2026-11-20', source_type: 'pos_dsj', idempotency_key: randomUUID(),
      actor_type: 'integration', created_by: t.integration, evidence_ids: [t.doc],
      lines: [{ account_id: t.acct.clearing, location_id: t.locA1, debit: '10' }, { account_id: t.acct.sales, location_id: t.locA1, credit: '10' }] })]);
    await su.query('begin');
    await su.query('set local session_replication_role = replica');
    await su.query(`update ledger.journal_line set debit = debit + 1 where entity_id = $1 and debit > 0`, [t.entityA]);
    await su.query('commit');
    await actAs(db, t.user2);
    const c = (await db.query('select integration.create_connector($1::jsonb) id', [JSON.stringify({
      kind: 'manifest_export', name: 'Nightly manifest', run_as: t.integration })])).rows[0].id;
    const j = (await db.query(`select integration.request_sync($1, '2026-11-27') id`, [c])).rows[0].id;
    const results = await runJobs(worker('w-tamper', defaultHandlers, { retryInSeconds: () => 3600 }), [j]);
    expect(results[0]).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/^CHAIN_BROKEN/) });
    expect(await count(su, `select count(*) n from source_document where tenant_id = $1 and doc_type = 'chain_manifest'`, [t.tenant])).toBe(1);
    expect((await su.query(`select status, error from integration.sync_run where connector_id = $1`, [c])).rows[0]).toMatchObject({ status: 'failed' });
  });
});

/** Session claims for an integration principal (service logins don't use MFA). */
function claimsOf(principal: string) {
  return { sub: authOf(principal), tenant_id: f.tenant, aal: 'aal1' as const };
}
