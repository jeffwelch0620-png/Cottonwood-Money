// Ledger module: validates commands for friendly errors, then calls the database
// posting function, which re-validates everything and is the only writer.
import { z } from 'zod';
import type { ClientBase } from 'pg';
import { money, toDb, hasAtMost4Decimals, sum } from '../shared/money.js';

const uuid = z.string().uuid();
const amount = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => money(v ?? 0))
  .refine((m) => m.gte(0), 'amount cannot be negative')
  .refine(hasAtMost4Decimals, 'at most 4 decimal places');

export const LineSchema = z
  .object({
    account_id: uuid,
    location_id: uuid,
    debit: amount,
    credit: amount,
    dims: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((l) => l.debit.isZero() !== l.credit.isZero(), 'each line needs exactly one of debit or credit');

export const PostEntrySchema = z
  .object({
    tenant_id: uuid,
    entity_id: uuid,
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source_type: z.enum(['pos_dsj', 'ap_bill', 'ap_payment', 'bank', 'payroll', 'inventory', 'manual', 'opening']),
    idempotency_key: z.string().min(1),
    memo: z.string().optional(),
    actor_type: z.enum(['user', 'agent', 'integration']),
    created_by: uuid,
    approved_by: uuid.optional(), // must equal the session's principal if given; the DB derives it
    allow_soft_close: z.boolean().optional(), // honored only for a controller session
    evidence_ids: z.array(uuid).default([]),
    lines: z.array(LineSchema).min(2),
  })
  .refine((e) => sum(e.lines.map((l) => l.debit)).eq(sum(e.lines.map((l) => l.credit))), {
    message: 'debits must equal credits',
    path: ['lines'],
  });

export type PostEntryInput = z.input<typeof PostEntrySchema>;

export interface PostResult {
  id: string;
  entity_id: string;
  seq: number;
  hash: string;
  posted_at: string;
}

/** Typed error carrying the database's code (UNBALANCED, PERIOD_CLOSED, SELF_APPROVAL, ...). */
export class LedgerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export function toLedgerError(err: unknown): LedgerError | unknown {
  const msg = (err as { message?: string })?.message ?? '';
  const m = /^([A-Z_]+): (.*)$/s.exec(msg);
  return m ? new LedgerError(m[1], m[2]) : err;
}

export async function postEntry(db: ClientBase, input: PostEntryInput): Promise<PostResult> {
  const parsed = PostEntrySchema.safeParse(input);
  if (!parsed.success) {
    throw new LedgerError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const e = parsed.data;
  const payload = {
    ...e,
    lines: e.lines.map((l) => ({ ...l, debit: toDb(l.debit), credit: toDb(l.credit), dims: l.dims ?? {} })),
  };
  try {
    const { rows } = await db.query('select ledger.post_entry($1::jsonb) as r', [JSON.stringify(payload)]);
    const r = rows[0].r;
    return { ...r, seq: Number(r.seq) };
  } catch (err) {
    throw toLedgerError(err);
  }
}

export async function reverseEntry(
  db: ClientBase,
  // The approver is the session's user; approved_by, if given, must match it.
  input: { entry_id: string; created_by: string; approved_by?: string; entry_date?: string; idempotency_key?: string; memo?: string },
): Promise<PostResult> {
  try {
    const { rows } = await db.query('select ledger.reverse_entry($1::jsonb) as r', [JSON.stringify(input)]);
    const r = rows[0].r;
    return { ...r, seq: Number(r.seq) };
  } catch (err) {
    throw toLedgerError(err);
  }
}

export async function verifyChain(db: ClientBase, entityId: string) {
  const { rows } = await db.query('select * from ledger.verify_chain($1)', [entityId]);
  const r = rows[0];
  return { ok: r.ok as boolean, checked: Number(r.checked), firstBadSeq: r.first_bad_seq === null ? null : Number(r.first_bad_seq), reason: r.reason as string | null };
}

export async function trialBalance(db: ClientBase, entityId: string) {
  const { rows } = await db.query(
    `select a.number, a.name, sum(l.debit)::text as debit, sum(l.credit)::text as credit
       from ledger.journal_line l join account a on a.id = l.account_id
      where l.entity_id = $1 group by a.number, a.name order by a.number`,
    [entityId],
  );
  return rows as { number: string; name: string; debit: string; credit: string }[];
}
