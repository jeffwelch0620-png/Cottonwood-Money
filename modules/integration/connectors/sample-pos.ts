// Sample POS connector: stands in for Toast until credentials exist (step 1.2 replaces it).
// Produces a deterministic end-of-day file for (connector, business day), stores it as evidence,
// and posts one daily sales entry. Same day -> same bytes -> same evidence -> same key: re-runs
// post nothing twice.
//
// config: { location_id, accounts: { clearing, sales } }
import { createHash } from 'node:crypto';
import { storeEvidence } from '../evidence.js';
import { runSync, postOnce, syncKey } from '../sync.js';
import type { Handler } from '../worker.js';

export function sampleDay(connectorId: string, day: string) {
  const h = createHash('sha256').update(`${connectorId}:${day}`).digest();
  const cents = 150_000 + (h.readUInt32BE(0) % 350_000); // $1,500.00 – $4,999.99
  const checks = 40 + (h[4] % 120);
  return { source: 'sample_pos', business_date: day, checks, net_sales: (cents / 100).toFixed(2) };
}

export const samplePos: Handler = (ctx) =>
  runSync(ctx, async (stats, day) => {
    const { job } = ctx;
    const cfg = job.connector_config ?? {};
    if (!job.entity_id || !cfg.location_id || !cfg.accounts?.clearing || !cfg.accounts?.sales) {
      throw new Error('BAD_CONFIG: sample_pos needs entity_id, config.location_id and config.accounts.{clearing,sales}');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`BAD_SCOPE: ${day} is not a business day`);
    const file = { ...sampleDay(job.connector_id!, day), location_id: cfg.location_id };
    await ctx.asTenant(async (db) => {
      const ev = await storeEvidence(db, ctx.store, {
        tenantId: job.tenant_id, docType: 'pos_eod', bytes: Buffer.from(JSON.stringify(file)),
        contentType: 'application/json', extracted: file,
      });
      stats[ev.existed ? 'evidence_existing' : 'evidence_new']++;
      await postOnce(db, {
        tenant_id: job.tenant_id,
        entity_id: job.entity_id,
        entry_date: day,
        source_type: 'pos_dsj',
        idempotency_key: syncKey(job.connector_id!, day, `dsj:${cfg.location_id}`),
        memo: `Daily sales ${day} (sample POS)`,
        actor_type: 'integration',
        created_by: job.run_as,
        evidence_ids: [ev.sourceDocumentId],
        lines: [
          { account_id: cfg.accounts.clearing, location_id: cfg.location_id, debit: file.net_sales, credit: '0' },
          { account_id: cfg.accounts.sales, location_id: cfg.location_id, debit: '0', credit: file.net_sales },
        ],
      }, stats);
    });
  });
