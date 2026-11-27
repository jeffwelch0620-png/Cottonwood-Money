// Phase 0 step 7: payment application, cash/accrual views, TB, P&L, balance sheet, tie-out.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import fc from 'fast-check';
import { appClient, superClient, makeFixture, dsj, post, actAs, expectCode as expectDbCode, type Fixture } from './helpers.js';
import { trialBalance, profitAndLoss, balanceSheet, cashAccrualTieOut } from '../modules/reporting/index.js';
import { applyPayment, unapplyPayment } from '../modules/ledger/index.js';

/** Accepts both raw database errors ('CODE: ...') and the TS module's LedgerError (code in .code). */
async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e) => e);
  expect(err, `expected ${code}`).not.toBeNull();
  if (err.code && /^[A-Z_]+$/.test(err.code) && !/^\d/.test(err.code)) expect(err.code).toBe(code);
  else await expectDbCode(Promise.reject(err), code);
}

let db: pg.Client;
let su: pg.Client;
beforeAll(async () => {
  db = await appClient();
  su = await superClient();
});
afterAll(async () => {
  await db.end();
  await su.end();
});

type Accts = Fixture['acct'] & Record<'ar' | 'salesTax' | 'payTax' | 'wages' | 'prepaid' | 'depExp' | 'accDep' | 'equity' | 'disc', string>;

/** A fresh tenant with the extra accounts the cash view needs. */
async function world() {
  const f = await makeFixture(db);
  await actAs(db, f.user1);
  const acct = async (number: string, name: string, type: string, nb: string, cv: string) =>
    (await db.query(`insert into account (tenant_id, number, name, type, normal_balance, cash_view)
                     values ($1,$2,$3,$4,$5,$6) returning id`, [f.tenant, number, name, type, nb, cv])).rows[0].id as string;
  const a: Accts = {
    ...f.acct,
    ar: await acct('1110', 'Accounts receivable', 'asset', 'D', 'never'),
    prepaid: await acct('1310', 'Prepaid expenses', 'asset', 'D', 'never'),
    accDep: await acct('1590', 'Accumulated depreciation', 'asset', 'C', 'always'),
    salesTax: await acct('2210', 'Sales tax payable', 'liability', 'C', 'never'),
    payTax: await acct('2310', 'Payroll taxes payable', 'liability', 'C', 'never'),
    equity: await acct('3010', 'Owner equity', 'equity', 'C', 'always'),
    disc: await acct('4910', 'Discounts earned', 'revenue', 'C', 'settle'),
    wages: await acct('6010', 'Wages', 'expense', 'D', 'settle'),
    depExp: await acct('6810', 'Depreciation', 'expense', 'D', 'always'),
  };
  return { f, a };
}

type L = [account: string, debit: string | 0, credit: string | 0, location?: string];
const entry = (f: Fixture, source: string, date: string, lines: L[], over: Record<string, unknown> = {}) =>
  post(db, dsj(f, {
    source_type: source, entry_date: date, idempotency_key: `${source}:${randomUUID()}`,
    lines: lines.map(([account_id, d, c, loc]) => ({ account_id, location_id: loc ?? f.locA1, debit: String(d), credit: String(c) })),
    ...over,
  }));

const apply = async (f: Fixture, pay: string, doc: string, amt: string) => {
  await actAs(db, f.integration);
  return applyPayment(db, pay, doc, amt);
};

/** Cash-view amount per account number for a date range. */
async function cashByAccount(f: Fixture, from: string, to: string, basis: 'cash' | 'accrual' = 'cash') {
  await actAs(db, f.user1);
  const fn = basis === 'cash' ? 'cash_lines' : 'accrual_lines';
  const { rows } = await db.query(
    `select a.number, sum(c.amount)::text amt from ledger.${fn}($1) c join account a on a.id = c.account_id
      where c.view_date between $2 and $3 group by a.number having sum(c.amount) <> 0 order by a.number`, [f.entityA, from, to]);
  return Object.fromEntries(rows.map((r) => [r.number, r.amt]));
}

