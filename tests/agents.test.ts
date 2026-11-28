// Phase 1 step 1.2: agent runtime (L1). Acceptance (Phase 1 Build Spec §6, step 1.2):
//   1. agents can't call tools outside their allow-list
//   2. proposals outside policy limits are refused by the database
//   3. the kill switch stops proposals immediately
//   4. every model call is logged
// plus: people's decisions on proposals are stored as labeled examples.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  appClient, superClient, makeFixture, actAs, authOf, createAuthUsers, expectCode, count, waitUntilBlocked,
  TEST_URL, type Fixture,
} from './helpers.js';
import { AgentRuntime, SimulatedModel, standardTools, callCost, type SimTurn, type ModelRequest } from '../modules/agents/index.js';

let db: pg.Client;
let su: pg.Client;
let pool: pg.Pool;
let f: Fixture;

/** A new agent principal with a service login, registered with the given tools and policy. */
async function newAgent(tools: string[], policy?: Record<string, unknown>) {
  const [auth] = await createAuthUsers(1);
  await actAs(db, f.user2);
  await db.query(`insert into membership (user_id, tenant_id, role) values ($1, $2, 'service')`, [auth, f.tenant]);
  const principal = (await db.query(`insert into principal (tenant_id, kind, name, auth_user_id) values ($1, 'agent', $2, $3) returning id`,
    [f.tenant, `Agent ${randomUUID().slice(0, 6)}`, auth])).rows[0].id as string;
  const id = (await db.query(`select agents.create_agent($1::jsonb) id`, [JSON.stringify({ principal_id: principal, name: 'Test agent', kind: 'ap' })])).rows[0].id as string;
  await db.query('select agents.set_agent_tools($1, $2)', [id, tools]);
  if (policy) await db.query('select agents.set_agent_policy($1, $2::jsonb)', [id, JSON.stringify(policy)]);
  return { id, principal, auth, who: { authUserId: auth, tenantId: f.tenant } };
}

/** Acts as the agent (raw claims: service logins skip MFA) and opens a run with one logged model call. */
async function asAgent(auth: string) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: auth, tenant_id: f.tenant, aal: 'aal1' })]);
}
async function openRun(auth: string) {
  await asAgent(auth);
  const run = (await db.query(`select agents.start_run('test') id`)).rows[0].id as string;
  const mc = (await db.query(`select agents.log_model_call($1, $2::jsonb) id`, [run, JSON.stringify({ model: 'simulated', request: { n: randomUUID() } })])).rows[0].id as string;
  return { run, mc };
}

const bill = (over: Record<string, unknown> = {}, amount = '120.00') => ({
  tenant_id: f.tenant, entity_id: f.entityA, entry_date: '2026-11-20', source_type: 'ap_bill', memo: 'Produce invoice',
  evidence_ids: [f.doc],
  lines: [
    { account_id: f.acct.cogs, location_id: f.locA1, debit: amount },
    { account_id: f.acct.ap, location_id: f.locA1, credit: amount },
  ],
  ...over,
});
const propose = async (auth: string, entry: unknown) => {
  await asAgent(auth);
  return (await db.query('select ledger.propose_entry($1::jsonb) id', [JSON.stringify(entry)])).rows[0].id as string;
};

const policy = () => ({
  max_amount: '500', min_confidence: '0.8', allowed_source_types: ['ap_bill'],
  allowed_account_ids: [f.acct.cogs, f.acct.ap], allowed_location_ids: [f.locA1],
});

const runtime = (script: (req: ModelRequest, turn: number) => SimTurn | Promise<SimTurn>) => {
  const model = new SimulatedModel(script);
  return { model, rt: new AgentRuntime({ pool, model, tools: standardTools }) };
};
const task = { purpose: 'code a bill', system: 'You are an AP agent. Propose entries; never guess accounts.', prompt: 'Code invoice 123.' };

beforeAll(async () => {
  db = await appClient();
  su = await superClient();
  pool = new pg.Pool({ connectionString: TEST_URL, max: 6 });
  f = await makeFixture(db);
});
afterAll(async () => {
  await pool.end();
  await db.end();
  await su.end();
});

