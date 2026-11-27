// Job worker process (Render background worker).
//   npm run worker                 -> claim and run jobs until stopped
//   npm run worker -- schedule DAY -> enqueue one sync per active connector for DAY (Render cron, nightly)
//
// Env: DATABASE_URL (a login that may SET ROLE worker_role and app_role), CONNECTOR_KEYS
// (id:base64key,...), EVIDENCE_BUCKET (S3 bucket with Object Lock) or EVIDENCE_BACKEND=memory
// for local development, WORKER_ID (default host:pid), POLL_MS (default 2000).
import pg from 'pg';
import { hostname } from 'node:os';
import { Worker, S3WormStore, MemoryWormStore, keysFromEnv, defaultHandlers, enqueueDueSyncs } from '../../modules/integration/index.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: url, max: 4 });

if (process.argv[2] === 'schedule') {
  const day = process.argv[3] ?? new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const n = await enqueueDueSyncs(pool, day);
  console.log(`enqueued ${n} sync job(s) for ${day}`);
  await pool.end();
} else {
  const store = process.env.EVIDENCE_BACKEND === 'memory'
    ? new MemoryWormStore()
    : new S3WormStore(process.env.EVIDENCE_BUCKET ?? (() => { throw new Error('EVIDENCE_BUCKET is required'); })());
  const worker = new Worker({
    pool, store, handlers: defaultHandlers, keys: keysFromEnv(),
    workerId: process.env.WORKER_ID ?? `${hostname()}:${process.pid}`,
  });
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; });
  const poll = Number(process.env.POLL_MS ?? 2000);
  while (!stopping) {
    const r = await worker.runOnce().catch((e) => { console.error('worker error', e); return { outcome: 'idle' as const }; });
    if (r.outcome !== 'idle') console.log(JSON.stringify(r));
    else await new Promise((res) => setTimeout(res, poll));
  }
  await pool.end();
}
