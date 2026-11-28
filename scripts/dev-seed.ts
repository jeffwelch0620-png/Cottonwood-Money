// Dev only: builds a demo restaurant group through the same database functions the app uses,
// then prints a sign-in token per person. Needs a superuser DATABASE_URL (to create local auth
// users in the auth.users shim) and the API's SUPABASE_JWT_SECRET.
//   DATABASE_URL=postgres://postgres:postgres@localhost:5432/ledger_dev SUPABASE_JWT_SECRET=... npm run dev:seed
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { Decimal } from 'decimal.js';
import { migrate } from '../db/migrate.js';

const url = process.env.DATABASE_URL;
const secret = process.env.SUPABASE_JWT_SECRET;
if (!url || !secret) throw new Error('DATABASE_URL and SUPABASE_JWT_SECRET are required');
await migrate(url);
const db = new pg.Client({ connectionString: url });
await db.connect();

const authUser = async (email: string) => (await db.query('insert into auth.users (email) values ($1) returning id', [email])).rows[0].id as string;
const people = {
  owner: await authUser(`owner+${randomUUID().slice(0, 6)}@demo.local`),
  controller: await authUser(`controller+${randomUUID().slice(0, 6)}@demo.local`),
  bookkeeper: await authUser(`bookkeeper+${randomUUID().slice(0, 6)}@demo.local`),
  agent: await authUser(`agent+${randomUUID().slice(0, 6)}@demo.local`),
  toast: await authUser(`toast+${randomUUID().slice(0, 6)}@demo.local`),
};
await db.query('set role app_role');
let tenant = '';
const as = async (who: keyof typeof people, aal = 'aal2') =>
  db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: people[who], aal, ...(tenant ? { tenant_id: tenant } : {}) })]);
const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0];

await as('owner');
tenant = (await one(`select app.create_tenant('Harbor & Vine Restaurant Group', 'Morgan Lee') id`)).id;
await as('owner');
await one(`select ledger.load_coa_template('usar')`);
const ent = (await one(`insert into entity (tenant_id, legal_name, fiscal_calendar) values ($1, 'Harbor & Vine Bistro LLC', 'calendar_month') returning id`, [tenant])).id;
const loc = async (name: string) => (await one(`insert into location (tenant_id, entity_id, name, pos_system) values ($1,$2,$3,'Toast') returning id`, [tenant, ent, name])).id;
const harbor = await loc('Harbor St');
const vine = await loc('Vine Ave');
await one('select ledger.create_fiscal_year($1, 2026)', [ent]);
const member = async (who: keyof typeof people, role: string, kind: string, name: string, extra: { loc?: string[]; limit?: string } = {}) => {
  await one(`insert into membership (user_id, tenant_id, role, location_ids, approval_limit) values ($1,$2,$3,$4,$5) returning id`, [people[who], tenant, role, extra.loc ?? null, extra.limit ?? null]);
  return (await one(`insert into principal (tenant_id, kind, name, auth_user_id) values ($1,$2,$3,$4) returning id`, [tenant, kind, name, people[who]])).id as string;
};
await member('controller', 'controller', 'user', 'Sam Ortiz');
await member('bookkeeper', 'bookkeeper', 'user', 'Riley Chen', { loc: [harbor], limit: '2500' });
const agentP = await member('agent', 'service', 'agent', 'AP agent');
const toastP = await member('toast', 'service', 'integration', 'Toast connector');
// Step 1.2: register the AP agent (tools + policy); unregistered agents cannot propose.
const agentId = (await one(`select agents.create_agent($1::jsonb) id`, [JSON.stringify({ principal_id: agentP, name: 'AP agent', kind: 'ap' })])).id as string;
await one(`select agents.set_agent_tools($1, array['read_accounts','read_locations','read_evidence','propose_entry'])`, [agentId]);
await one(`select agents.set_agent_policy($1, $2::jsonb)`, [agentId, JSON.stringify({ max_amount: '10000', min_confidence: '0.7', allowed_source_types: ['ap_bill'] })]);
const acct = async (n: string) => (await one('select id from account where number = $1', [n])).id as string;
const A = { cash: await acct('1010'), clearing: await acct('1210'), ap: await acct('2010'), food: await acct('4010'), bev: await acct('4110'),
            cogs: await acct('5010'), equity: await acct('3010'), rent: await acct('8010'), tax: await acct('2210') };
const doc = async (type: string) => (await one(`insert into source_document (tenant_id, doc_type, storage_uri, sha256) values ($1,$2,$3,$4) returning id`,
  [tenant, type, `s3://evidence/demo/${randomUUID()}.pdf`, createHash('sha256').update(randomUUID()).digest()])).id as string;
const postAs = async (who: keyof typeof people, e: Record<string, unknown>) => {
  await as(who);
  return (await one('select ledger.post_entry($1::jsonb) r', [JSON.stringify({ tenant_id: tenant, entity_id: ent, idempotency_key: randomUUID(), ...e })])).r;
};
const L = (account_id: string, location_id: string, debit: string, credit: string) => ({ account_id, location_id, debit, credit });

// Opening equity (manual: controller proposes, owner approves).
await as('controller');
const d0 = (await one('select ledger.propose_entry($1::jsonb) id', [JSON.stringify({ tenant_id: tenant, entity_id: ent, entry_date: '2026-01-02', source_type: 'opening', memo: 'Owner capital contribution',
  lines: [L(A.cash, harbor, '150000', '0'), L(A.equity, harbor, '0', '150000')] })])).id;
