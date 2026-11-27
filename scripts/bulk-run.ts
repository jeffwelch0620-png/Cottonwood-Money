// Exit-gate run (Build Spec §1): N random entries across several entities, then prove the books.
//   DATABASE_URL=<superuser url> BULK_N=1000000 npx tsx scripts/bulk-run.ts
// Creates a fresh database (BULK_DB, default ledger_bulk), posts through the same functions the app
// uses (as each tenant's Toast integration, via session claims), then checks per entity:
//   trial balance nets to 0.0000 · hash chain verifies · cash view balances on every date ·
//   cash/accrual tie-out difference 0.0000 · audit chain verifies — and times the reports.
// Writes a markdown report to BULK_REPORT (default docs/exit-gate/1m-run.md).
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Decimal } from 'decimal.js';
import { migrate } from '../db/migrate.js';

const BASE = process.env.PG_BASE_URL ?? 'postgres://postgres:postgres@localhost:5432';
const DB = process.env.BULK_DB ?? 'ledger_bulk';
const N = Number(process.env.BULK_N ?? 1_000_000);
const TENANTS = Number(process.env.BULK_TENANTS ?? 2);
const ENTITIES_PER_TENANT = Number(process.env.BULK_ENTITIES ?? 5);
const REPORT = process.env.BULK_REPORT ?? 'docs/exit-gate/1m-run.md';
const URL_ = `${BASE}/${DB}`;
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`);

// Deterministic pseudo-random (reproducible runs).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

interface Ent {
  tenant: string; entity: string; locs: string[]; integ: string; integAuth: string; ownerAuth: string; owner: string;
  acct: Record<string, string>; docs: string[];
}

async function setup(): Promise<Ent[]> {
  const admin = new pg.Client({ connectionString: `${BASE}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  await admin.end();
  await migrate(URL_);
  const su = new pg.Client({ connectionString: URL_ });
  await su.connect();
  const out: Ent[] = [];
  for (let t = 0; t < TENANTS; t++) {
    const ownerAuth = (await su.query(`insert into auth.users (email) values ($1) returning id`, [`owner${t}@bulk.local`])).rows[0].id;
    const integAuth = (await su.query(`insert into auth.users (email) values ($1) returning id`, [`toast${t}@bulk.local`])).rows[0].id;
    await su.query('set role app_role');
    const claims = (sub: string, tenant?: string) => su.query(`select set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ sub, aal: 'aal2', ...(tenant ? { tenant_id: tenant } : {}) })]);
    await claims(ownerAuth);
    const tenant = (await su.query(`select app.create_tenant($1, 'Owner') id`, [`Bulk group ${t + 1}`])).rows[0].id;
    await claims(ownerAuth, tenant);
    await su.query(`select ledger.load_coa_template('usar')`);
    await su.query(`insert into membership (user_id, tenant_id, role) values ($1, $2, 'service')`, [integAuth, tenant]);
    const integ = (await su.query(`insert into principal (tenant_id, kind, name, auth_user_id) values ($1, 'integration', 'Toast', $2) returning id`, [tenant, integAuth])).rows[0].id;
    const owner = (await su.query(`select id from principal where tenant_id = $1 and auth_user_id = $2`, [tenant, ownerAuth])).rows[0].id;
    const accts = Object.fromEntries((await su.query(`select number, id from account`)).rows.map((r) => [r.number, r.id]));
    const acct = { clearing: accts['1210'], cash: accts['1010'], ap: accts['2010'], food: accts['4010'], bev: accts['4110'],
                   tax: accts['2210'], cogs: accts['5010'], bevCost: accts['5110'], wages: accts['6010'], payTax: accts['2310'] };
    for (let e = 0; e < ENTITIES_PER_TENANT; e++) {
      const entity = (await su.query(`insert into entity (tenant_id, legal_name) values ($1, $2) returning id`, [tenant, `Concept ${t + 1}.${e + 1} LLC`])).rows[0].id;
      const locs: string[] = [];
      for (const n of ['North', 'South']) locs.push((await su.query(`insert into location (tenant_id, entity_id, name) values ($1,$2,$3) returning id`, [tenant, entity, n])).rows[0].id);
      await su.query('select ledger.create_fiscal_year($1, 2026)', [entity]);
      const docs: string[] = [];
      for (const type of ['pos_eod', 'invoice', 'bank_line', 'payroll_file']) {
        docs.push((await su.query(`insert into source_document (tenant_id, doc_type, storage_uri, sha256) values ($1,$2,$3,$4) returning id`,
          [tenant, type, `s3://evidence/bulk/${randomUUID()}`, createHash('sha256').update(randomUUID()).digest()])).rows[0].id);
      }
      out.push({ tenant, entity, locs, integ, integAuth, ownerAuth, owner, acct, docs });
    }
    await su.query('reset role');
  }
  await su.end();
  return out;
}

