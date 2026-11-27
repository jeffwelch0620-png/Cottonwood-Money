// Nightly manifest export: for every entity, record the chain head (ledger.take_manifest) and
// verify the chain; add the audit chain head; write the manifest to object-locked storage.
// An outside party holding these files can prove later that no posted history was rewritten.
import { storeEvidence } from '../evidence.js';
import { runSync } from '../sync.js';
import type { Handler } from '../worker.js';

export const manifestExport: Handler = (ctx) =>
  runSync(ctx, async (stats, day) => {
    const { job } = ctx;
    // Store first (its own transaction), then report a broken chain, so the evidence survives.
    await ctx.asTenant(async (db) => {
      const entities = (await db.query('select id, legal_name from entity where tenant_id = $1 order by legal_name, id', [job.tenant_id])).rows;
      const out = [];
      for (const e of entities) {
        const head = (await db.query('select ledger.take_manifest($1) m', [e.id])).rows[0].m;
        const v = (await db.query('select * from ledger.verify_chain($1)', [e.id])).rows[0];
        out.push({ entity_id: e.id, legal_name: e.legal_name, seq: Number(head.seq), hash: head.hash ?? null,
                   chain_ok: v.ok, checked: Number(v.checked), first_bad_seq: v.first_bad_seq === null ? null : Number(v.first_bad_seq) });
      }
      const audit = (await db.query(`select seq, encode(hash, 'hex') hash from audit.event where tenant_id = $1 order by seq desc limit 1`, [job.tenant_id])).rows[0];
      const manifest = { type: 'chain_manifest', version: 1, tenant_id: job.tenant_id, as_of_day: day,
                         taken_at: new Date().toISOString(), entities: out,
                         audit_head: audit ? { seq: Number(audit.seq), hash: audit.hash } : null };
      const ev = await storeEvidence(db, ctx.store, {
        tenantId: job.tenant_id, docType: 'chain_manifest', bytes: Buffer.from(JSON.stringify(manifest)),
        contentType: 'application/json', extracted: { as_of_day: day, entities: out.length },
      });
      stats[ev.existed ? 'evidence_existing' : 'evidence_new']++;
      stats.entities = out.length;
      stats.broken_chains = out.filter((x) => !x.chain_ok).length;
    });
    if (stats.broken_chains) {
      throw new Error(`CHAIN_BROKEN: ${stats.broken_chains} entity chain(s) failed verification; manifest stored as evidence`);
    }
  });