describe('1. agents cannot call tools outside their allow-list', () => {
  it('the model is shown only allowed tools; anything else it asks for is refused and recorded', async () => {
    const a = await newAgent(['read_accounts'], policy());
    const { model, rt } = runtime((_req, turn) => turn === 1
      ? { tool_calls: [{ name: 'propose_entry', input: bill() }, { name: 'post_entry', input: {} }, { name: 'read_accounts', input: {} }] }
      : { text: 'done' });
    const r = await rt.run(a.who, task);
    expect(model.requests[0].tools.map((t) => t.name)).toEqual(['read_accounts']);
    expect(r.status).toBe('succeeded');
    expect(r.refusedTools).toEqual([{ tool: 'propose_entry', refusal: 'TOOL_NOT_ALLOWED' }, { tool: 'post_entry', refusal: 'TOOL_NOT_ALLOWED' }]);
    expect(r.proposals).toEqual([]);
    // The refusals went back to the model as errors, and the allowed call ran.
    const results = (model.requests[1].messages[2].content as any[]);
    expect(results.map((x) => [x.is_error ?? false, String(x.content).split(':')[0]])).toEqual(
      [[true, 'TOOL_NOT_ALLOWED'], [true, 'TOOL_NOT_ALLOWED'], [false, results[2].content.split(':')[0]]]);
    const calls = (await su.query('select tool, allowed, refusal from agents.tool_call where run_id = $1 order by at, tool', [r.runId])).rows;
    expect(calls.map((c) => `${c.tool}:${c.allowed}:${c.refusal}`).sort()).toEqual(
      ['post_entry:false:TOOL_NOT_ALLOWED', 'propose_entry:false:TOOL_NOT_ALLOWED', 'read_accounts:true:null']);
  });

  it('the database refuses a proposal from an agent without propose_entry, even bypassing the runtime', async () => {
    const a = await newAgent(['read_accounts'], policy());
    const { run, mc } = await openRun(a.auth);
    await expectCode(propose(a.auth, bill({ agent: { run_id: run, model_call_id: mc, confidence: 0.95 } })), 'TOOL_NOT_ALLOWED');
  });

  it('no allow-list can grant a tool that is not an agent tool', async () => {
    const a = await newAgent([]);
    await actAs(db, f.user2);
    await expectCode(db.query(`select agents.set_agent_tools($1, array['propose_entry','post_entry'])`, [a.id]), 'UNKNOWN_TOOL');
    await expectCode(db.query(`select agents.set_agent_tools($1, array['set_agent_policy'])`, [a.id]), 'UNKNOWN_TOOL');
  });

  it('an agent cannot change agents, policies, the chart of accounts, users or permissions', async () => {
    const a = await newAgent(['read_accounts'], policy());
    await asAgent(a.auth);
    await expectCode(db.query(`select agents.set_agent_tools($1, agents.known_tools())`, [a.id]), 'ROLE_FORBIDDEN');
    await expectCode(db.query(`select agents.set_agent_policy($1, $2::jsonb)`, [a.id, JSON.stringify({ ...policy(), max_amount: '1000000' })]), 'ROLE_FORBIDDEN');
    await expectCode(db.query(`select agents.set_agent_enabled($1, true, 'me')`, [a.id]), 'ROLE_FORBIDDEN');
    await expectCode(db.query(`select agents.create_agent($1::jsonb)`, [JSON.stringify({ principal_id: a.principal, name: 'x', kind: 'ap' })]), 'ROLE_FORBIDDEN');
    await expect(db.query(`insert into account (tenant_id, number, name, type, normal_balance, cash_view) values ($1, '9999', 'x', 'expense', 'D', 'settle')`, [f.tenant]))
      .rejects.toThrow(/row-level security/);
    await expect(db.query(`insert into membership (user_id, tenant_id, role) values ($1, $2, 'owner')`, [a.auth, f.tenant])).rejects.toThrow(/row-level security/);
    await expect(db.query(`update agents.agent set enabled = true where id = $1`, [a.id])).rejects.toThrow(/permission denied/);
    await expect(db.query(`insert into agents.agent_tool values ($1, $2, 'propose_entry')`, [a.id, f.tenant])).rejects.toThrow(/permission denied/);
  });
});