describe('spec example: a $1,000 food bill paid $600 then $400', () => {
  it('cash view: $600 COGS in November, $400 in December; accrual: $1,000 in November', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-20', [[a.cogs, '1000', 0], [a.ap, 0, '1000']]);
    const p1 = await entry(f, 'ap_payment', '2026-11-28', [[a.ap, '600', 0], [a.cash, 0, '600']]);
    const p2 = await entry(f, 'ap_payment', '2026-12-05', [[a.ap, '400', 0], [a.cash, 0, '400']]);
    const r1 = await apply(f, p1.id, bill.id, '600');
    expect(r1).toMatchObject({ settled_on: '2026-11-28', document_open: '400.0000' });
    await apply(f, p2.id, bill.id, '400');

    await actAs(db, f.user1);
    const nov = (basis: 'cash' | 'accrual') => profitAndLoss(db, f.entityA, '2026-11-01', '2026-11-30', { basis });
    const dec_ = (basis: 'cash' | 'accrual') => profitAndLoss(db, f.entityA, '2026-12-01', '2026-12-31', { basis });
    const cogs = (p: Awaited<ReturnType<typeof nov>>) => p.lines.find((l) => l.number === '5010')?.amount.toFixed(4);
    expect(cogs(await nov('cash'))).toBe('600.0000');
    expect(cogs(await dec_('cash'))).toBe('400.0000');
    expect(cogs(await nov('accrual'))).toBe('1000.0000');
    expect(cogs(await dec_('accrual'))).toBeUndefined();
    // Cash view nets each day: Dr COGS = Cr bank, AP drops out.
    expect(await cashByAccount(f, '2026-11-28', '2026-11-28')).toEqual({ '1010': '-600.0000', '5010': '600.0000' });
  });
});

