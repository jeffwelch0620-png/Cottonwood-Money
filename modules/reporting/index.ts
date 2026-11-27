// Reporting: trial balance, P&L, balance sheet and the cash/accrual tie-out, on either basis.
// All numbers come back from the database as strings and are summed as Decimal, never JS numbers.
// `basis` defaults to the entity's default_basis and is echoed on every report.
import type { ClientBase } from 'pg';
import { Decimal } from 'decimal.js';
import { toLedgerError } from '../ledger/index.js';

export type Basis = 'accrual' | 'cash';

async function q<T>(db: ClientBase, sql: string, params: unknown[]): Promise<T[]> {
  try {
    return (await db.query(sql, params)).rows as T[];
  } catch (err) {
    throw toLedgerError(err);
  }
}

const dec = (v: unknown) => new Decimal(String(v ?? 0));
const sum = (xs: Decimal[]) => xs.reduce((a, b) => a.plus(b), new Decimal(0));

export interface TrialBalanceRow { number: string; name: string; type: string; opening: Decimal; debits: Decimal; credits: Decimal; closing: Decimal }

export async function trialBalance(db: ClientBase, entityId: string, from: string | null, to: string, basis?: Basis) {
  const rows = await q<Record<string, unknown>>(db, 'select * from ledger.trial_balance($1, $2, $3, $4)', [entityId, from, to, basis ?? null]);
  const lines: TrialBalanceRow[] = rows.map((r) => ({
    number: String(r.number), name: String(r.name), type: String(r.type),
    opening: dec(r.opening), debits: dec(r.debits), credits: dec(r.credits), closing: dec(r.closing),
  }));
  const totals = { debits: sum(lines.map((l) => l.debits)), credits: sum(lines.map((l) => l.credits)), closing: sum(lines.map((l) => l.closing)) };
  const resolved = (rows[0]?.basis as Basis | undefined) ?? (await resolveBasis(db, entityId, basis));
  return { basis: resolved, lines, totals, balanced: totals.debits.eq(totals.credits) && totals.closing.isZero() };
}

export async function profitAndLoss(db: ClientBase, entityId: string, from: string, to: string, opts: { basis?: Basis; locationId?: string } = {}) {
  const rows = await q<Record<string, unknown>>(db, 'select * from ledger.profit_and_loss($1, $2, $3, $4, $5)',
    [entityId, from, to, opts.basis ?? null, opts.locationId ?? null]);
  const lines = rows.map((r) => ({ number: String(r.number), name: String(r.name), type: String(r.type), amount: dec(r.amount) }));
  const revenue = sum(lines.filter((l) => l.type === 'revenue').map((l) => l.amount));
  const expense = sum(lines.filter((l) => l.type === 'expense').map((l) => l.amount));
  const basis = (rows[0]?.basis as Basis | undefined) ?? (await resolveBasis(db, entityId, opts.basis));
  return { basis, lines, revenue, expense, netIncome: revenue.minus(expense) };
}

export async function balanceSheet(db: ClientBase, entityId: string, asOf: string, basis?: Basis) {
  const rows = await q<Record<string, unknown>>(db, 'select * from ledger.balance_sheet($1, $2, $3)', [entityId, asOf, basis ?? null]);
  const lines = rows.map((r) => ({ section: String(r.section), number: r.number as string | null, name: String(r.name), amount: dec(r.amount) }));
  const assets = sum(lines.filter((l) => l.section === 'asset').map((l) => l.amount));
  const liabilities = sum(lines.filter((l) => l.section === 'liability').map((l) => l.amount));
  const equity = sum(lines.filter((l) => l.section === 'equity').map((l) => l.amount));
  const resolved = (rows[0]?.basis as Basis | undefined) ?? (await resolveBasis(db, entityId, basis));
  return { basis: resolved, lines, assets, liabilities, equity, balanced: assets.eq(liabilities.plus(equity)) };
}

export async function cashAccrualTieOut(db: ClientBase, entityId: string, from: string, to: string) {
  const [r] = await q<Record<string, unknown>>(db, 'select * from ledger.cash_accrual_tieout($1, $2, $3)', [entityId, from, to]);
  return {
    niAccrual: dec(r.ni_accrual), niCash: dec(r.ni_cash),
    wcChangeAccrual: dec(r.wc_change_accrual), wcChangeCash: dec(r.wc_change_cash),
    expectedNiCash: dec(r.expected_ni_cash), difference: dec(r.difference),
    detail: r.detail as Record<string, { name: string; accrual: string; cash: string }>,
  };
}

async function resolveBasis(db: ClientBase, entityId: string, basis?: Basis): Promise<Basis> {
  if (basis) return basis;
  const [r] = await q<{ default_basis: Basis }>(db, 'select default_basis from entity where id = $1', [entityId]);
  return r?.default_basis ?? 'accrual';
}