describe('2. proposals outside policy limits are refused by the database', () => {
  let a: Awaited<ReturnType<typeof newAgent>>;
  let meta: (confidence?: number) => Record<string, unknown>;
  beforeAll(async () => {
    a = await newAgent(['propose_entry'], { ...policy(), allowed_vendor_ids: [randomUUID()] });
    const { run, mc } = await openRun(a.auth);
    meta = (confidence = 0.95) => ({ run_id: run, model_call_id: mc, confidence });
  });

  it('inside every limit: accepted, and the draft is linked to its run, model call and confidence', async () => {
    const d = await propose(a.auth, bill({ agent: meta(0.91) }));
    const p = (await su.query('select agent_id, confidence::text from agents.agent_proposal where draft_id = $1', [d])).rows[0];
    expect(p).toEqual({ agent_id: a.id, confidence: '0.9100' });
    const stored = (await su.query('select payload from ledger.je_draft where id = $1', [d])).rows[0].payload;
    expect(stored.agent).toBeUndefined(); // metadata lives in agent_proposal, not in the entry
  });

  it.each([
    ['over the amount limit', () => bill({ agent: meta() }, '500.01'), 'POLICY_AMOUNT'],
    ['an account outside the policy', () => bill({ agent: meta(), lines: [
      { account_id: f.acct.cogs, location_id: f.locA1, debit: '10' }, { account_id: f.acct.cash, location_id: f.locA1, credit: '10' }] }), 'POLICY_ACCOUNT'],
    ['a location outside the policy', () => bill({ agent: meta(), lines: [
      { account_id: f.acct.cogs, location_id: f.locA2, debit: '10' }, { account_id: f.acct.ap, location_id: f.locA2, credit: '10' }] }), 'POLICY_LOCATION'],
    ['a source type outside the policy', () => bill({ agent: meta(), source_type: 'ap_payment' }), 'POLICY_SOURCE_TYPE'],
    ['confidence below the minimum', () => bill({ agent: meta(0.79) }), 'POLICY_CONFIDENCE'],
    ['confidence that is not a number', () => bill({ agent: { ...meta(), confidence: 'sure' } }), 'BAD_CONFIDENCE'],
    ['a vendor outside the policy', () => bill({ agent: meta(), vendor_id: randomUUID() }), 'POLICY_VENDOR'],
    ['no agent metadata', () => bill(), 'MISSING_AGENT_META'],
  ])('%s is refused', async (_name, entry, code) => {
    await expectCode(propose(a.auth, entry()), code);
  });

  it('an agent without a policy may propose nothing (deny by default)', async () => {
    const b = await newAgent(['propose_entry']);
    const { run, mc } = await openRun(b.auth);
    await expectCode(propose(b.auth, bill({ agent: { run_id: run, model_call_id: mc, confidence: 1 } })), 'NO_POLICY');
  });

  it('policies cannot let agents propose reversals, intercompany or opening entries', async () => {
    await actAs(db, f.user2);
    await expectCode(db.query('select agents.set_agent_policy($1, $2::jsonb)', [a.id, JSON.stringify({ ...policy(), allowed_source_types: ['ap_bill', 'reversal'] })]), 'BAD_SOURCE_TYPE');
  });

  it('a malformed list is refused instead of silently meaning "no restriction"', async () => {
    await actAs(db, f.user2);
    const set = (over: Record<string, unknown>) => db.query('select agents.set_agent_policy($1, $2::jsonb)', [a.id, JSON.stringify({ ...policy(), ...over })]);
    await expectCode(set({ allowed_account_ids: f.acct.cogs }), 'BAD_POLICY');            // a string, not a list
    await expectCode(set({ allowed_source_types: ['ap_bill', null] }), 'BAD_POLICY');     // a null element
    await expectCode(set({ allowed_location_ids: { a: f.locA1 } }), 'BAD_POLICY');
    await expectCode(set({ allowed_source_types: 'ap_bill' }), 'BAD_POLICY');
    // The policy in force is unchanged: still limited to ap_bill at store 1.
    const pol = (await su.query('select allowed_source_types, allowed_location_ids from agents.agent_policy where agent_id = $1', [a.id])).rows[0];
    expect(pol).toEqual({ allowed_source_types: ['ap_bill'], allowed_location_ids: [f.locA1] });
  });

  it('through the runtime: the refusal goes back to the model as an error and nothing is drafted', async () => {
    const b = await newAgent(['propose_entry'], policy());
    const { model, rt } = runtime((_req, turn) => turn === 1
      ? { tool_calls: [{ name: 'propose_entry', input: { ...bill({}, '900.00'), confidence: 0.99 } }] }
      : { text: 'The bill is over my limit; leaving it for a person.' });
    const r = await rt.run(b.who, task);
    expect(r).toMatchObject({ status: 'succeeded', proposals: [], toolErrors: [{ tool: 'propose_entry', error: expect.stringMatching(/^POLICY_AMOUNT/) }] });
    expect((model.requests[1].messages[2].content as any[])[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/^POLICY_AMOUNT/) });
  });
});