interface Stats { posted: number; refused: number; applied: number; byType: Record<string, number>; wrong: string[] }

async function worker(e: Ent, quota: number, seed: number, stats: Stats) {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  await c.query('set role app_role');
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: e.integAuth, tenant_id: e.tenant, aal: 'aal1' })]);
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const money = (lo: number, hi: number) => new Decimal(Math.floor(lo * 100 + r() * (hi - lo) * 100)).div(100);
  const date = (fromDay = 0) => {
    const day = fromDay + Math.floor(r() * (365 - fromDay));
    return new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
  };
  const dayOf = (d: string) => Math.round((Date.parse(d) - Date.UTC(2026, 0, 1)) / 86_400_000);
  const L = (account_id: string, location_id: string, debit: Decimal | 0, credit: Decimal | 0) =>
    ({ account_id, location_id, debit: debit ? debit.toFixed(4) : '0', credit: credit ? credit.toFixed(4) : '0' });
  const open: { id: string; amt: Decimal; day: number; kind: 'ap' | 'tax' }[] = [];
  const postE = async (source: string, entryDate: string, lines: unknown[], evidence: string) => {
    const { rows } = await c.query('select ledger.post_entry($1::jsonb) r', [JSON.stringify({
      tenant_id: e.tenant, entity_id: e.entity, entry_date: entryDate, source_type: source, idempotency_key: randomUUID(),
      actor_type: 'integration', created_by: e.integ, evidence_ids: [evidence], lines })]);
    return rows[0].r as { id: string };
  };
  let done = 0;
  while (done < quota) {
    const x = r();
    try {
      if (x < 0.70) {
        const store = pick(e.locs);
        const food = money(800, 9000), bev = money(100, 3000), tax = food.plus(bev).mul('0.07').toDecimalPlaces(2);
        await postE('pos_dsj', date(), [L(e.acct.clearing, store, food.plus(bev).plus(tax), 0), L(e.acct.food, store, 0, food),
          L(e.acct.bev, store, 0, bev), L(e.acct.tax, store, 0, tax)], e.docs[0]);
        stats.byType.sales++;
      } else if (x < 0.85) {
        const parts = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ amt: money(50, 4000), loc: pick(e.locs), acc: r() < 0.7 ? e.acct.cogs : e.acct.bevCost }));
        const total = parts.reduce((a, p) => a.plus(p.amt), new Decimal(0));
        const d = date(0);
        const b = await postE('ap_bill', d, [...parts.map((p) => L(p.acc, p.loc, p.amt, 0)), L(e.acct.ap, e.locs[0], 0, total)], e.docs[1]);
        open.push({ id: b.id, amt: total, day: dayOf(d), kind: 'ap' });
        stats.byType.bills++;
      } else if (x < 0.93 && open.length) {
        const i = Math.floor(r() * open.length);
        const doc = open[i];
        const amt = r() < 0.6 ? doc.amt : doc.amt.mul(r()).toDecimalPlaces(2);
        if (amt.lte(0)) continue;
        const acc = doc.kind === 'ap' ? e.acct.ap : e.acct.payTax;
        const p = await postE(doc.kind === 'ap' ? 'ap_payment' : 'bank', date(Math.min(364, doc.day)), [L(acc, e.locs[0], amt, 0), L(e.acct.cash, e.locs[0], 0, amt)], e.docs[2]);
        await c.query('select ledger.apply_payment($1, $2, $3::numeric)', [p.id, doc.id, amt.toFixed(4)]);
        stats.applied++;
        doc.amt = doc.amt.minus(amt);
        if (doc.amt.lte(0)) open.splice(i, 1);
        stats.byType.payments++;
      } else if (x < 0.98) {
        const gross = money(2000, 30000), withheld = gross.mul('0.3').toDecimalPlaces(2), store = pick(e.locs);
        const d = date();
        const p = await postE('payroll', d, [L(e.acct.wages, store, gross, 0), L(e.acct.cash, store, 0, gross.minus(withheld)), L(e.acct.payTax, store, 0, withheld)], e.docs[3]);
        open.push({ id: p.id, amt: withheld, day: dayOf(d), kind: 'tax' });
        stats.byType.payroll++;
      } else {
        const store = pick(e.locs);
        const amt = money(10, 500);
        try {
          await postE('pos_dsj', date(), [L(e.acct.clearing, store, amt.plus('0.01'), 0), L(e.acct.food, store, 0, amt)], e.docs[0]);
          stats.wrong.push('an unbalanced entry was accepted');
        } catch (err) {
          if (!/^UNBALANCED/.test((err as Error).message)) stats.wrong.push(`unexpected refusal: ${(err as Error).message}`);
          stats.refused++;
        }
        continue;
      }
      done++;
      stats.posted++;
    } catch (err) {
      stats.wrong.push(`${(err as Error).message}`.slice(0, 200));
      if (stats.wrong.length > 20) throw err;
    }
  }
  await c.end();
}