describe('cash view by document shape', () => {
  it('an unpaid bill is invisible on the cash basis', async () => {
    const { f, a } = await world();
    await entry(f, 'ap_bill', '2026-11-10', [[a.cogs, '250', 0], [a.ap, 0, '250']]);
    expect(await cashByAccount(f, '2026-11-01', '2026-12-31')).toEqual({});
  });

  it('daily sales and depreciation appear on their entry date in both views', async () => {
    const { f, a } = await world();
    await entry(f, 'pos_dsj', '2026-11-11', [[a.clearing, '900', 0], [a.sales, 0, '900']]);
    await entry(f, 'manual', '2026-11-30', [[a.depExp, '150', 0], [a.accDep, 0, '150']],
      { actor_type: 'user', created_by: f.user1, approved_by: f.user2, evidence_ids: [] });
    const cash = await cashByAccount(f, '2026-11-01', '2026-11-30');
    expect(cash).toEqual(await cashByAccount(f, '2026-11-01', '2026-11-30', 'accrual'));
    expect(cash).toMatchObject({ '1210': '900.0000', '4010': '-900.0000', '6810': '150.0000', '1590': '-150.0000' });
  });

  it('COD bill: the part paid in cash at delivery lands on the bill date, the rest on payment', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-12', [[a.cogs, '1000', 0], [a.cash, 0, '100'], [a.ap, 0, '900']]);
    expect(await cashByAccount(f, '2026-11-12', '2026-11-12')).toEqual({ '1010': '-100.0000', '5010': '100.0000' });
    const pay = await entry(f, 'ap_payment', '2026-11-20', [[a.ap, '900', 0], [a.cash, 0, '900']]);
    await apply(f, pay.id, bill.id, '900');
    expect(await cashByAccount(f, '2026-11-20', '2026-11-20')).toEqual({ '1010': '-900.0000', '5010': '900.0000' });
  });

  it('payroll: net pay on payday, withheld taxes when remitted', async () => {
    const { f, a } = await world();
    const run = await entry(f, 'payroll', '2026-11-13', [[a.wages, '1000', 0], [a.cash, 0, '700'], [a.payTax, 0, '300']]);
    const remit = await entry(f, 'bank', '2026-12-02', [[a.payTax, '300', 0], [a.cash, 0, '300']]);
    await apply(f, remit.id, run.id, '300');
    expect((await cashByAccount(f, '2026-11-01', '2026-11-30'))['6010']).toBe('700.0000');
    expect((await cashByAccount(f, '2026-12-01', '2026-12-31'))['6010']).toBe('300.0000');
  });

  it('invoice with sales tax: on receipt, sales and the tax liability both appear (cash-basis tax)', async () => {
    const { f, a } = await world();
    const inv = await entry(f, 'ar_invoice', '2026-11-05', [[a.ar, '1080', 0], [a.sales, 0, '1000'], [a.salesTax, 0, '80']]);
    expect(await cashByAccount(f, '2026-11-01', '2026-11-30')).toEqual({});
    const rec = await entry(f, 'ar_receipt', '2026-11-25', [[a.cash, '1080', 0], [a.ar, 0, '1080']]);
    await apply(f, rec.id, inv.id, '1080');
    expect(await cashByAccount(f, '2026-11-25', '2026-11-25')).toEqual({ '1010': '1080.0000', '2210': '-80.0000', '4010': '-1000.0000' });
  });

  it('payment with an early-pay discount: bank 980 + discount 20 settle a 1,000 bill', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '1000', 0], [a.ap, 0, '1000']]);
    const pay = await entry(f, 'ap_payment', '2026-11-13', [[a.ap, '1000', 0], [a.cash, 0, '980'], [a.disc, 0, '20']]);
    await apply(f, pay.id, bill.id, '1000');
    expect(await cashByAccount(f, '2026-11-01', '2026-11-30')).toEqual({ '1010': '-980.0000', '4910': '-20.0000', '5010': '1000.0000' });
  });

  it('a credit memo applied to a bill nets to zero; the rest is paid in cash', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '500', 0], [a.ap, 0, '500']]);
    const memo = await entry(f, 'ap_bill', '2026-11-06', [[a.ap, '50', 0], [a.cogs, 0, '50']]);
    await apply(f, memo.id, bill.id, '50');
    expect(await cashByAccount(f, '2026-11-01', '2026-11-30')).toEqual({});
    const pay = await entry(f, 'ap_payment', '2026-11-16', [[a.ap, '450', 0], [a.cash, 0, '450']]);
    await apply(f, pay.id, bill.id, '450');
    expect(await cashByAccount(f, '2026-11-01', '2026-11-30')).toEqual({ '1010': '-450.0000', '5010': '450.0000' });
    await expectCode(apply(f, memo.id, bill.id, '0.01'), 'OVER_APPLIED');
  });

  it('an unapplied payment stays visible in AP on the cash basis, so the cash TB still balances', async () => {
    const { f, a } = await world();
    await entry(f, 'ap_payment', '2026-11-09', [[a.ap, '75', 0], [a.cash, 0, '75']]);
    expect(await cashByAccount(f, '2026-11-01', '2026-11-30')).toEqual({ '1010': '-75.0000', '2010': '75.0000' });
    await actAs(db, f.user1);
    expect((await trialBalance(db, f.entityA, '2026-11-01', '2026-11-30', 'cash')).balanced).toBe(true);
    const t = await cashAccrualTieOut(db, f.entityA, '2026-11-01', '2026-11-30');
    expect([t.wcChangeCash.toFixed(4), t.difference.toFixed(4)]).toEqual(['75.0000', '0.0000']);
  });

  it('rounding: thirds paid in three parts land exactly, and every date balances to the cent', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-02', [
      [a.cogs, '33.3333', 0, f.locA1], [a.cogs, '33.3333', 0, f.locA2], [a.cogs, '33.3334', 0, f.locA1], [a.ap, 0, '100']]);
    for (const [d, amt] of [['2026-11-10', '33.33'], ['2026-11-20', '33.33'], ['2026-12-01', '33.34']] as const) {
      const p = await entry(f, 'ap_payment', d, [[a.ap, amt, 0], [a.cash, 0, amt]]);
      await apply(f, p.id, bill.id, amt);
    }
    await actAs(db, f.user1);
    const { rows: byDate } = await db.query(
      `select view_date, sum(amount)::text s from ledger.cash_lines($1) group by view_date`, [f.entityA]);
    for (const r of byDate) expect(r.s).toBe('0.0000');
    const { rows: byLine } = await db.query(
      `select c.line_id, sum(c.amount)::text s, (l.debit - l.credit)::text amt from ledger.cash_lines($1) c
         join ledger.journal_line l on l.id = c.line_id where c.entry_id = $2 group by c.line_id, l.debit, l.credit`,
      [f.entityA, bill.id]);
    for (const r of byLine) expect(r.s).toBe(r.amt);
  });
});

