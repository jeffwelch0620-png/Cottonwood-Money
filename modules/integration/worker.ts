// Job worker. Queue operations run as worker_role (no tenant claims, no table access); the job's
// actual work runs in an app_role session as the job's run_as integration principal, so the
// ledger's rules apply to integrations exactly as they do to people.
//
//   claim (lease) -> handler -> complete | fail (retry with backoff, then dead with the error)
import type { Pool, PoolClient } from 'pg';
import { withSession } from '../auth/index.js';
import { openSecret, type SecretKey } from './crypto.js';
import type { EvidenceStore } from './evidence-store.js';

export interface ClaimedJob {
  job_id: string;
  tenant_id: string;
  kind: string;
  connector_id: string | null;
  connector_kind: string | null;
  connector_config: Record<string, any> | null;
  entity_id: string | null;
  payload: Record<string, any>;
  attempt: number;
  run_as: string;
  run_as_auth_user: string;
  locked_until: Date;
}

export interface JobContext {
  job: ClaimedJob;
  store: EvidenceStore;
  /** Runs fn in its own transaction, in an app_role session as the job's integration principal. */
  asTenant<T>(fn: (db: PoolClient) => Promise<T>): Promise<T>;
  /** The connector's decrypted credential, or null if none is set. */
  secret(): Promise<string | null>;
  /** Extends the lease (call during long work). */
  heartbeat(): Promise<void>;
}

export type Handler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;

export interface WorkerOptions {
  pool: Pool;
  workerId: string;
  store: EvidenceStore;
  handlers: Record<string, Handler>;
  keys?: SecretKey[];
  leaseSeconds?: number;
  /** Override the database's backoff (seconds until the retry); tests use 0. */
  retryInSeconds?: (attempt: number) => number | undefined;
}

export type RunOutcome =
  | { outcome: 'idle' }
  | { outcome: 'succeeded'; jobId: string; result: Record<string, unknown> }
  | { outcome: 'failed'; jobId: string; status: 'queued' | 'dead'; error: string };

export class Worker {
  constructor(private o: WorkerOptions) {}

  /** Queue calls: one short transaction as worker_role. */
  private async queue<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.o.pool.connect();
    try {
      await db.query('begin');
      await db.query('set local role worker_role');
      const r = await fn(db);
      await db.query('commit');
      return r;
    } catch (err) {
      await db.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      db.release();
    }
  }

  async claim(): Promise<ClaimedJob | null> {
    return this.queue(async (db) => {
      const { rows } = await db.query('select * from integration.claim_job($1, $2)', [this.o.workerId, this.o.leaseSeconds ?? 300]);
      return (rows[0] as ClaimedJob) ?? null;
    });
  }

  context(job: ClaimedJob): JobContext {
    const claims = { sub: job.run_as_auth_user, tenant_id: job.tenant_id, aal: 'aal1' as const, role: 'service' };
    return {
      job,
      store: this.o.store,
      asTenant: (fn) => withSession(this.o.pool, claims, fn, { role: 'app_role' }),
      secret: async () => {
        const row = await this.queue(async (db) =>
          (await db.query('select * from integration.read_secret($1, $2)', [job.job_id, this.o.workerId])).rows[0]);
        if (!row) return null;
        if (!this.o.keys?.length) throw new Error('SECRET_KEYS_MISSING: worker has no CONNECTOR_KEYS');
        return openSecret(row.ciphertext, row.key_id, row.connector_id, this.o.keys);
      },
      heartbeat: async () => {
        await this.queue((db) => db.query('select integration.heartbeat_job($1, $2, $3)', [job.job_id, this.o.workerId, this.o.leaseSeconds ?? 300]));
      },
    };
  }

  /** Claims and runs at most one job. */
  async runOnce(): Promise<RunOutcome> {
    const job = await this.claim();
    if (!job) return { outcome: 'idle' };
    try {
      const handler = this.o.handlers[job.kind === 'connector_sync' ? `sync:${job.connector_kind}` : job.kind];
      if (!handler) throw new Error(`NO_HANDLER: no handler for ${job.kind} ${job.connector_kind ?? ''}`.trim());
      const result = (await handler(this.context(job))) ?? {};
      await this.queue((db) => db.query('select integration.complete_job($1, $2, $3::jsonb)', [job.job_id, this.o.workerId, JSON.stringify(result)]));
      return { outcome: 'succeeded', jobId: job.job_id, result };
    } catch (err) {
      const error = (err as Error).message || String(err);
      const status = await this.queue(async (db) => (await db.query('select integration.fail_job($1, $2, $3, $4) s',
        [job.job_id, this.o.workerId, error, this.o.retryInSeconds?.(job.attempt) ?? null])).rows[0].s);
      return { outcome: 'failed', jobId: job.job_id, status, error };
    }
  }

  /** Runs jobs until none are ready (or max is reached). */
  async drain(max = 1000): Promise<RunOutcome[]> {
    const out: RunOutcome[] = [];
    for (let i = 0; i < max; i++) {
      const r = await this.runOnce();
      if (r.outcome === 'idle') break;
      out.push(r);
    }
    return out;
  }
}

/** Nightly scheduler: one sync job per active connector for the day (repeat-safe). */
export async function enqueueDueSyncs(pool: Pool, day: string): Promise<number> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query('set local role worker_role');
    const n = (await db.query('select integration.enqueue_due_syncs($1::date) n', [day])).rows[0].n as number;
    await db.query('commit');
    return n;
  } catch (err) {
    await db.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}