async function verifyAndTime(ents: Ent[]) {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  const rows: Record<string, unknown>[] = [];
  const timings: Record<string, number[]> = {};
  const time = async <T>(name: string, fn: () => Promise<T>) => {
    const s = performance.now();
    const v = await fn();
    (timings[name] ??= []).push(performance.now() - s);
    return v;
  };
  for (const e of ents) {
    await c.query('set role app_role');
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: e.ownerAuth, tenant_id: e.tenant, aal: 'aal2' })]);
    const tb = (await c.query(`select count(distinct entry_id)::int entries, count(*)::int lines, sum(debit)::text d, sum(credit)::text c
                                from ledger.journal_line where entity_id = $1`, [e.entity])).rows[0];
    const chain = await time('verify_chain (whole entity)', async () => (await c.query('select * from ledger.verify_chain($1)', [e.entity])).rows[0]);
    const tbAcc = await time('trial balance, accrual, FY', async () => (await c.query(`select sum(closing)::text s, sum(debits)::text d, sum(credits)::text c from ledger.trial_balance($1, '2026-01-01', '2026-12-31', 'accrual')`, [e.entity])).rows[0]);
    const tbCash = await time('trial balance, cash, FY', async () => (await c.query(`select sum(closing)::text s, sum(debits)::text d, sum(credits)::text c from ledger.trial_balance($1, '2026-01-01', '2026-12-31', 'cash')`, [e.entity])).rows[0]);
    await time('P&L, cash, one month', () => c.query(`select * from ledger.profit_and_loss($1, '2026-06-01', '2026-06-30', 'cash')`, [e.entity]));
    await time('P&L, accrual, one month', () => c.query(`select * from ledger.profit_and_loss($1, '2026-06-01', '2026-06-30', 'accrual')`, [e.entity]));
    await time('balance sheet, cash', () => c.query(`select * from ledger.balance_sheet($1, '2026-12-31', 'cash')`, [e.entity]));
    const tie = await time('cash/accrual tie-out, FY', async () => (await c.query(`select difference::text, ni_accrual::text, ni_cash::text from ledger.cash_accrual_tieout($1, '2026-01-01', '2026-12-31')`, [e.entity])).rows[0]);
    const badDates = await time('cash view, every date balanced', async () => (await c.query(`select count(*)::int n from (select view_date from ledger.cash_lines($1) group by view_date having sum(amount) <> 0) x`, [e.entity])).rows[0].n);
    const page = await time('journal page (50 newest)', async () => (await c.query(`select id from ledger.journal_entry where entity_id = $1 order by seq desc limit 50`, [e.entity])).rows);
    await time('entry viewer', () => c.query('select ledger.entry_detail($1)', [page[0].id]));
    rows.push({
      entity: e.entity.slice(0, 8), entries: tb.entries, lines: tb.lines, debits: tb.d, credits: tb.c,
      tb_zero: tb.d === tb.c && tbAcc.s === '0.0000' && tbCash.s === '0.0000' && tbCash.d === tbCash.c,
      chain: chain.ok ? `ok (${chain.checked})` : `BROKEN ${chain.reason} @${chain.first_bad_seq}`,
      cash_dates_unbalanced: badDates, tieout_diff: tie.difference, ni_accrual: tie.ni_accrual, ni_cash: tie.ni_cash,
    });
    await c.query('reset role');
    log(`verified ${e.entity.slice(0, 8)}: ${tb.entries} entries, TB ${tb.d === tb.c ? 'balanced' : 'NOT BALANCED'}, chain ${chain.ok}, tie-out ${tie.difference}`);
  }
  const audits: string[] = [];
  for (const t of [...new Set(ents.map((e) => e.tenant))]) {
    const e = ents.find((x) => x.tenant === t)!;
    await c.query('set role app_role');
    await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: e.ownerAuth, tenant_id: t, aal: 'aal2' })]);
    const a = (await c.query('select * from audit.verify_chain($1)', [t])).rows[0];
    audits.push(`${t.slice(0, 8)}: ${a.ok ? 'ok' : 'BROKEN'} (${a.checked} events)`);
    await c.query('reset role');
  }
  const size = (await c.query(`select pg_size_pretty(pg_database_size(current_database())) s`)).rows[0].s;
  await c.end();
  return { rows, timings, audits, size };
}

