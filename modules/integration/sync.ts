// Repeat-safe sync runs. A run claims one (connector, scope) at a time in the database; each item
// posts with a deterministic idempotency key, so pulling the same scope again posts nothing twice.
import type { PoolClient } from 'pg';
import type { JobContext } from './worker.js';

export interface SyncStats {
  posted: number;
  already_posted: number;
  evidence_new: number;
  evidence_existing: number;
  [k: string]: number;
}

export const emptyStats = (): SyncStats => ({ posted: 0, already_posted: 0, evidence_new: 0, evidence_existing: 0 });

/** Idempotency key for one synced item: sync:<connector>:<scope>:<item>. */
export const syncKey = (connectorId: string, scope: string, item: string) => `sync:${connectorId}:${scope}:${item}`;

export async function runSync(ctx: JobContext, body: (stats: SyncStats, scope: string) => Promise<void>): Promise<Record<string, unknown>> {
  const { job } = ctx;
  const scope = String(job.payload.scope ?? '');
  const runId = await ctx.asTenant(async (db) =>
    (await db.query('select integration.start_sync_run($1, $2, $3) id', [job.connector_id, scope, job.job_id])).rows[0].id as string);
  const stats = emptyStats();
  try {
    await body(stats, scope);
  } catch (err) {
    await ctx.asTenant((db) => db.query('select integration.finish_sync_run($1, $2, $3::jsonb, $4)',
      [runId, 'failed', JSON.stringify(stats), (err as Error).message]));
    throw err;
  }
  await ctx.asTenant((db) => db.query('select integration.finish_sync_run($1, $2, $3::jsonb)', [runId, 'succeeded', JSON.stringify(stats)]));
  return { sync_run_id: runId, scope, ...stats };
}

/** Posts one entry unless its key was already posted. The database's idempotency is the backstop. */
export async function postOnce(db: PoolClient, entry: Record<string, unknown>, stats: SyncStats): Promise<string> {
  const prior = await db.query('select id from ledger.journal_entry where idempotency_key = $1', [entry.idempotency_key]);
  if (prior.rowCount) {
    stats.already_posted++;
    return prior.rows[0].id;
  }
  const r = (await db.query('select ledger.post_entry($1::jsonb) r', [JSON.stringify(entry)])).rows[0].r;
  stats.posted++;
  return r.id;
}
