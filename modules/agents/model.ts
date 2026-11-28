// Model access for agents. The runtime talks to a ModelClient: AnthropicModelClient in production,
// SimulatedModel in tests and until an API key is configured. Both return the SDK's message type.
import Anthropic from '@anthropic-ai/sdk';
import { Decimal } from 'decimal.js';

export type Message = Anthropic.Beta.BetaMessage;
export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Tool = Anthropic.Beta.BetaTool;

export interface ModelRequest {
  model: string;
  system: string;
  tools: Tool[];
  messages: MessageParam[];
  max_tokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ModelClient {
  create(req: ModelRequest): Promise<Message>;
}

/**
 * Claude via the Messages API. Thinking is adaptive (the default on Claude Opus 5.5); effort is set
 * explicitly. Server-side refusal fallbacks are on (`fallbacks: "default"`), so a safety decline is
 * retried on a fallback model inside the same call; a refusal that survives ends the run.
 */
export class AnthropicModelClient implements ModelClient {
  constructor(private client: Anthropic = new Anthropic()) {}

  async create(req: ModelRequest): Promise<Message> {
    return this.client.beta.messages.create({
      model: req.model,
      max_tokens: req.max_tokens,
      system: req.system,
      tools: req.tools,
      tool_choice: { type: 'auto' },
      messages: req.messages,
      output_config: { effort: req.effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  }
}

/** One scripted model turn. */
export interface SimTurn {
  text?: string;
  tool_calls?: { name: string; input: unknown }[];
  stop_reason?: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens';
  usage?: { input_tokens: number; output_tokens: number };
  /** Throw instead of answering (simulates an API failure). */
  error?: string;
}

/** A deterministic stand-in for Claude: a script decides each turn from the request it gets. */
export class SimulatedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private n = 0;
  constructor(private script: (req: ModelRequest, turn: number) => SimTurn | Promise<SimTurn>, private modelVersion = 'simulated-1') {}

  async create(req: ModelRequest): Promise<Message> {
    this.requests.push(structuredClone(req));
    const t = await this.script(structuredClone(req), ++this.n);
    if (t.error) throw new Error(t.error);
    const content: any[] = [];
    if (t.text) content.push({ type: 'text', text: t.text, citations: null });
    for (const [i, c] of (t.tool_calls ?? []).entries()) {
      content.push({ type: 'tool_use', id: `toolu_sim_${this.n}_${i}`, name: c.name, input: c.input });
    }
    return {
      id: `msg_sim_${this.n}`,
      type: 'message',
      role: 'assistant',
      model: this.modelVersion,
      content,
      stop_reason: t.stop_reason ?? (t.tool_calls?.length ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: { input_tokens: t.usage?.input_tokens ?? 1000, output_tokens: t.usage?.output_tokens ?? 200 },
    } as unknown as Message;
  }
}

/** First-party list prices, USD per million tokens (input, output). Cache reads 0.1x, writes 1.25x input. */
const PRICES: Record<string, [string, string]> = {
  'claude-opus-5-5': ['4', '20'],
  'claude-sonnet-5-5': ['2', '10'],
  'claude-haiku-5-5': ['0.10', '0.50'],
  'claude-fable-5-2': ['8', '40'],
  simulated: ['0', '0'],
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Cost of one call in USD (Decimal, never a JS number), rounded to the ledger's 4 decimals. */
export function callCost(model: string, u: Usage): Decimal {
  const p = PRICES[model];
  if (!p) return new Decimal(0);
  const [inp, out] = p.map((x) => new Decimal(x).div(1_000_000));
  return inp.mul(u.input_tokens)
    .plus(out.mul(u.output_tokens))
    .plus(inp.mul('0.1').mul(u.cache_read_input_tokens ?? 0))
    .plus(inp.mul('1.25').mul(u.cache_creation_input_tokens ?? 0))
    .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}