describe('3. the kill switch stops proposals immediately', () => {
  it('a switched-off agent cannot start a run, call a tool, or propose', async () => {
    const a = await newAgent(['propose_entry', 'read_accounts'], policy());
    const { run, mc } = await openRun(a.auth);
    await actAs(db, f.user2);
    await db.query(`select agents.set_agent_enabled($1, false, 'bad proposals')`, [a.id]);
    await expectCode(propose(a.auth, bill({ agent: { run_id: run, model_call_id: mc, confidence: 0.9 } })), 'AGENT_DISABLED');
    await asAgent(a.auth);
    await expectCode(db.query(`select agents.start_run('again')`), 'AGENT_DISABLED');
    expect((await db.query(`select agents.authorize_tool($1, 'read_accounts', '{}'::jsonb) r`, [run])).rows[0].r).toEqual({ allowed: false, refusal: 'AGENT_DISABLED' });
    await expect(runtime(() => ({ text: 'x' })).rt.run(a.who, task)).rejects.toThrow(/^AGENT_DISABLED/);
    const ev = (await su.query(`select detail from audit.event where object_id = $1 and action = 'agent.kill'`, [a.id])).rows[0].detail;
    expect(ev).toEqual({ reason: 'bad proposals', was_enabled: true });
    // Switched back on: proposals are accepted again.
    await actAs(db, f.user2);
    await db.query(`select agents.set_agent_enabled($1, true, 'fixed')`, [a.id]);
    expect(await propose(a.auth, bill({ agent: { run_id: run, model_call_id: mc, confidence: 0.9 } }))).toBeTruthy();
  });

  it('switched off during a run: the next tool call stops the run; nothing is proposed', async () => {
    const a = await newAgent(['propose_entry', 'read_accounts'], policy());
    const { rt } = runtime(async (_req, turn) => {
      if (turn === 1) return { tool_calls: [{ name: 'read_accounts', input: {} }] };
      const owner = await appClient();
      await actAs(owner, f.user2);
      await owner.query(`select agents.set_agent_enabled($1, false, 'stop now')`, [a.id]);
      await owner.end();
      return { tool_calls: [{ name: 'propose_entry', input: { ...bill(), confidence: 0.99 } }] };
    });
    const r = await rt.run(a.who, task);
    expect(r).toMatchObject({ status: 'stopped', proposals: [], refusedTools: [{ tool: 'propose_entry', refusal: 'AGENT_DISABLED' }] });
    expect((await su.query('select status from agents.agent_run where id = $1', [r.runId])).rows[0].status).toBe('stopped');
    expect(await count(su, 'select count(*) n from agents.agent_proposal where agent_id = $1', [a.id])).toBe(0);
  });

  it('race: a proposal waiting on an uncommitted switch-off is refused the moment it commits', async () => {
    const a = await newAgent(['propose_entry'], policy());
    const { run, mc } = await openRun(a.auth);
    const owner = await appClient();
    const agentDb = await appClient();
    try {
      await actAs(owner, f.user2);
      await owner.query('begin');
      await owner.query(`select agents.set_agent_enabled($1, false, 'race')`, [a.id]);
      await agentDb.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: a.auth, tenant_id: f.tenant, aal: 'aal1' })]);
      const pid = (await agentDb.query('select pg_backend_pid() p')).rows[0].p;
      const pending = agentDb.query('select ledger.propose_entry($1::jsonb)', [JSON.stringify(bill({ agent: { run_id: run, model_call_id: mc, confidence: 0.9 } }))]);
      const settled = pending.then(() => 'accepted', (e: Error) => e.message);
      await waitUntilBlocked(pid);            // the proposal is really waiting on the switch
      await owner.query('commit');
      expect(await settled).toMatch(/^AGENT_DISABLED/);
    } finally {
      await owner.end();
      await agentDb.end();
    }
  });
});

