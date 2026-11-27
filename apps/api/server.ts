// Admin/API server (Phase 0 step 8). Thin by design: every route verifies the Supabase JWT,
// opens one transaction as app_role with the verified claims (withSession), and calls a
// database function or reads through RLS. All rules live in the database; this layer only
// maps HTTP to SQL and database error codes to HTTP statuses.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import { z } from 'zod';
import { withSession, type PreTenantClaims } from '../../modules/auth/index.js';
import { LedgerError, toLedgerError, postEntry, requestReversal, applyPayment, unapplyPayment, verifyChain } from '../../modules/ledger/index.js';
import { trialBalance, profitAndLoss, balanceSheet, cashAccrualTieOut, type Basis } from '../../modules/reporting/index.js';

export interface ServerConfig {
  pool: Pool;
  /** HS256 project JWT secret (Supabase legacy) — or — a JWKS URL for asymmetric signing keys. */
  jwtSecret?: string;
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
  /** Role every request runs as (default app_role). */
  dbRole?: string;
  logger?: boolean;
}

/** Thrown for request problems that never reach the database. */
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// Database error code -> HTTP status.
const STATUS: Array<[RegExp, number]> = [
  [/^(NOT_AUTHENTICATED|MFA_REQUIRED)$/, 401],
  [/^(ROLE_FORBIDDEN|AGENT_CANNOT_POST|APPROVER_NOT_USER|APPROVER_NOT_CALLER|SELF_APPROVAL|SOFT_CLOSE_FORBIDDEN|APPROVAL_LIMIT|LOCATION_NOT_PERMITTED|TENANT_MISMATCH|NO_PRINCIPAL|MEMBERSHIP_KIND_MISMATCH|CREATOR_NOT_CALLER|CREATOR_NOT_MEMBER)$/, 403],
  [/^(UNKNOWN_\w+|NO_PERIOD|NO_DRAFT|NO_REQUEST|NOT_FOUND)$/, 404],
  [/^(IDEMPOTENCY_CONFLICT|REQUEST_DECIDED|ALREADY_\w+|REOPEN_\w+|REVERSAL_PENDING|HAS_APPLICATIONS|ENTRY_REVERSED|BACKFILL_CLOSED|LAST_OWNER|PERIOD_\w+|CLOSE_ORDER|FISCAL_YEAR_\w+|CALENDAR_FIXED|\w*IMMUTABLE)$/, 409],
];
const statusFor = (code: string) => STATUS.find(([re]) => re.test(code))?.[1] ?? 422;

