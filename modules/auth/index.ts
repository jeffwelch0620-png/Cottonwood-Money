// Request auth: runs work inside one transaction with the caller's verified JWT claims set
// transaction-locally, so a pooled connection can never carry one user's identity into the
// next request. The database then derives tenant, actor and approver from these claims.
import type { Pool, PoolClient } from 'pg';

/** Claims from a Supabase access token that the app has already verified. */
export interface SessionClaims {
  sub: string;        // auth.uid()
  tenant_id: string;  // the tenant the user is acting in (checked against membership)
  aal: 'aal1' | 'aal2';
  [claim: string]: unknown;
}

export async function withSession<T>(pool: Pool, claims: SessionClaims, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const result = await fn(db);
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}
