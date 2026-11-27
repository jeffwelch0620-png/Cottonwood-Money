// Object-locked (WORM) evidence storage. Keys are content addressed: <tenant>/<sha256>, so the
// same bytes always land on the same key and different bytes never share one.
//
// Guarantees every implementation must give (tests/integration-evidence.test.ts):
//   - put never overwrites: an existing key with the same bytes is reported, different bytes refused
//   - an existing object's lock is extended (never shortened) to the requested date, and put
//     returns the lock actually in force, which is what gets recorded
//   - nothing is deleted before its retain-until date
//   - get returns exactly the bytes stored (callers re-check SHA-256)
//
// S3WormStore relies on S3 itself for these: the bucket has Object Lock enabled, each object is
// written in COMPLIANCE mode (no one, including the account root, can shorten it), with
// If-None-Match: * (no overwrite) and an S3-verified SHA-256 checksum.
import { createHash } from 'node:crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, PutObjectRetentionCommand,
} from '@aws-sdk/client-s3';

export interface PutResult {
  backend: 's3' | 'memory';
  bucket: string;
  key: string;
  versionId: string | null;
  existed: boolean;
  /** The retention lock in force after this call (>= the requested date). */
  retainUntil: Date;
}

export interface EvidenceStore {
  readonly backend: 's3' | 'memory';
  readonly bucket: string;
  put(key: string, bytes: Buffer, opts: { contentType: string; retainUntil: Date }): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  /** Deletes one version. Must refuse while the retention lock holds. */
  delete(key: string, versionId: string | null): Promise<void>;
}

export class EvidenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'EvidenceError';
  }
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** In-memory WORM store with the same rules, for tests and local development. */
export class MemoryWormStore implements EvidenceStore {
  readonly backend = 'memory' as const;
  private objects = new Map<string, { bytes: Buffer; retainUntil: Date; versionId: string }>();
  private n = 0;
  constructor(readonly bucket = 'evidence-local', private now: () => Date = () => new Date()) {}

  async put(key: string, bytes: Buffer, opts: { contentType: string; retainUntil: Date }): Promise<PutResult> {
    const cur = this.objects.get(key);
    if (cur) {
      if (!cur.bytes.equals(bytes)) throw new EvidenceError('EVIDENCE_COLLISION', `${key} exists with different bytes`);
      if (cur.retainUntil < opts.retainUntil) cur.retainUntil = opts.retainUntil; // extend, never shorten
      return { backend: this.backend, bucket: this.bucket, key, versionId: cur.versionId, existed: true, retainUntil: cur.retainUntil };
    }
    const versionId = `v${++this.n}`;
    this.objects.set(key, { bytes: Buffer.from(bytes), retainUntil: opts.retainUntil, versionId });
    return { backend: this.backend, bucket: this.bucket, key, versionId, existed: false, retainUntil: opts.retainUntil };
  }

  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new EvidenceError('EVIDENCE_MISSING', key);
    return Buffer.from(o.bytes);
  }

  async delete(key: string, _versionId: string | null): Promise<void> {
    const o = this.objects.get(key);
    if (!o) return;
    if (this.now() < o.retainUntil) {
      throw new EvidenceError('OBJECT_LOCKED', `${key} is retained until ${o.retainUntil.toISOString()}`);
    }
    this.objects.delete(key);
  }
}

/** The subset of S3Client the store uses (lets tests inspect the exact requests). */
export interface S3Like {
  send(command: unknown): Promise<any>;
}

export class S3WormStore implements EvidenceStore {
  readonly backend = 's3' as const;
  constructor(readonly bucket: string, private client: S3Like = new S3Client({})) {}

  async put(key: string, bytes: Buffer, opts: { contentType: string; retainUntil: Date }): Promise<PutResult> {
    const checksum = sha256(bytes).toString('base64');
    try {
      const r = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: opts.contentType,
        ChecksumSHA256: checksum,            // S3 rejects the upload if the bytes don't match
        IfNoneMatch: '*',                    // never overwrite an existing object
        ObjectLockMode: 'COMPLIANCE',        // retention cannot be shortened or removed by anyone
        ObjectLockRetainUntilDate: opts.retainUntil,
      }));
      return { backend: this.backend, bucket: this.bucket, key, versionId: r.VersionId ?? null, existed: false, retainUntil: opts.retainUntil };
    } catch (err: any) {
      if (err?.name !== 'PreconditionFailed' && err?.$metadata?.httpStatusCode !== 412) throw err;
      // Already stored: fine only if it is the same bytes.
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }));
      if (head.ChecksumSHA256 !== checksum) {
        throw new EvidenceError('EVIDENCE_COLLISION', `${key} exists with different bytes`);
      }
      // Its lock may be older (e.g. stored by a run whose database record rolled back). Extend it to
      // the requested date before accepting it; COMPLIANCE retention can be extended, never shortened.
      const current = head.ObjectLockRetainUntilDate ? new Date(head.ObjectLockRetainUntilDate) : null;
      let retainUntil = current && head.ObjectLockMode === 'COMPLIANCE' ? current : null;
      if (!retainUntil || retainUntil < opts.retainUntil) {
        await this.client.send(new PutObjectRetentionCommand({
          Bucket: this.bucket, Key: key, ...(head.VersionId ? { VersionId: head.VersionId } : {}),
          Retention: { Mode: 'COMPLIANCE', RetainUntilDate: opts.retainUntil },
        }));
        retainUntil = opts.retainUntil;
      }
      return { backend: this.backend, bucket: this.bucket, key, versionId: head.VersionId ?? null, existed: true, retainUntil };
    }
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }));
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async delete(key: string, versionId: string | null): Promise<void> {
    // S3 refuses this (AccessDenied) while the COMPLIANCE retention holds.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
  }
}

/** Retain-until for new evidence: the 7-year floor the database checks, plus one day of slack. */
export function defaultRetainUntil(from = new Date()): Date {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() + 7);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