export async function buildServer(cfg: ServerConfig): Promise<FastifyInstance> {
  if (!cfg.jwtSecret && !cfg.jwksUrl) throw new Error('jwtSecret or jwksUrl is required');
  const app = Fastify({ logger: cfg.logger ?? false });
  const key = cfg.jwtSecret ? new TextEncoder().encode(cfg.jwtSecret) : createRemoteJWKSet(new URL(cfg.jwksUrl!));
  const role = cfg.dbRole ?? 'app_role';

  async function claimsOf(req: FastifyRequest): Promise<PreTenantClaims> {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw new HttpError(401, 'NOT_AUTHENTICATED', 'missing bearer token');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(m[1], key as Parameters<typeof jwtVerify>[1], {
        issuer: cfg.issuer, audience: cfg.audience,
      }));
    } catch {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'invalid or expired token');
    }
    if (typeof payload.sub !== 'string') throw new HttpError(401, 'NOT_AUTHENTICATED', 'token has no subject');
    return { ...payload, sub: payload.sub, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1' } as PreTenantClaims;
  }

  /** Registers a route that runs inside one authenticated, app_role transaction. */
  function route<B = unknown>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    handler: (db: PoolClient, req: FastifyRequest, body: B) => Promise<unknown>,
    schema?: z.ZodType<B>,
  ) {
    app.route({
      method, url,
      handler: async (req, reply) => {
        const claims = await claimsOf(req);
        let body = req.body as B;
        if (schema) {
          const parsed = schema.safeParse(req.body ?? {});
          if (!parsed.success) {
            throw new HttpError(400, 'VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
          }
          body = parsed.data;
        }
        const result = await withSession(cfg.pool, claims, (db) => handler(db, req, body), { role });
        if (result instanceof RawReply) {
          for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
          return reply.type(result.type).send(result.body);
        }
        return result ?? { ok: true };
      },
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ code: err.code, message: err.message });
    const le = toLedgerError(err);
    if (le instanceof LedgerError) return reply.status(statusFor(le.code)).send({ code: le.code, message: le.message });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '42501') return reply.status(403).send({ code: 'FORBIDDEN', message: 'not permitted' });
    if (pgCode === '22P02' || pgCode === '23503' || pgCode === '23505' || pgCode === '23514') {
      return reply.status(422).send({ code: 'INVALID', message: (err as Error).message });
    }
    if ((err as { statusCode?: number }).statusCode === 400) return reply.status(400).send({ code: 'VALIDATION', message: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: 'internal error' });
  });

  const one = async (db: PoolClient, sql: string, params: unknown[] = []) => {
    try {
      return (await db.query(sql, params)).rows[0];
    } catch (e) {
      throw toLedgerError(e);
    }
  };
  const many = async (db: PoolClient, sql: string, params: unknown[] = []) => {
    try {
      return (await db.query(sql, params)).rows;
    } catch (e) {
      throw toLedgerError(e);
    }
  };
  const uuid = z.string().uuid();
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const basis = z.enum(['accrual', 'cash']).optional();
  const q = <T>(req: FastifyRequest, schema: z.ZodType<T>) => {
    const p = schema.safeParse(req.query ?? {});
    if (!p.success) throw new HttpError(400, 'VALIDATION', p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return p.data;
  };
  const param = (req: FastifyRequest, name = 'id') => {
    const v = (req.params as Record<string, string>)[name];
    if (!uuid.safeParse(v).success) throw new HttpError(400, 'VALIDATION', `${name} must be a uuid`);
    return v;
  };

  app.get('/health', async () => ({ ok: true }));

  // ---- session ---------------------------------------------------------------------------
  route('GET', '/v1/me', async (db) => {
    const r = await one(db, `
      select t.id tenant_id, t.name tenant_name, m.role, m.location_ids, m.approval_limit::text approval_limit,
             p.id principal_id, p.name principal_name, p.kind
        from tenant t
        join principal p on p.id = app.current_principal()
        join membership m on m.tenant_id = t.id and m.user_id = p.auth_user_id
       where t.id = app.current_tenant()`);
    if (!r?.tenant_id) throw new HttpError(401, 'NOT_AUTHENTICATED', 'no verified, MFA-complete membership for this token');
    return r;
  });
  route('POST', '/v1/tenants', async (db, _r, b) => ({
    tenant_id: (await one(db, 'select app.create_tenant($1, $2) id', [b.name, b.display_name ?? null])).id,
  }), z.object({ name: z.string().min(1), display_name: z.string().optional() }));

  // ---- tenancy: entities, locations, members, principals -----------------------------------
  route('GET', '/v1/entities', (db) => many(db, 'select * from entity order by legal_name'));
  route('POST', '/v1/entities', async (db, _r, b) => one(db, `
      insert into entity (tenant_id, legal_name, ein, default_basis, fiscal_calendar, fy_end_month, week_end_dow, fy_week_rule)
      values (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) returning *`,
    [b.legal_name, b.ein ?? null, b.default_basis, b.fiscal_calendar, b.fy_end_month, b.week_end_dow, b.fy_week_rule]),
    z.object({
      legal_name: z.string().min(1), ein: z.string().optional(),
      default_basis: z.enum(['accrual', 'cash']).default('accrual'),
      fiscal_calendar: z.enum(['calendar_month', '445', '13_period']).default('calendar_month'),
      fy_end_month: z.number().int().min(1).max(12).default(12),
      week_end_dow: z.number().int().min(0).max(6).default(0),
      fy_week_rule: z.enum(['nearest', 'last']).default('nearest'),
    }));
  route('PATCH', '/v1/entities/:id', async (db, req, b) => {
    const r = await one(db, `update entity set legal_name = coalesce($2, legal_name), ein = coalesce($3, ein),
                               default_basis = coalesce($4, default_basis) where id = $1 returning *`,
      [param(req), b.legal_name ?? null, b.ein ?? null, b.default_basis ?? null]);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'entity not found or not permitted');
    return r;
  }, z.object({ legal_name: z.string().min(1).optional(), ein: z.string().optional(), default_basis: z.enum(['accrual', 'cash']).optional() }));
  route('GET', '/v1/locations', (db) => many(db, 'select * from location order by name'));
  route('POST', '/v1/locations', (db, _r, b) => one(db, `
      insert into location (tenant_id, entity_id, name, timezone, pos_system, pos_location_ref)
      values (app.current_tenant(), $1, $2, $3, $4, $5) returning *`,
    [b.entity_id, b.name, b.timezone, b.pos_system ?? null, b.pos_location_ref ?? null]),
    z.object({ entity_id: uuid, name: z.string().min(1), timezone: z.string().default('America/New_York'),
               pos_system: z.string().optional(), pos_location_ref: z.string().optional() }));
  route('GET', '/v1/members', (db) => many(db, `
      select m.id, m.user_id, m.role, m.location_ids, m.approval_limit::text approval_limit, m.active, p.id principal_id, p.name, p.kind
        from membership m left join principal p on p.tenant_id = m.tenant_id and p.auth_user_id = m.user_id
       order by m.created_at`));
  route('POST', '/v1/members', async (db, _r, b) => {
    const m = await one(db, `insert into membership (user_id, tenant_id, role, location_ids, approval_limit)
                             values ($1, app.current_tenant(), $2, $3, $4) returning id`,
      [b.user_id, b.role, b.location_ids ?? null, b.approval_limit ?? null]);
    const p = await one(db, `insert into principal (tenant_id, kind, name, auth_user_id)
                             values (app.current_tenant(), $1, $2, $3) returning id`,
      [b.role === 'service' ? b.kind ?? 'integration' : 'user', b.name, b.user_id]);
    return { membership_id: m.id, principal_id: p.id };
  }, z.object({
    user_id: uuid, name: z.string().min(1),
    role: z.enum(['owner', 'controller', 'bookkeeper', 'manager', 'viewer', 'service']),
    kind: z.enum(['agent', 'integration']).optional(),
    location_ids: z.array(uuid).optional(), approval_limit: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  }));
  route('PATCH', '/v1/members/:id', async (db, req, b) => {
    const r = await one(db, `update membership set role = coalesce($2, role), active = coalesce($3, active),
                               approval_limit = case when $4::boolean then $5::numeric else approval_limit end,
                               location_ids = case when $6::boolean then $7::uuid[] else location_ids end
                             where id = $1 returning id, role, active, approval_limit::text approval_limit, location_ids`,
      [param(req), b.role ?? null, b.active ?? null, 'approval_limit' in b, b.approval_limit ?? null,
       'location_ids' in b, b.location_ids ?? null]);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'membership not found or not permitted');
    return r;
  }, z.object({
    role: z.enum(['owner', 'controller', 'bookkeeper', 'manager', 'viewer', 'service']).optional(),
    active: z.boolean().optional(),
    approval_limit: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable().optional(),
    location_ids: z.array(uuid).nullable().optional(),
  }));

  // ---- chart of accounts -------------------------------------------------------------------
  route('GET', '/v1/accounts', (db) => many(db, 'select * from account order by number'));
  route('POST', '/v1/accounts', (db, _r, b) => one(db, `
      insert into account (tenant_id, number, name, type, normal_balance, cash_view, is_intercompany, usar_code)
      values (app.current_tenant(), $1, $2, $3, $4, $5, $6, $7) returning *`,
    [b.number, b.name, b.type, b.normal_balance, b.cash_view, b.is_intercompany, b.usar_code ?? null]),
    z.object({
      number: z.string().min(1), name: z.string().min(1),
      type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
      normal_balance: z.enum(['D', 'C']), cash_view: z.enum(['settle', 'always', 'never']),
      is_intercompany: z.boolean().default(false), usar_code: z.string().optional(),
    }));
  route('PATCH', '/v1/accounts/:id', async (db, req, b) => {
    const r = await one(db, `update account set name = coalesce($2, name), active = coalesce($3, active),
                               usar_code = coalesce($4, usar_code), cash_view = coalesce($5, cash_view)
                             where id = $1 returning *`,
      [param(req), b.name ?? null, b.active ?? null, b.usar_code ?? null, b.cash_view ?? null]);
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'account not found or not permitted');
    return r;
  }, z.object({ name: z.string().min(1).optional(), active: z.boolean().optional(), usar_code: z.string().optional(),
                cash_view: z.enum(['settle', 'always', 'never']).optional() }));
  route('POST', '/v1/coa/template', async (db, _r, b) => (await one(db, 'select ledger.load_coa_template($1) r', [b.template])).r,
    z.object({ template: z.string().default('usar') }));

  // ---- periods -----------------------------------------------------------------------------
  route('GET', '/v1/periods', (db, req) => {
    const { entity_id, fiscal_year } = q(req, z.object({ entity_id: uuid, fiscal_year: z.coerce.number().int().optional() }));
    return many(db, `select * from period where entity_id = $1 and ($2::int is null or fiscal_year = $2) order by start_date`,
      [entity_id, fiscal_year ?? null]);
  });
  route('POST', '/v1/fiscal-years', async (db, _r, b) => (await one(db, 'select ledger.create_fiscal_year($1, $2) r', [b.entity_id, b.year])).r,
    z.object({ entity_id: uuid, year: z.number().int() }));
  route('POST', '/v1/periods/:id/close', async (db, req, b) => (await one(db, 'select ledger.close_period($1, $2) r', [param(req), b.status])).r,
    z.object({ status: z.enum(['soft', 'hard']) }));
  route('POST', '/v1/periods/:id/seal', async (db, req) => (await one(db, 'select ledger.seal_period($1) r', [param(req)])).r);
  route('GET', '/v1/reopen-requests', (db) => many(db, `select * from ledger.period_reopen order by requested_at desc`));
  route('POST', '/v1/periods/:id/reopen-requests', async (db, req, b) => ({
    request_id: (await one(db, 'select ledger.request_reopen($1, $2, $3) id', [param(req), b.target, b.reason])).id,
  }), z.object({ target: z.enum(['open', 'soft']), reason: z.string().min(1) }));
  route('POST', '/v1/reopen-requests/:id/approve', async (db, req) => (await one(db, 'select ledger.approve_reopen($1) r', [param(req)])).r);
  route('POST', '/v1/reopen-requests/:id/reject', async (db, req) => (await one(db, 'select ledger.reject_reopen($1) r', [param(req)])).r);

  // ---- journal entries: drafts (two-person), direct posts, viewer, reversal ------------------
  route('GET', '/v1/drafts', (db, req) => {
    const { state } = q(req, z.object({ state: z.enum(['pending', 'posted', 'rejected']).optional() }));
    return many(db, `select d.*, p.name created_by_name, p.kind created_by_kind from ledger.je_draft d
                       join principal p on p.id = d.created_by
                      where ($1::text is null or d.state = $1) order by d.created_at desc`, [state ?? null]);
  });
  route('POST', '/v1/drafts', async (db, req) => {
    // The tenant defaults to the session's; a different one is refused by the database.
    const body = { ...((req.body as Record<string, unknown>) ?? {}) };
    body.tenant_id ??= (await one(db, 'select app.current_tenant() t')).t;
    return { draft_id: (await one(db, 'select ledger.propose_entry($1::jsonb) id', [JSON.stringify(body)])).id };
  });
  route('POST', '/v1/drafts/:id/approve', async (db, req, b) => (await one(db, 'select ledger.approve_draft($1, $2) r', [param(req), b.allow_soft_close])).r,
    z.object({ allow_soft_close: z.boolean().default(false) }));
  route('POST', '/v1/drafts/:id/reject', async (db, req, b) => (await one(db, 'select ledger.reject_draft($1, $2) r', [param(req), b.reason])).r,
    z.object({ reason: z.string() }));
  route('GET', '/v1/entries', (db, req) => {
    const p = q(req, z.object({ entity_id: uuid, from: date.optional(), to: date.optional(),
                                before_seq: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }));
    return many(db, `select e.id, e.seq, e.entry_date, e.posted_at, e.source_type, e.memo, e.created_by, e.approved_by,
                            e.reverses_id, encode(e.hash, 'hex') hash,
                            (select sum(l.debit)::text from ledger.journal_line l where l.entry_id = e.id) total
                       from ledger.journal_entry e
                      where e.entity_id = $1 and ($2::date is null or e.entry_date >= $2) and ($3::date is null or e.entry_date <= $3)
                        and ($4::bigint is null or e.seq < $4)
                      order by e.seq desc limit $5`, [p.entity_id, p.from ?? null, p.to ?? null, p.before_seq ?? null, p.limit]);
  });
  route('GET', '/v1/entries/:id', async (db, req) => (await one(db, 'select ledger.entry_detail($1) d', [param(req)])).d);
  route('POST', '/v1/entries', async (db, req) => postEntry(db, req.body as Parameters<typeof postEntry>[1]));
  // Requests a reversal (a draft by the caller); a different person approves it in /v1/drafts.
  route('POST', '/v1/entries/:id/reverse', async (db, req, b) => requestReversal(db, { ...b, entry_id: param(req) }),
    z.object({ entry_date: date.optional(), memo: z.string().optional() }));
  route('POST', '/v1/payment-applications', async (db, _r, b) => applyPayment(db, b.payment_entry_id, b.document_entry_id, b.amount, b.allow_soft_close),
    z.object({ payment_entry_id: uuid, document_entry_id: uuid, amount: z.string().regex(/^\d+(\.\d{1,4})?$/), allow_soft_close: z.boolean().default(false) }));
  route('POST', '/v1/payment-applications/:id/unapply', async (db, req, b) => unapplyPayment(db, param(req), b.allow_soft_close),
    z.object({ allow_soft_close: z.boolean().default(false) }));
  route('POST', '/v1/source-documents', (db, _r, b) => one(db, `
      insert into source_document (tenant_id, doc_type, storage_uri, sha256, extracted)
      values (app.current_tenant(), $1, $2, decode($3, 'hex'), $4) returning id, doc_type, storage_uri, encode(sha256, 'hex') sha256`,
    [b.doc_type, b.storage_uri, b.sha256, b.extracted ?? null]),
    z.object({ doc_type: z.string().min(1), storage_uri: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/),
               extracted: z.record(z.string(), z.unknown()).optional() }));

  // ---- reports -----------------------------------------------------------------------------
  route('GET', '/v1/reports/trial-balance', (db, req) => {
    const p = q(req, z.object({ entity_id: uuid, from: date.optional(), to: date, basis }));
    return trialBalance(db, p.entity_id, p.from ?? null, p.to, p.basis as Basis | undefined);
  });
  route('GET', '/v1/reports/profit-and-loss', (db, req) => {
    const p = q(req, z.object({ entity_id: uuid, from: date, to: date, basis, location_id: uuid.optional() }));
    return profitAndLoss(db, p.entity_id, p.from, p.to, { basis: p.basis as Basis | undefined, locationId: p.location_id });
  });
  route('GET', '/v1/reports/balance-sheet', (db, req) => {
    const p = q(req, z.object({ entity_id: uuid, as_of: date, basis }));
    return balanceSheet(db, p.entity_id, p.as_of, p.basis as Basis | undefined);
  });
  route('GET', '/v1/reports/tie-out', (db, req) => {
    const p = q(req, z.object({ entity_id: uuid, from: date, to: date }));
    return cashAccrualTieOut(db, p.entity_id, p.from, p.to);
  });
  route('GET', '/v1/entities/:id/verify', async (db, req) => verifyChain(db, param(req)));

  // ---- audit export ------------------------------------------------------------------------
  route('GET', '/v1/audit/export', async (db, req) => {
    const p = q(req, z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
                                format: z.enum(['jsonl', 'csv']).default('jsonl') }));
    const rows = await many(db, 'select * from audit.export($1, $2)', [p.from ?? null, p.to ?? null]);
    const chain = await one(db, 'select * from audit.verify_chain(app.current_tenant())');
    const events = rows.map(({ chain_ok: _a, chain_checked: _b, chain_first_bad_seq: _c, ...e }) => ({ ...e, seq: Number(e.seq) }));
    const body = p.format === 'jsonl'
      ? events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
      : toCsv(events);
    return new RawReply(body, p.format === 'jsonl' ? 'application/x-ndjson' : 'text/csv', {
      'x-audit-chain-ok': String(chain.ok),
      'x-audit-chain-checked': String(chain.checked),
      ...(chain.first_bad_seq ? { 'x-audit-chain-first-bad-seq': String(chain.first_bad_seq) } : {}),
      'x-export-sha256': createHash('sha256').update(body).digest('hex'),
      'content-disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.${p.format}"`,
    });
  });

  return app;
}

class RawReply {
  constructor(public body: string, public type: string, public headers: Record<string, string>) {}
}

function toCsv(rows: Record<string, unknown>[]): string {
  const cols = ['seq', 'at', 'actor_type', 'actor_id', 'actor_name', 'action', 'object_type', 'object_id', 'detail', 'prev_hash', 'hash'];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}