await as('owner');
await one('select ledger.approve_draft($1)', [d0]);
// Daily sales from Toast, Jan through Nov, for both stores (weekly batches to keep it light).
const ctrlP = (await one(`select id from principal where auth_user_id = $1`, [people.controller])).id;
for (let m = 1; m <= 11; m++) {
  for (const day of [7, 14, 21, 28]) {
    for (const [store, base] of [[harbor, 9000], [vine, 7000]] as const) {
      const food = new Decimal(base).plus((m * 37 + day * 11) % 900);
      const bev = new Decimal(base).mul('0.28').plus((m * 13 + day * 7) % 300);
      const [f2, b2, total] = [food.toFixed(2), bev.toFixed(2), food.plus(bev).toFixed(2)];
      await postAs('toast', { entry_date: `2026-${String(m).padStart(2, '0')}-${day}`, source_type: 'pos_dsj', actor_type: 'integration', created_by: toastP,
        memo: 'Toast daily sales', evidence_ids: [await doc('pos_eod')], lines: [L(A.clearing, store, total, '0'), L(A.food, store, '0', f2), L(A.bev, store, '0', b2)] });
    }
  }
  // Monthly food bill and rent; bills are paid the following month.
  const bill = await postAs('controller', { entry_date: `2026-${String(m).padStart(2, '0')}-10`, source_type: 'ap_bill', actor_type: 'user', created_by: ctrlP,
    memo: 'Sysco food purchases', evidence_ids: [await doc('invoice')], lines: [L(A.cogs, harbor, '18500.00', '0'), L(A.cogs, vine, '14200.00', '0'), L(A.ap, harbor, '0', '32700.00')] });
  await postAs('controller', { entry_date: `2026-${String(m).padStart(2, '0')}-01`, source_type: 'bank', actor_type: 'user', created_by: ctrlP,
    memo: 'Rent', evidence_ids: [await doc('bank_line')], lines: [L(A.rent, harbor, '12000', '0'), L(A.rent, vine, '9500', '0'), L(A.cash, harbor, '0', '21500')] });
  if (m <= 10) {
    const pay = await postAs('controller', { entry_date: `2026-${String(m + 1).padStart(2, '0')}-05`, source_type: 'ap_payment', actor_type: 'user', created_by: ctrlP,
      memo: 'Sysco payment', evidence_ids: [await doc('bank_line')], lines: [L(A.ap, harbor, '32700.00', '0'), L(A.cash, harbor, '0', '32700.00')] });
    await as('controller');
    await one('select ledger.apply_payment($1, $2, 32700)', [pay.id, bill.id]);
  }
}
// Close Jan-Sep hard, seal Jan-Jun, Oct soft.
await as('controller');
const periods = (await db.query('select id from period where entity_id = $1 order by start_date', [ent])).rows.map((r) => r.id);
for (const p of periods.slice(0, 9)) await one(`select ledger.close_period($1, 'hard')`, [p]);
for (const p of periods.slice(0, 6)) await one('select ledger.seal_period($1)', [p]);
await one(`select ledger.close_period($1, 'soft')`, [periods[9]]);
// Waiting for approval: an agent-proposed bill and a bookkeeper accrual.
await as('agent', 'aal1');
const agentRun = (await one(`select agents.start_run('code invoice 88213') id`)).id as string;
const agentCall = (await one(`select agents.log_model_call($1, $2::jsonb) id`, [agentRun, JSON.stringify({
  model: 'simulated', model_version: 'demo-seed', request: { invoice: '88213' }, stop_reason: 'tool_use' })])).id as string;
await one('select ledger.propose_entry($1::jsonb)', [JSON.stringify({ tenant_id: tenant, entity_id: ent, entry_date: '2026-11-18', source_type: 'ap_bill', memo: 'Coastal Seafood invoice 88213 (extracted by AP agent)',
  evidence_ids: [await doc('invoice')], lines: [L(A.cogs, harbor, '4280.50', '0'), L(A.ap, harbor, '0', '4280.50')],
  agent: { run_id: agentRun, model_call_id: agentCall, confidence: 0.93 } })]);
await one(`select agents.finish_run($1, 'succeeded')`, [agentRun]);
await as('bookkeeper');
await one('select ledger.propose_entry($1::jsonb)', [JSON.stringify({ tenant_id: tenant, entity_id: ent, entry_date: '2026-11-20', source_type: 'manual', memo: 'Reclass beverage comps',
  lines: [L(A.food, harbor, '310.00', '0'), L(A.bev, harbor, '0', '310.00')] })]);
await db.end();

const tok = async (who: keyof typeof people) => new SignJWT({ aal: 'aal2', role: 'authenticated', tenant_id: tenant })
  .setProtectedHeader({ alg: 'HS256' }).setSubject(people[who]).setAudience('authenticated').setIssuedAt().setExpirationTime('12h')
  .sign(new TextEncoder().encode(secret));
const tokens = { tenant, owner: await tok('owner'), controller: await tok('controller'), bookkeeper: await tok('bookkeeper') };
const out = process.env.SEED_OUT;
if (out) writeFileSync(out, JSON.stringify(tokens, null, 2));
console.log(`Seeded tenant ${tenant}.${out ? ` Tokens written to ${out}.` : ''}`);
if (!out) for (const [k, v] of Object.entries(tokens)) if (k !== 'tenant') console.log(`\n${k}:\n${v}`);
