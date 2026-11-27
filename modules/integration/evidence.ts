// Stores a source file in object-locked storage, then records it in the database.
// Order matters: bytes first (locked), record second. If the record fails, the locked object is
// harmless and the next run finds it (same key) and records it then.
import type { ClientBase } from 'pg';
import { defaultRetainUntil, sha256, type EvidenceStore } from './evidence-store.js';

export interface StoredEvidence {
  sourceDocumentId: string;
  sha256: string;
  existed: boolean;
}

export async function storeEvidence(
  db: ClientBase,   // an app_role session (withSession) for the tenant
  store: EvidenceStore,
  args: { tenantId: string; docType: string; bytes: Buffer; contentType: string; extracted?: unknown; retainUntil?: Date },
): Promise<StoredEvidence> {
  const hash = sha256(args.bytes).toString('hex');
  const retainUntil = args.retainUntil ?? defaultRetainUntil();
  const key = `${args.tenantId}/${hash}`;
  const put = await store.put(key, args.bytes, { contentType: args.contentType, retainUntil });
  const { rows } = await db.query('select integration.register_evidence($1::jsonb) r', [JSON.stringify({
    doc_type: args.docType,
    sha256: hash,
    size_bytes: args.bytes.length,
    content_type: args.contentType,
    backend: put.backend,
    bucket: put.bucket,
    object_key: put.key,
    version_id: put.versionId,
    retain_until: retainUntil.toISOString(),
    extracted: args.extracted ?? null,
  })]);
  return { sourceDocumentId: rows[0].r.source_document_id, sha256: hash, existed: rows[0].r.existed };
}
