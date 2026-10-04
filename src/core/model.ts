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
  }

  async chat(req: ModelRequest): Promise<ModelResponse> {
    const inputTokens = this.countInput(req);
    const step = this.cursor < this.steps.length ? this.steps[this.cursor] : { kind: "done" as const, summary: "no script" };
    this.cursor++;

    if (step.kind === "done") {
      return {
        text: step.summary,
        usage: this.usage(inputTokens, Math.min(this.outputTokensPerTurn, 30)),
        stopReason: "end_turn",
      };
    }

    let calls: ToolCall[] = [];
    if (step.kind === "tool") {
      calls = step.calls;
      // If the harness exposes the fused schema, use it: this is the model-side
      // half of Action Fusion, and is what generates the measured saving.
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
      usage: this.usage(inputTokens, outTokens),
      stopReason: calls.length ? "tool_use" : "end_turn",
    };
  }

  /** Fuse a `write`/`edit` immediately followed by a `run` into a single call. */
  private tryFuse(calls: ToolCall[], tools: ToolDefinition[]): ToolCall[] {
    const fusionTool = tools.find((t) => t.name === "write_file" && (t.parameters as Record<string, unknown>).then_run);
    if (!fusionTool || calls.length < 2) return calls;
    const [a, b] = calls;
    const isMutation = a.tool === "write_file" || a.tool === "edit_file";
    const isFollowRun = b.tool === "run";
    if (!isMutation || !isFollowRun) return calls;
    return [
      {
        tool: a.tool,
        args: { ...a.args, then_run: (b.args.command as string[]) ?? [String(b.args.command ?? "")] },
      },
    ];
  }

  private countInput(req: ModelRequest): number {
    let total = 0;
    for (const m of req.messages) total += estimateTokens(m.content) + 4;
    for (const t of req.tools) total += estimateJsonTokens(t) + 8;
    return total;
  }

  private usage(input: number, output: number): Usage {
    return { input, cacheRead: 0, cacheWrite: 0, output };
  }

  notifySchema(tools: ToolDefinition[]): void {
    this.seenFusionSchema = tools.some(
      (t) => t.name === "write_file" && Boolean((t.parameters as Record<string, unknown>).then_run),
    );
  }
}

/**
 * A model that "thinks" it has a large context but is charged realistically.
 * Used for the transfer experiment: identical policy, different backend id.
 */
export function makeBackend(id: string, contextWindow = 200_000): ScriptedModel {
  return new ScriptedModel({ id, contextWindow });
}

export { UsageMeter };