describe('payment application rules (database-enforced)', () => {
  it('refuses over-application, non-documents, non-payments and cross-entity links', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '100', 0], [a.ap, 0, '100']]);
    const pay = await entry(f, 'ap_payment', '2026-11-04', [[a.ap, '80', 0], [a.cash, 0, '80']]);
    const sales = await entry(f, 'pos_dsj', '2026-11-04', [[a.clearing, '10', 0], [a.sales, 0, '10']]);
    const wrongWay = await entry(f, 'bank', '2026-11-04', [[a.cash, '5', 0], [a.ap, 0, '5']]);
    const billB = await post(db, dsj(f, { entity_id: f.entityB, source_type: 'ap_bill', entry_date: '2026-11-04', lines: [
      { account_id: a.cogs, location_id: f.locB1, debit: '5' }, { account_id: a.ap, location_id: f.locB1, credit: '5' }] }));
    await expectCode(apply(f, pay.id, bill.id, '80.01'), 'OVER_APPLIED');
    await expectCode(apply(f, pay.id, sales.id, '1'), 'NOT_A_DOCUMENT');
    await expectCode(apply(f, sales.id, bill.id, '1'), 'NOT_A_PAYMENT');
    await expectCode(apply(f, wrongWay.id, bill.id, '1'), 'NOT_A_PAYMENT');
    await expectCode(apply(f, pay.id, billB.id, '1'), 'ENTITY_MISMATCH');
    await expectCode(apply(f, pay.id, bill.id, '0'), 'BAD_LINE_AMOUNT');
    await expectCode(apply(f, pay.id, bill.id, '1.00001'), 'BAD_LINE_AMOUNT');
    await apply(f, pay.id, bill.id, '80');
    const pay2 = await entry(f, 'ap_payment', '2026-11-05', [[a.ap, '50', 0], [a.cash, 0, '50']]);
    await expectCode(apply(f, pay2.id, bill.id, '20.01'), 'OVER_APPLIED'); // only 20 open on the bill
  });

  it('un-application restores the cash view; it happens once; rows are insert-only', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '100', 0], [a.ap, 0, '100']]);
    const pay = await entry(f, 'ap_payment', '2026-11-04', [[a.ap, '100', 0], [a.cash, 0, '100']]);
    const ap1 = await apply(f, pay.id, bill.id, '100');
    await actAs(db, f.integration);
    await unapplyPayment(db, ap1.id);
    expect(await cashByAccount(f, '2026-11-01', '2026-11-30')).toEqual({ '1010': '-100.0000', '2010': '100.0000' });
    await actAs(db, f.integration);
    await expectCode(unapplyPayment(db, ap1.id), 'ALREADY_UNAPPLIED');
    await apply(f, pay.id, bill.id, '100'); // capacity is back
    await expect(db.query(`insert into ledger.payment_application (tenant_id, entity_id, payment_entry_id, document_entry_id, amount, settled_on, created_by)
      values ($1,$2,$3,$4,1,'2026-11-04',$5)`, [f.tenant, f.entityA, pay.id, bill.id, f.integration])).rejects.toThrow(/permission denied/);
    await expectCode(su.query(`update ledger.payment_application set amount = 1 where id = $1`, [ap1.id]), 'IMMUTABLE');
    await expectCode(su.query(`delete from ledger.payment_application where id = $1`, [ap1.id]), 'IMMUTABLE');
  });

  it('settlement must land in an open period; soft needs an owner/controller override', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '100', 0], [a.ap, 0, '100']]);
    // A payment dated in soft-closed October (posted by the controller with the override).
    const pay = await post(db, dsj(f, { source_type: 'ap_payment', entry_date: '2026-10-30', allow_soft_close: true, lines: [
      { account_id: a.ap, location_id: f.locA1, debit: '100' }, { account_id: a.cash, location_id: f.locA1, credit: '100' }] }), f.user1);
    await expectCode(apply(f, pay.id, bill.id, '100'), 'PERIOD_CLOSED');
    await expectCode(db.query('select ledger.apply_payment($1, $2, 100, true)', [pay.id, bill.id]), 'SOFT_CLOSE_FORBIDDEN');
    await actAs(db, f.user1);
    const r = await applyPayment(db, pay.id, bill.id, '100', true);
    expect(r.settled_on).toBe('2026-10-30'); // the payment's date, never a parameter
    await db.query(`select ledger.close_period($1, 'hard')`, [f.periods.octA]);
    await expectCode(unapplyPayment(db, r.id, true), 'PERIOD_CLOSED');
  });

  it('agents and viewers cannot apply; other tenants cannot see or touch applications', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '10', 0], [a.ap, 0, '10']]);
    const pay = await entry(f, 'ap_payment', '2026-11-04', [[a.ap, '10', 0], [a.cash, 0, '10']]);
    await actAs(db, f.agent);
    await expectCode(applyPayment(db, pay.id, bill.id, '1'), 'AGENT_CANNOT_POST');
    await actAs(db, f.viewer);
    await expectCode(applyPayment(db, pay.id, bill.id, '1'), 'ROLE_FORBIDDEN');
    const other = await makeFixture(db);
    await actAs(db, other.user1);
    await expectCode(applyPayment(db, pay.id, bill.id, '1'), 'UNKNOWN_ENTRY');
    await expectCode(db.query('select * from ledger.trial_balance($1, null, $2)', [f.entityA, '2026-12-31']), 'UNKNOWN_ENTITY');
    expect((await db.query('select count(*)::int n from ledger.cash_lines($1)', [f.entityA])).rows[0].n).toBe(0);
  });
});