describe('4. every model call is logged', () => {
  it('each turn: model, answering version, prompt hash, inputs, output, tokens and cost', async () => {
    const a = await newAgent(['read_accounts', 'propose_entry'], policy());
    const { rt } = runtime((_req, turn) => turn < 3
      ? { tool_calls: [{ name: 'read_accounts', input: {} }], usage: { input_tokens: 1000, output_tokens: 200 } }
      : { text: 'done', usage: { input_tokens: 1500, output_tokens: 100 } });
    const r = await rt.run(a.who, { ...task, inputRefs: [f.doc] });
    expect(r.status).toBe('succeeded');
    const calls = (await su.query(`select turn, model, model_version, encode(prompt_hash, 'hex') h, input_refs, output, stop_reason,
                                          status, input_tokens::int, output_tokens::int, cost_usd::text
                                     from agents.model_call where run_id = $1 order by turn`, [r.runId])).rows;
    expect(calls.map((c) => [c.turn, c.model, c.model_version, c.stop_reason, c.status])).toEqual([
      [1, 'claude-opus-5-5', 'simulated-1', 'tool_use', 'ok'],
      [2, 'claude-opus-5-5', 'simulated-1', 'tool_use', 'ok'],
      [3, 'claude-opus-5-5', 'simulated-1', 'end_turn', 'ok'],
    ]);
    expect(new Set(calls.map((c) => c.h)).size).toBe(3);             // each prompt differs (history grows)
    expect(calls.every((c) => c.input_refs.includes(f.doc))).toBe(true);
    expect(calls[0].output[0]).toMatchObject({ type: 'tool_use', name: 'read_accounts' });
    // $4 / $20 per million tokens: 1000 in + 200 out = 0.0040 + 0.0040; 1500 in + 100 out = 0.0060 + 0.0020
    expect(calls.map((c) => c.cost_usd)).toEqual(['0.0080', '0.0080', '0.0080']);
    expect(r.costUsd).toBe('0.0240');
    expect(callCost('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }).toFixed(4)).toBe('24.4000');
  });

  it('a failed model call is logged too, and the run fails', async () => {
    const a = await newAgent(['read_accounts'], policy());
    const { rt } = runtime(() => ({ error: 'overloaded_error: 529' }));
    const r = await rt.run(a.who, task);
    expect(r).toMatchObject({ status: 'failed', error: 'MODEL_ERROR: overloaded_error: 529' });
    expect((await su.query('select status, error from agents.model_call where run_id = $1', [r.runId])).rows).toEqual([{ status: 'error', error: 'overloaded_error: 529' }]);
  });

  it('a refusal ends the run as refused, logged', async () => {
    const a = await newAgent(['read_accounts'], policy());
    const r = await runtime(() => ({ stop_reason: 'refusal' })).rt.run(a.who, task);
    expect(r.status).toBe('refused');
    expect((await su.query('select stop_reason from agents.model_call where run_id = $1', [r.runId])).rows[0].stop_reason).toBe('refusal');
  });

  it('the database refuses a proposal that does not cite a logged, successful model call of its own run', async () => {
    const a = await newAgent(['propose_entry'], policy());
    const one = await openRun(a.auth);
    const two = await openRun(a.auth);
    await expectCode(propose(a.auth, bill({ agent: { run_id: one.run, model_call_id: two.mc, confidence: 0.9 } })), 'MODEL_CALL_MISSING');
    await expectCode(propose(a.auth, bill({ agent: { run_id: one.run, model_call_id: randomUUID(), confidence: 0.9 } })), 'MODEL_CALL_MISSING');
    const failed = (await db.query(`select agents.log_model_call($1, $2::jsonb) id`, [one.run, JSON.stringify({ model: 'simulated', request: {}, status: 'error', error: 'boom' })])).rows[0].id;
    await expectCode(propose(a.auth, bill({ agent: { run_id: one.run, model_call_id: failed, confidence: 0.9 } })), 'MODEL_CALL_MISSING');
    // Another agent's run can't be borrowed either.
    const b = await newAgent(['propose_entry'], policy());
    await expectCode(propose(b.auth, bill({ agent: { run_id: one.run, model_call_id: one.mc, confidence: 0.9 } })), 'NO_RUN');
    // A finished run takes no more proposals.
    await asAgent(a.auth);
    await db.query(`select agents.finish_run($1, 'succeeded')`, [one.run]);
    await expectCode(propose(a.auth, bill({ agent: { run_id: one.run, model_call_id: one.mc, confidence: 0.9 } })), 'RUN_FINISHED');
  });

  it('the log is insert-only, and people or integrations cannot pose as agents', async () => {
    await su.query('begin');
    await su.query('set local role ledger_owner');
    await expect(su.query(`update agents.model_call set cost_usd = 0`)).rejects.toThrow(/^IMMUTABLE/);
    await su.query('rollback');
    await actAs(db, f.user2);
    await expect(db.query(`delete from agents.model_call`)).rejects.toThrow(/permission denied/);
    await expectCode(db.query(`select agents.start_run('pretend')`), 'NOT_AN_AGENT');
    await actAs(db, f.integration);
    await expectCode(db.query('select ledger.propose_entry($1::jsonb)', [JSON.stringify(bill({ agent: { run_id: randomUUID(), model_call_id: randomUUID(), confidence: 1 } }))]), 'BAD_INPUT');
  });
});

describe("people's decisions become labeled examples", () => {
  it('approved, rejected and corrected proposals are recorded with the difference', async () => {
    const a = await newAgent(['propose_entry'], policy());
    const { run, mc } = await openRun(a.auth);
    const m = { run_id: run, model_call_id: mc, confidence: 0.9 };
    const ok = await propose(a.auth, bill({ agent: m }));
    const wrong = await propose(a.auth, bill({ agent: m }, '130.00'));
    await actAs(db, f.user1);
    await db.query('select ledger.approve_draft($1)', [ok]);
    await db.query(`select ledger.reject_draft($1, 'invoice says 103.00')`, [wrong]);
    const fixed = (await db.query('select ledger.propose_entry($1::jsonb) id', [JSON.stringify({ ...bill({}, '103.00'), corrects_draft_id: wrong })])).rows[0].id;
    const rows = (await su.query(`select draft_id, outcome, reason, corrected_draft_id, diff, agent_version
                                    from agents.agent_correction where agent_id = $1 order by at, outcome`, [a.id])).rows;
    expect(rows.map((r) => [r.draft_id, r.outcome, r.reason])).toEqual([
      [ok, 'approved', null], [wrong, 'rejected', 'invoice says 103.00'], [wrong, 'corrected', 'invoice says 103.00']]);
    const corrected = rows[2];
    expect(corrected).toMatchObject({ corrected_draft_id: fixed, agent_version: 'v1' });
    expect(Object.keys(corrected.diff)).toEqual(['lines']);
    expect(corrected.diff.lines.from[0].debit).toBe('130.00');
    expect(corrected.diff.lines.to[0].debit).toBe('103.00');
  });

  it('only a person corrects, only a rejected agent draft, and a withdrawal is not a judgement', async () => {
    const a = await newAgent(['propose_entry'], policy());
    const { run, mc } = await openRun(a.auth);
    const m = { run_id: run, model_call_id: mc, confidence: 0.9 };
    const pending = await propose(a.auth, bill({ agent: m }));
    await actAs(db, f.user1);
    await expectCode(db.query('select ledger.propose_entry($1::jsonb)', [JSON.stringify({ ...bill(), corrects_draft_id: pending })]), 'BAD_CORRECTION');
    await asAgent(a.auth);
    await db.query(`select ledger.reject_draft($1, 'withdrawn by the agent')`, [pending]);
    expect(await count(su, 'select count(*) n from agents.agent_correction where draft_id = $1', [pending])).toBe(0);
    await expectCode(propose(a.auth, bill({ agent: m, corrects_draft_id: pending })), 'ROLE_FORBIDDEN');
  });
});

describe('location scope and runtime robustness', () => {
  it('a member limited to some stores cannot read model output or corrections (they carry whole drafts)', async () => {
    const a = await newAgent(['propose_entry'], policy());
    const { run, mc } = await openRun(a.auth);
    const d = await propose(a.auth, bill({ agent: { run_id: run, model_call_id: mc, confidence: 0.9 }, lines: [
      { account_id: f.acct.cogs, location_id: f.locA1, debit: '50' }, { account_id: f.acct.ap, location_id: f.locA1, credit: '50' }] }));
    await actAs(db, f.user1);
    await db.query(`select ledger.reject_draft($1, 'scope test')`, [d]);
    const seen = async (who: string) => {
      await actAs(db, who);
      return {
        calls: await count(db, 'select count(*) n from agents.model_call where run_id = $1', [run]),
        corrections: await count(db, 'select count(*) n from agents.agent_correction where draft_id = $1', [d]),
      };
    };
    expect(await seen(f.user1)).toEqual({ calls: 1, corrections: 1 });   // all locations
    expect(await seen(f.clerk)).toEqual({ calls: 0, corrections: 0 });   // store 1 only
  });

  it('every grantable tool has an implementation', () => {
    return db.query('select agents.known_tools() t').then(({ rows }) =>
      expect([...rows[0].t].sort()).toEqual(standardTools.map((t) => t.definition.name).sort()));
  });

  it('read_entries works, and an allowed tool without an implementation is an error result, not a stuck run', async () => {
    const a = await newAgent(['read_entries', 'read_accounts'], policy());
    let seen: any;
    const model = new SimulatedModel((req, turn) => {
      if (turn === 1) return { tool_calls: [{ name: 'read_entries', input: { entity_id: f.entityA, from: '2026-01-01', to: '2026-12-31' } }, { name: 'read_accounts', input: {} }] };
      seen = req.messages[2].content;
      return { text: 'done' };
    });
    const partial = new AgentRuntime({ pool, model, tools: standardTools.filter((t) => t.definition.name !== 'read_accounts') });
    const r = await partial.run(a.who, task);
    expect(r.status).toBe('succeeded');
    expect(seen[0].is_error ?? false).toBe(false);
    expect(Array.isArray(JSON.parse(seen[0].content))).toBe(true);
    expect(seen[1]).toMatchObject({ is_error: true, content: expect.stringMatching(/^NO_IMPLEMENTATION/) });
    expect((await su.query('select status from agents.agent_run where id = $1', [r.runId])).rows[0].status).toBe('succeeded');
  });

  it('an unexpected runtime error still closes the run as failed', async () => {
    const a = await newAgent(['read_accounts'], policy());
    const broken = { create: async () => ({ stop_reason: 'tool_use', content: null, usage: { input_tokens: 1, output_tokens: 1 }, model: 'x' }) } as any;
    await expect(new AgentRuntime({ pool, model: broken, tools: standardTools }).run(a.who, task)).rejects.toThrow();
    const run = (await su.query(`select status, error from agents.agent_run where agent_id = $1`, [a.id])).rows[0];
    expect(run).toMatchObject({ status: 'failed', error: expect.stringMatching(/^RUNTIME_ERROR/) });
  });
});

describe('function ownership', () => {
  it('agent functions run as ledger_owner', async () => {
    const { rows } = await su.query(`select pg_get_userbyid(proowner) o, count(*)::int n from pg_proc
                                      where pronamespace = 'agents'::regnamespace group by 1`);
    expect(rows).toEqual([{ o: 'ledger_owner', n: expect.any(Number) }]);
  });
});
