import { Environment } from "./environment.js";
import { estimateTokens, estimateJsonTokens } from "./tokens.js";
import { Message, ModelRequest, ModelResponse, ToolCall, ToolDefinition, Usage } from "./types.js";
import { UsageMeter } from "./usage.js";

/**
 * A scripted model backend. The paper studies harness behaviour across
 * GPT-5.6 Sol and Opus 5; since we cannot call those APIs here, we use a
 * deterministic scripted "model" whose policy is fixed per task. This keeps
 * the model's behaviour constant across harness configurations, so any
 * measured token difference is attributable to the harness alone.
 */
export interface ModelBackend {
  readonly id: string;
  readonly contextWindow: number;
  chat(req: ModelRequest): Promise<ModelResponse>;
}

export type ScriptStep =
  | { kind: "tool"; calls: ToolCall[] }
  | { kind: "text"; text: string }
  | { kind: "done"; summary: string };

export interface ScriptedModelOptions {
  id: string;
  contextWindow?: number;
  outputTokensPerTurn?: number;
  /** When true, the model may emit fused edit+run calls if the harness exposes them. */
  supportsFusion?: boolean;
}

export class ScriptedModel implements ModelBackend {
  readonly id: string;
  readonly contextWindow: number;
  private steps: ScriptStep[] = [];
  private cursor = 0;
  private outputTokensPerTurn: number;
  readonly supportsFusion: boolean;
  private seenFusionSchema = false;
  /** Contents of the previous request, for prefix-cache accounting. */
  private prevMessages: string[] | undefined;

  constructor(opts: ScriptedModelOptions, steps: ScriptStep[] = []) {
    this.id = opts.id;
    this.contextWindow = opts.contextWindow ?? 200_000;
    this.outputTokensPerTurn = opts.outputTokensPerTurn ?? 40;
    this.supportsFusion = opts.supportsFusion ?? true;
    this.steps = steps;
  }

  load(steps: ScriptStep[]): void {
    this.steps = steps;
    this.cursor = 0;
    this.seenFusionSchema = false;
  }

  reset(): void {
    this.cursor = 0;
    this.seenFusionSchema = false;
    this.prevMessages = undefined;
  }

  async chat(req: ModelRequest): Promise<ModelResponse> {
    const inputTokens = this.countInput(req);
    const step = this.cursor < this.steps.length ? this.steps[this.cursor] : { kind: "done" as const, summary: "no script" };
    this.cursor++;

    // Prefix-cache accounting. A provider bills the portion of the request that
    // repeats the previous request verbatim at the cache-read price, the newly
    // appended content at the cache-write price, and anything that changed
    // mid-context (compaction, observation substitution) at the full input
    // price. Without this the ledger records zero cache traffic, so the
    // compaction gate optimizes a quantity the cost model never reports.
    const { read, write, fresh } = this.cacheSplit(req);
    this.prevMessages = req.messages.map((m) => m.content);

    if (step.kind === "done") {
      return {
        text: step.summary,
        usage: this.usage(inputTokens, Math.min(this.outputTokensPerTurn, 30), read, write, fresh),
        stopReason: "end_turn",
      };
    }

    let calls: ToolCall[] = [];
    if (step.kind === "tool") {
      calls = step.calls;
      // If the harness exposes the fused schema, use it: this is the model-side
      // half of Action Fusion. This fuses write|edit + run, mirroring the
      // harness-side transformCalls; together they take 3 calls -> 1.
      if (this.supportsFusion && this.seenFusionSchema) {
        calls = this.tryFuse(calls, req.tools);
      }
    }

    const outTokens = Math.min(
      this.outputTokensPerTurn + estimateJsonTokens(calls),
      this.outputTokensPerTurn * 6,
    );

    return {
      text: step.kind === "text" ? step.text : undefined,
      toolCalls: calls,
      usage: this.usage(inputTokens, outTokens, read, write, fresh),
      stopReason: calls.length ? "tool_use" : "end_turn",
    };
  }

  /**
   * Split a request's input into cache-read, cache-write, and fresh-token parts
   * by comparing message contents against the previous request. The harness is
   * append-only except when a mechanism rewrites the context, so the longest
   * common prefix is the cacheable part and the tail beyond it is new. A message
   * that differs from its predecessor invalidates that slot *and everything
   * after it*, matching how a prefix cache is actually invalidated.
   */
  private cacheSplit(req: ModelRequest): { read: number; write: number; fresh: number } {
    if (!this.prevMessages || this.prevMessages.length === 0) {
      return { read: 0, write: 0, fresh: this.countInput(req) };
    }
    const cur = req.messages.map((m) => m.content);
    let prefixMsgs = 0;
    while (prefixMsgs < this.prevMessages.length && prefixMsgs < cur.length && this.prevMessages[prefixMsgs] === cur[prefixMsgs]) {
      prefixMsgs++;
    }
    const read = this.prevMessages.slice(0, prefixMsgs).reduce((n, c) => n + estimateTokens(c) + 4, 0);
    const tail = cur.slice(prefixMsgs);
    const tailTokens = tail.reduce((n, c) => n + estimateTokens(c) + 4, 0);
    // The tail is new content written at the cache-write price, except when a
    // mechanism rewrote a mid-context message rather than appending — that
    // content is uncached and bills at the full input price. Distinguish by
    // position: if the previous request had a message here that changed, the
    // rewrite invalidated the suffix, so bill it as fresh input.
    const changed = prefixMsgs < this.prevMessages.length && prefixMsgs < cur.length;
    if (changed) {
      return { read, write: 0, fresh: tailTokens };
    }
    return { read, write: tailTokens, fresh: 0 };
  }

  /** Fuse a `write`/`edit` immediately followed by a `run` into a single call. */
  private tryFuse(calls: ToolCall[], tools: ToolDefinition[]): ToolCall[] {
    const fusionTool = tools.find((t) => t.name === "write_file" && fusionParam(t));
    if (!fusionTool || calls.length < 2) return calls;
    const [a, b] = calls;
    const isMutation = a.tool === "write_file" || a.tool === "edit_file";
    const isFollowRun = b.tool === "run";
    if (!isMutation || !isFollowRun) return calls;
    const command = String(b.args.command ?? "");
    return [
      {
        tool: a.tool,
        args: { ...a.args, then_run: [command] },
      },
    ];
  }

  private countInput(req: ModelRequest): number {
    let total = 0;
    for (const m of req.messages) total += estimateTokens(m.content) + 4;
    for (const t of req.tools) total += estimateJsonTokens(t) + 8;
    return total;
  }

  private usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, fresh = 0): Usage {
    // `input` is the whole request; the cached prefix and written delta are
    // billed at their own prices, so subtract them out to avoid double counting.
    const billable = fresh || Math.max(0, input - cacheRead - cacheWrite);
    return { input: billable, cacheRead, cacheWrite, output };
  }

  notifySchema(tools: ToolDefinition[]): void {
    this.seenFusionSchema = tools.some((t) => t.name === "write_file" && fusionParam(t));
  }
}

/** `then_run` is nested under `parameters.properties` by ActionFusion. */
function fusionParam(t: ToolDefinition): unknown {
  const props = (t.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props?.then_run;
}

/**
 * A model that "thinks" it has a large context but is charged realistically.
 * Used for the transfer experiment: identical policy, different backend id.
 */
export function makeBackend(id: string, contextWindow = 200_000): ScriptedModel {
  return new ScriptedModel({ id, contextWindow });
}

export { UsageMeter };