describe('reports', () => {
  it('TB balances on both bases; the balance sheet balances; basis defaults to the entity and is echoed', async () => {
    const { f, a } = await world();
    await entry(f, 'manual', '2026-11-01', [[a.cash, '5000', 0], [a.equity, 0, '5000']],
      { actor_type: 'user', created_by: f.user1, approved_by: f.user2, evidence_ids: [] });
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '400', 0], [a.ap, 0, '400']]);
    const pay = await entry(f, 'ap_payment', '2026-11-20', [[a.ap, '250', 0], [a.cash, 0, '250']]);
    await apply(f, pay.id, bill.id, '250');
    await entry(f, 'pos_dsj', '2026-11-21', [[a.clearing, '1200', 0], [a.sales, 0, '1200']]);
    await actAs(db, f.user1);
    for (const basis of ['accrual', 'cash'] as const) {
      const tb = await trialBalance(db, f.entityA, '2026-11-01', '2026-11-30', basis);
      expect([tb.basis, tb.balanced]).toEqual([basis, true]);
      const bs = await balanceSheet(db, f.entityA, '2026-11-30', basis);
      expect([bs.basis, bs.balanced]).toEqual([basis, true]);
    }
    const accBs = await balanceSheet(db, f.entityA, '2026-11-30', 'accrual');
    expect(accBs.lines.find((l) => l.number === '2010')?.amount.toFixed(4)).toBe('150.0000'); // AP still owed
    expect(accBs.lines.find((l) => l.name === 'Current year earnings')?.amount.toFixed(4)).toBe('800.0000');
    const cashBs = await balanceSheet(db, f.entityA, '2026-11-30', 'cash');
    expect(cashBs.lines.find((l) => l.number === '2010')).toBeUndefined();
    expect(cashBs.lines.find((l) => l.name === 'Current year earnings')?.amount.toFixed(4)).toBe('950.0000');
    // Default basis comes from the entity.
    expect((await trialBalance(db, f.entityA, null, '2026-11-30')).basis).toBe('accrual');
    await db.query(`update entity set default_basis = 'cash' where id = $1`, [f.entityA]);
    expect((await profitAndLoss(db, f.entityA, '2026-11-01', '2026-11-30')).basis).toBe('cash');
    await expectCode(db.query(`select * from ledger.trial_balance($1, null, '2026-11-30', 'cashish')`, [f.entityA]), 'BAD_INPUT');
  });

  it('earnings of the prior fiscal year roll into retained earnings', async () => {
    const { f, a } = await world();
    await entry(f, 'pos_dsj', '2026-12-15', [[a.clearing, '300', 0], [a.sales, 0, '300']]);
    await actAs(db, f.user1);
    await db.query('select ledger.create_fiscal_year($1, 2027)', [f.entityA]);
    await entry(f, 'pos_dsj', '2027-01-10', [[a.clearing, '120', 0], [a.sales, 0, '120']]);
    await actAs(db, f.user1);
    const bs = await balanceSheet(db, f.entityA, '2027-01-31', 'accrual');
    expect(bs.lines.find((l) => l.name === 'Retained earnings (prior years)')?.amount.toFixed(4)).toBe('300.0000');
    expect(bs.lines.find((l) => l.name === 'Current year earnings')?.amount.toFixed(4)).toBe('120.0000');
    expect(bs.balanced).toBe(true);
  });

  it('P&L by location; a location-scoped user sees only their store, with correct cash weights', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '60', 0, f.locA1], [a.cogs, '40', 0, f.locA2], [a.ap, 0, '100', f.locA2]]);
    const pay = await entry(f, 'ap_payment', '2026-11-10', [[a.ap, '50', 0, f.locA2], [a.cash, 0, '50', f.locA2]]);
    await apply(f, pay.id, bill.id, '50');
    await actAs(db, f.user1);
    const store1 = await profitAndLoss(db, f.entityA, '2026-11-01', '2026-11-30', { basis: 'cash', locationId: f.locA1 });
    expect(store1.expense.toFixed(4)).toBe('30.0000'); // half of store 1's 60
    await actAs(db, f.clerk); // scoped to store 1
    const scoped = await profitAndLoss(db, f.entityA, '2026-11-01', '2026-11-30', { basis: 'cash' });
    expect(scoped.expense.toFixed(4)).toBe('30.0000');
  });

  it('tie-out: NI_cash = NI_accrual - ΔAR - ΔPrepaids + ΔAP + ΔAccrued + ΔDeferred, to the cent', async () => {
    const { f, a } = await world();
    const bill = await entry(f, 'ap_bill', '2026-11-03', [[a.cogs, '700', 0], [a.ap, 0, '700']]);
    const inv = await entry(f, 'ar_invoice', '2026-11-04', [[a.ar, '2000', 0], [a.sales, 0, '2000']]);
    const run = await entry(f, 'payroll', '2026-11-13', [[a.wages, '900', 0], [a.cash, 0, '600'], [a.payTax, 0, '300']]);
    const pay = await entry(f, 'ap_payment', '2026-11-20', [[a.ap, '500', 0], [a.cash, 0, '500']]);
    const rec = await entry(f, 'ar_receipt', '2026-11-25', [[a.cash, '1500', 0], [a.ar, 0, '1500']]);
    await apply(f, pay.id, bill.id, '500');
    await apply(f, rec.id, inv.id, '1500');
    void run;
    await actAs(db, f.user1);
    const t = await cashAccrualTieOut(db, f.entityA, '2026-11-01', '2026-11-30');
    // Accrual NI = 2000 - 700 - 900 = 400. ΔAR = +500, ΔAP = +200, ΔAccrued (payroll tax) = +300.
    // Spec formula: 400 - 500 + 200 + 300 = 400. Line by line: sales 1500 - COGS 500 - wages 600 = 400.
    expect(t.niAccrual.toFixed(4)).toBe('400.0000');
    expect(t.niCash.toFixed(4)).toBe('400.0000');
    expect(t.wcChangeCash.toFixed(4)).toBe('0.0000'); // all cash applied: spec formula exactly
    expect(t.niAccrual.minus(t.wcChangeAccrual).toFixed(4)).toBe(t.niCash.toFixed(4));
    expect(t.difference.toFixed(4)).toBe('0.0000');
  });
});

