// Agent runtime (L1). One run = one task for one agent:
//
//   start_run ─▶ model call ─▶ log_model_call ─▶ for each tool call: authorize_tool ─▶ run tool
//        ▲                                                                        │
//        └──────────────── tool results back to the model ◀───────────────────────┘
//   ends on end_turn (succeeded) · refusal (refused) · kill switch (stopped) · error / max turns (failed)
//
// The database decides: the run can't start if the agent is switched off; every model call is
// logged before its output is used; a tool off the allow-list is refused (and recorded); a
// proposal is accepted only if it cites a logged model call and fits the policy.
import type { Pool, PoolClient } from 'pg';
import { withSession } from '../auth/index.js';
import { callCost, type MessageParam, type ModelClient, type Message } from './model.js';
import type { AgentTool, ToolContext } from './tools.js';

export interface AgentIdentity {
  authUserId: string;  // the agent's service login
  tenantId: string;
}

export interface RunInput {
  purpose: string;
  system: string;
  prompt: string;
  inputRefs?: string[];
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export interface RunResult {
  runId: string;
  status: 'succeeded' | 'failed' | 'refused' | 'stopped';
  turns: number;
  proposals: string[];
  refusedTools: { tool: string; refusal: string }[];
  toolErrors: { tool: string; error: string }[];
  costUsd: string;
  error?: string;
  finalText?: string;
}

export class AgentRuntime {
  constructor(private o: { pool: Pool; model: ModelClient; tools: AgentTool[] }) {}

  private as<T>(who: AgentIdentity, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    return withSession(this.o.pool, { sub: who.authUserId, tenant_id: who.tenantId, aal: 'aal1' }, fn, { role: 'app_role' });
  }

  async run(who: AgentIdentity, input: RunInput): Promise<RunResult> {
    // Start (refused while the kill switch is on) and load the agent's model and allow-list.
    const { runId, agent, allowed } = await this.as(who, async (db) => {
      const runId = (await db.query('select agents.start_run($1) id', [input.purpose])).rows[0].id as string;
      const agent = (await db.query(`select a.id, a.model from agents.agent a join agents.agent_run r on r.agent_id = a.id where r.id = $1`, [runId])).rows[0];
      const allowed = (await db.query('select tool from agents.agent_tool where agent_id = $1', [agent.id])).rows.map((r) => r.tool as string);
      return { runId, agent, allowed };
    });
    // The model is shown only its allowed tools; anything else it asks for is refused anyway.
    const tools = this.o.tools.filter((t) => allowed.includes(t.definition.name));
    const byName = new Map(this.o.tools.map((t) => [t.definition.name, t]));
    const messages: MessageParam[] = [{ role: 'user', content: input.prompt }];
    const refs = [...(input.inputRefs ?? [])];
    const result: RunResult = { runId, status: 'failed', turns: 0, proposals: [], refusedTools: [], toolErrors: [], costUsd: '0' };
    let cost = callCost('simulated', { input_tokens: 0, output_tokens: 0 });

    const finish = async (status: RunResult['status'], error?: string) => {
      result.status = status;
      if (error) result.error = error;
      result.costUsd = cost.toFixed(4);
      await this.as(who, (db) => db.query('select agents.finish_run($1, $2, $3::jsonb, $4)', [runId, status, JSON.stringify({
        turns: result.turns, proposals: result.proposals.length, refused_tools: result.refusedTools.length,
        tool_errors: result.toolErrors.length, cost_usd: result.costUsd }), error ?? null]));
      return result;
    };

    try {
      return await this.loop(who, input, { runId, agent, tools, byName, messages, refs, result, finish,
        addCost: (c) => { cost = cost.plus(c); } });
    } catch (err) {
      // Anything unexpected still closes the run, so none is left 'running'.
      const msg = (err as Error).message || String(err);
      await finish('failed', `RUNTIME_ERROR: ${msg}`).catch(() => undefined);
      throw err;
    }
  }