const ents = await setup();
log(`setup: ${TENANTS} tenants × ${ENTITIES_PER_TENANT} entities, posting ${N.toLocaleString()} entries with ${ents.length} workers`);
const stats: Stats = { posted: 0, refused: 0, applied: 0, byType: { sales: 0, bills: 0, payments: 0, payroll: 0 }, wrong: [] };
const quota = Math.ceil(N / ents.length);
// Rate per 30 s window: flat = posting cost doesn't grow with data size.
const windows: { at: number; rate: number }[] = [];
let lastPosted = 0;
const tick = setInterval(() => {
  const rate = Math.round((stats.posted - lastPosted) / 30);
  lastPosted = stats.posted;
  windows.push({ at: stats.posted, rate });
  log(`posted ${stats.posted.toLocaleString()} (window ${rate}/s, avg ${Math.round(stats.posted / ((Date.now() - tPost) / 1000))}/s), refused ${stats.refused}, problems ${stats.wrong.length}`);
}, 30_000);
const tPost = Date.now();
await Promise.all(ents.map((e, i) => worker(e, quota, 1000 + i, stats)));
clearInterval(tick);
const postSecs = (Date.now() - tPost) / 1000;
log(`posting done: ${stats.posted.toLocaleString()} in ${postSecs.toFixed(0)}s (${Math.round(stats.posted / postSecs)}/s)`);
const v = await verifyAndTime(ents);
const allGood = stats.wrong.length === 0 && v.rows.every((r) => r.tb_zero && String(r.chain).startsWith('ok') && r.cash_dates_unbalanced === 0 && r.tieout_diff === '0.0000') && v.audits.every((a) => a.includes(': ok'));
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const md = `# Exit-gate run: ${stats.posted.toLocaleString()} entries

Generated by \`scripts/bulk-run.ts\` on ${new Date().toISOString().slice(0, 10)} (PostgreSQL ${process.env.PG_VERSION ?? '16'}, ${ents.length} entities in ${TENANTS} tenants, 1 worker per entity).

**Result: ${allGood ? 'PASS' : 'FAIL'}** — every entity's trial balance nets to 0.0000 on both bases, every hash chain
and audit chain verifies, the cash view balances on every date, and the cash/accrual tie-out difference is 0.0000.

| Measure | Value |
|---|---|
| Entries posted | ${stats.posted.toLocaleString()} (sales ${stats.byType.sales.toLocaleString()}, bills ${stats.byType.bills.toLocaleString()}, payments ${stats.byType.payments.toLocaleString()}, payroll ${stats.byType.payroll.toLocaleString()}) |
| Payment applications | ${stats.applied.toLocaleString()} |
| Unbalanced entries refused | ${stats.refused.toLocaleString()} (all \`UNBALANCED\`) |
| Unexpected outcomes | ${stats.wrong.length}${stats.wrong.length ? ': ' + stats.wrong.slice(0, 5).join('; ') : ''} |
| Posting time | ${postSecs.toFixed(0)} s (${Math.round(stats.posted / postSecs).toLocaleString()} entries/s across ${ents.length} entities) |
| Database size | ${v.size} |
| Posting rate, first vs last 30 s window | ${windows.length > 2 ? `${windows.at(1)!.rate}/s at ${windows.at(1)!.at.toLocaleString()} entries → ${windows.at(-1)!.rate}/s at ${windows.at(-1)!.at.toLocaleString()}` : 'run too short to measure'} |

## Per entity

| Entity | Entries | Lines | Debits = credits | TB 0.0000 (accrual, cash) | Hash chain | Cash dates unbalanced | Tie-out difference | NI accrual | NI cash |
|---|---|---|---|---|---|---|---|---|---|
${v.rows.map((r) => `| ${r.entity} | ${Number(r.entries).toLocaleString()} | ${Number(r.lines).toLocaleString()} | ${r.debits} | ${r.tb_zero ? 'yes' : 'NO'} | ${r.chain} | ${r.cash_dates_unbalanced} | ${r.tieout_diff} | ${r.ni_accrual} | ${r.ni_cash} |`).join('\n')}

Audit chains: ${v.audits.join(' · ')}

## Report timings at this size (per entity, median of ${ents.length})

| Operation | Median | Max |
|---|---|---|
${Object.entries(v.timings).map(([k, xs]) => `| ${k} | ${med(xs).toFixed(0)} ms | ${Math.max(...xs).toFixed(0)} ms |`).join('\n')}
`;
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, md);
log(`${allGood ? 'PASS' : 'FAIL'} — report written to ${REPORT}`);
process.exit(allGood ? 0 : 1);
