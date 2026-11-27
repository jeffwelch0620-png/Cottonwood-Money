// Connector credentials: sealed in the app with AES-256-GCM before they reach the database.
// The database stores only ciphertext (and refuses anything not in this envelope), so a database
// dump or a compromised app_role session reveals nothing. The connector id is bound in as
// additional data: a ciphertext copied onto another connector will not decrypt.
//
// Envelope v1: 0x01 | IV (12 bytes) | GCM tag (16 bytes) | ciphertext
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretKey {
  id: string;   // key id stored next to the ciphertext, for rotation
  key: Buffer;  // 32 bytes
}

/** Reads keys from CONNECTOR_KEYS="id1:base64key,id2:base64key"; the first is used to seal. */
export function keysFromEnv(env = process.env.CONNECTOR_KEYS ?? ''): SecretKey[] {
  const keys = env.split(',').filter(Boolean).map((pair) => {
    const [id, b64] = pair.split(':');
    const key = Buffer.from(b64 ?? '', 'base64');
    if (!id || key.length !== 32) throw new Error('CONNECTOR_KEYS: each entry must be id:base64(32 bytes)');
    return { id, key };
  });
  if (!keys.length) throw new Error('CONNECTOR_KEYS is not set');
  return keys;
}

export function sealSecret(plaintext: string, connectorId: string, k: SecretKey): { ciphertext: Buffer; keyId: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(Buffer.from(connectorId));
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { ciphertext: Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), body]), keyId: k.id };
}

export function openSecret(ciphertext: Buffer, keyId: string, connectorId: string, keys: SecretKey[]): string {
  const k = keys.find((x) => x.id === keyId);
  if (!k) throw new Error(`SECRET_KEY_UNKNOWN: no key ${keyId}`);
  if (ciphertext[0] !== 1 || ciphertext.length < 29) throw new Error('SECRET_ENVELOPE: unknown envelope version');
  const d = createDecipheriv('aes-256-gcm', k.key, ciphertext.subarray(1, 13));
  d.setAAD(Buffer.from(connectorId));
  d.setAuthTag(ciphertext.subarray(13, 29));
  return Buffer.concat([d.update(ciphertext.subarray(29)), d.final()]).toString('utf8');
}