  private async loop(who: AgentIdentity, input: RunInput, s: {
    runId: string; agent: { model: string }; tools: AgentTool[]; byName: Map<string, AgentTool>; messages: MessageParam[];
    refs: string[]; result: RunResult; finish: (status: RunResult['status'], error?: string) => Promise<RunResult>;
    addCost: (c: ReturnType<typeof callCost>) => void;
  }): Promise<RunResult> {
    const { runId, agent, tools, byName, messages, refs, result, finish } = s;
    for (let turn = 1; turn <= (input.maxTurns ?? 10); turn++) {
      result.turns = turn;
      const req = {
        model: agent.model as string, system: input.system, max_tokens: input.maxTokens ?? 16000,
        effort: input.effort ?? 'medium', tools: tools.map((t) => t.definition), messages,
      };
      const t0 = Date.now();
      let res: Message;
      try {
        res = await this.o.model.create(req);
      } catch (err) {
        const msg = (err as Error).message || String(err);
        await this.logCall(who, runId, req, refs, { status: 'error', error: msg, latency_ms: Date.now() - t0 });
        return finish('failed', `MODEL_ERROR: ${msg}`);
      }
      const c = callCost(req.model, res.usage);
      s.addCost(c);
      // Logged before any of the output is acted on.
      const modelCallId = await this.logCall(who, runId, req, refs, {
        status: 'ok', model_version: res.model, output: res.content, stop_reason: res.stop_reason,
        input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens,
        cache_read_tokens: res.usage.cache_read_input_tokens ?? 0, cache_write_tokens: res.usage.cache_creation_input_tokens ?? 0,
        cost_usd: c.toFixed(4), latency_ms: Date.now() - t0,
      });

      if (res.stop_reason === 'refusal') return finish('refused', 'MODEL_REFUSED');
      if (res.stop_reason === 'max_tokens') return finish('failed', 'MAX_TOKENS: the model ran out of output tokens');
      const calls = res.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || calls.length === 0) {
        result.finalText = res.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n');
        return finish('succeeded');
      }

      messages.push({ role: 'assistant', content: res.content as any });
      const results: any[] = [];
      for (const call of calls) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        const auth = await this.as(who, async (db) => (await db.query('select agents.authorize_tool($1, $2, $3::jsonb, $4) r',
          [runId, call.name, JSON.stringify(input), modelCallId])).rows[0].r as { allowed: boolean; refusal: string | null });
        if (!auth.allowed) {
          result.refusedTools.push({ tool: call.name, refusal: auth.refusal! });
          if (auth.refusal === 'AGENT_DISABLED') return finish('stopped', 'AGENT_DISABLED: kill switch turned on during the run');
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `${auth.refusal}: ${call.name} is not available to you` });
          continue;
        }
        const tool = byName.get(call.name);
        try {
          if (!tool) throw new Error(`NO_IMPLEMENTATION: ${call.name} is allowed but this runtime has no implementation`);
          const missing = ((tool.definition.input_schema as any).required ?? []).filter((k: string) => !(k in input));
          if (missing.length) throw new Error(`BAD_INPUT: missing ${missing.join(', ')}`);
          const out = await this.as(who, (db) => tool.run({ db, tenantId: who.tenantId, runId, modelCallId, refs } satisfies ToolContext, input));
          if (call.name === 'propose_entry') result.proposals.push((out as any).draft_id);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
        } catch (err) {
          const msg = (err as Error).message || String(err);
          if (msg.startsWith('AGENT_DISABLED')) {
            result.refusedTools.push({ tool: call.name, refusal: 'AGENT_DISABLED' });
            return finish('stopped', 'AGENT_DISABLED: kill switch turned on during the run');
          }
          result.toolErrors.push({ tool: call.name, error: msg });
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: msg });
        }
      }
      // All results of one turn go back in a single user message.
      messages.push({ role: 'user', content: results });
    }
    return finish('failed', `MAX_TURNS: no answer within ${input.maxTurns ?? 10} turns`);
  }

  private async logCall(who: AgentIdentity, runId: string, req: unknown, refs: string[], fields: Record<string, unknown>) {
    return this.as(who, async (db) => (await db.query('select agents.log_model_call($1, $2::jsonb) id', [runId, JSON.stringify({
      model: (req as any).model, request: req, input_refs: [...new Set(refs)], ...fields })])).rows[0].id as string);
  }
}
