// Agent tools. Each tool runs in the agent's own database session (app_role, its claims), so row
// security and every ledger rule apply. Write tools are also checked by the database itself:
// ledger.propose_entry refuses an agent whose allow-list, policy or kill switch says no.
import type { PoolClient } from 'pg';
import type { Tool } from './model.js';

export interface ToolContext {
  db: PoolClient;
  tenantId: string;
  runId: string;
  modelCallId: string;
  /** Ids of documents or entries the agent has seen; logged with the next model call. */
  refs: string[];
}

export interface AgentTool {
  definition: Tool;
  run(ctx: ToolContext, input: Record<string, unknown>): Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });

export const readAccounts: AgentTool = {
  definition: {
    name: 'read_accounts',
    description: 'List the active chart of accounts: id, number, name, type.',
    input_schema: obj({}),
  },
  async run(ctx) {
    return (await ctx.db.query(`select id, number, name, type from account where active order by number`)).rows;
  },
};

export const readLocations: AgentTool = {
  definition: {
    name: 'read_locations',
    description: 'List locations: id, name, entity_id.',
    input_schema: obj({}),
  },
  async run(ctx) {
    return (await ctx.db.query(`select id, name, entity_id from location order by name`)).rows;
  },
};

export const readEvidence: AgentTool = {
  definition: {
    name: 'read_evidence',
    description: 'Read the extracted fields of a source document by id.',
    input_schema: obj({ source_document_id: { type: 'string' } }, ['source_document_id']),
  },
  async run(ctx, input) {
    const r = (await ctx.db.query(`select id, doc_type, extracted from source_document where id = $1`, [input.source_document_id])).rows[0];
    if (!r) throw new Error('NOT_FOUND: no such document');
    ctx.refs.push(r.id);
    return r;
  },
};

export const proposeEntry: AgentTool = {
  definition: {
    name: 'propose_entry',
    description: 'Propose a journal entry for a person to approve. Amounts are decimal strings. ' +
      'confidence is your confidence (0 to 1) that the entry is right.',
    input_schema: obj({
      entity_id: { type: 'string' },
      entry_date: { type: 'string', description: 'YYYY-MM-DD' },
      source_type: { type: 'string' },
      memo: { type: 'string' },
      evidence_ids: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
      lines: {
        type: 'array',
        items: obj({
          account_id: { type: 'string' },
          location_id: { type: 'string' },
          debit: { type: 'string' },
          credit: { type: 'string' },
        }, ['account_id', 'location_id']),
      },
    }, ['entity_id', 'entry_date', 'source_type', 'lines', 'confidence']),
  },
  async run(ctx, input) {
    const { confidence, ...entry } = input;
    const draft = {
      ...entry,
      tenant_id: ctx.tenantId,
      evidence_ids: entry.evidence_ids ?? [],
      agent: { run_id: ctx.runId, model_call_id: ctx.modelCallId, confidence },
    };
    const id = (await ctx.db.query('select ledger.propose_entry($1::jsonb) id', [JSON.stringify(draft)])).rows[0].id;
    return { draft_id: id, status: 'pending approval by a person' };
  },
};

export const standardTools: AgentTool[] = [readAccounts, readLocations, readEvidence, proposeEntry];