describe('property: random documents, payments, partial and undone applications', () => {
  const N = Number(process.env.CASH_PROPERTY_N ?? 120);

  it(`${N} documents: every cash-view date balances, the tie-out holds to the cent, no over-application`, async () => {
    const { f, a } = await world();
    const locs = [f.locA1, f.locA2];
    const cents = fc.integer({ min: 1, max: 500_000 }).map((c) => new Decimal(c).div(100));
    const arb = fc.record({
      kind: fc.constantFrom('bill', 'cod', 'payroll', 'invoice', 'memo'),
      amts: fc.array(cents, { minLength: 1, maxLength: 3 }),
      loc: fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 3, maxLength: 3 }),
      day: fc.integer({ min: 1, max: 28 }),
      pays: fc.array(fc.record({ pct: fc.integer({ min: 1, max: 70 }), day: fc.integer({ min: 1, max: 31 }), undo: fc.boolean() }), { maxLength: 3 }),
      over: fc.boolean(),
    });
    const samples = fc.sample(arb, { numRuns: N, seed: 42 });
    let applied = 0, undone = 0, overRefused = 0;
    for (const g of samples) {
      const total = g.amts.reduce((x, y) => x.plus(y), new Decimal(0));
      const d = `2026-11-${String(g.day).padStart(2, '0')}`;
      const settle = g.amts.map((m, i) => [g.kind === 'invoice' ? a.sales : g.kind === 'payroll' ? a.wages : a.cogs, m, locs[g.loc[i]]] as const);
      const fmt = (x: Decimal) => x.toFixed(4);
      let lines: L[];
      let fund: Decimal; // the AR/AP (funding) amount open for settlement
      let payLines: (x: string) => L[];
      if (g.kind === 'invoice') {
        const tax = total.mul('0.08').toDecimalPlaces(2);
        fund = total.plus(tax);
        lines = [[a.ar, fmt(fund), 0, locs[g.loc[0]]], ...settle.map(([acc, m, l]) => [acc, 0, fmt(m), l] as L), [a.salesTax, 0, fmt(tax)]];
        payLines = (x) => [[a.cash, x, 0], [a.ar, 0, x]];
      } else if (g.kind === 'memo') {
        fund = total;
        lines = [[a.ap, fmt(total), 0], ...settle.map(([acc, m, l]) => [acc, 0, fmt(m), l] as L)];
        payLines = (x) => [[a.cash, x, 0], [a.ap, 0, x]]; // vendor refund
      } else {
        const cashPart = g.kind === 'bill' ? new Decimal(0) : total.mul('0.4').toDecimalPlaces(2);
        fund = total.minus(cashPart);
        lines = [...settle.map(([acc, m, l]) => [acc, fmt(m), 0, l] as L),
          ...(cashPart.gt(0) ? [[a.cash, 0, fmt(cashPart)] as L] : []),
          [g.kind === 'payroll' ? a.payTax : a.ap, 0, fmt(fund)]];
        payLines = (x) => [[g.kind === 'payroll' ? a.payTax : a.ap, x, 0], [a.cash, 0, x]];
      }
      if (fund.lte(0)) continue;
      const doc = await entry(f, g.kind === 'invoice' ? 'ar_invoice' : g.kind === 'payroll' ? 'payroll' : 'ap_bill', d, lines);
      let open = fund;
      for (const p of g.pays) {
        const x = Decimal.min(open, fund.mul(p.pct).div(100).toDecimalPlaces(2));
        if (x.lte(0)) continue;
        const pd = `2026-${p.day > 30 ? '12' : '11'}-${String(p.day > 30 ? 5 : p.day).padStart(2, '0')}`;
        const pay = await entry(f, 'bank', pd, payLines(fmt(x)));
        const r = await apply(f, pay.id, doc.id, fmt(x));
        applied++;
        open = open.minus(x);
        if (p.undo) {
          await actAs(db, f.integration);
          await unapplyPayment(db, r.id);
          undone++;
          open = open.plus(x);
        }
      }
      if (g.over) {
        const pay = await entry(f, 'bank', d, payLines(fmt(open.plus('0.01'))));
        await expectCode(apply(f, pay.id, doc.id, fmt(open.plus('0.01'))), 'OVER_APPLIED');
        overRefused++;
      }
    }

    await actAs(db, f.user1);
    const { rows: bad } = await db.query(
      `select view_date, sum(amount) s from ledger.cash_lines($1) group by view_date having sum(amount) <> 0`, [f.entityA]);
    expect(bad).toEqual([]);
    for (const [from, to] of [['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31'], ['2026-11-01', '2026-12-31']]) {
      const t = await cashAccrualTieOut(db, f.entityA, from, to);
      expect(t.difference.toFixed(4)).toBe('0.0000');
      for (const basis of ['accrual', 'cash'] as const) {
        expect((await trialBalance(db, f.entityA, from, to, basis)).balanced).toBe(true);
        expect((await balanceSheet(db, f.entityA, to, basis)).balanced).toBe(true);
      }
    }
    // No line ever re-dates more than its own amount.
    const { rows: overLines } = await db.query(
      `select c.line_id from ledger.cash_lines($1) c join ledger.journal_line l on l.id = c.line_id
        group by c.line_id, l.debit, l.credit having abs(sum(c.amount)) > abs(l.debit - l.credit)`, [f.entityA]);
    expect(overLines).toEqual([]);
    console.log(`cash property: ${samples.length} documents, ${applied} applications, ${undone} undone, ${overRefused} over-applications refused`);
  });
});
