import { Environment, nextCallId, summarizeResult } from "./environment.js";
import { ModelBackend } from "./model.js";
import { estimateTokens, estimateJsonTokens } from "./tokens.js";
import {
  Message,
  ModelRequest,
  ModelResponse,
  RunResult,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TraceEntry,
} from "./types.js";
import { CostRates, DEFAULT_RATES, Usage, UsageMeter, zeroUsage, addUsage } from "./usage.js";

/**
 * A mechanism is a transformation applied at a specific point in the
 * agent-environment loop. Mechanisms are the unit of search in the
 * Auto-Research Loop: each one is proposed, implemented, gated, and
 * (if retained) composed into the final harness.
 */
export interface Mechanism {
  name: string;
  description: string;

  /** Rewrite the tool schema exposed to the model (e.g. add a fused parameter). */
  transformTools?(tools: ToolDefinition[]): ToolDefinition[];

  /** Intercept a batch of tool calls before execution (e.g. merge calls). */
  transformCalls?(calls: ToolCall[], ctx: LoopContext): ToolCall[];

  /** Observe a tool result and return the (possibly rewritten) result. */
  transformResult?(result: ToolResult, ctx: LoopContext): ToolResult;

  /** Rewrite the observation text inserted into the model context. */
  projectObservation?(text: string, result: ToolResult, ctx: LoopContext): string;

  /** Called when a plan step completes (a subtask boundary). */
  onPlanStepComplete?(step: PlanStep, ctx: LoopContext): void;

  /** Rewrite the full message list before it is sent to the model. */
  transformContext?(messages: Message[], ctx: LoopContext): Message[];

  /**
   * Serve a tool the mechanism itself contributed via transformTools.
   * `callId` is the id the harness allocated for this call; the result must
   * carry it so mechanisms that key results by id (ObservationPack's archive)
   * do not collide on a shared literal.
   */
  resolveTool?(name: string, args: Record<string, unknown>, callId: string): ToolResult | undefined;

  /** Reset per-run state; called once at the start of every run. */
  reset?(): void;
}

export interface PlanStep {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "done";
}

export interface LoopContext {
  turn: number;
  requestsSoFar: number;
  env: Environment;
  plan: PlanStep[];
  harness: Harness;
}

export interface HarnessOptions {
  id: string;
  model: ModelBackend;
  env: Environment;
  mechanisms?: Mechanism[];
  maxTurns?: number;
  systemPrompt?: string;
  rates?: CostRates;
  /** Called when the model emits a plan update; returns the new plan. */
  onPlanUpdate?: (plan: PlanStep[], update: Partial<PlanStep>) => PlanStep[];
}

export interface ToolExecution {
  call: ToolCall;
  result: ToolResult;
}

/**
 * The base agent harness. This is the "Pi"-style loop: the model sees a tool
 * schema, emits calls, the harness executes them against the environment, and
 * appends observations verbatim to the context. Mechanisms hook into this loop
 * without changing its control flow.
 */
export class Harness {
  readonly id: string;
  readonly model: ModelBackend;
  readonly env: Environment;
  readonly mechanisms: Mechanism[];
  readonly maxTurns: number;
  readonly rates: CostRates;
  messages: Message[] = [];
  plan: PlanStep[] = [];
  meter = new UsageMeter();
  trace: TraceEntry[] = [];
  private notifiedStepIds = new Set<number>();
  protected systemPrompt: string;

  constructor(opts: HarnessOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.env = opts.env;
    this.mechanisms = opts.mechanisms ?? [];
    this.maxTurns = opts.maxTurns ?? 30;
    this.rates = opts.rates ?? DEFAULT_RATES;
    this.systemPrompt =
      opts.systemPrompt ??
      "You are a coding agent. Read files, edit code, run tests, and inspect logs to complete the task.";
  }

  baseTools(): ToolDefinition[] {
    return [
      {
        name: "read_file",
        description: "Read the contents of a file.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      {
        name: "write_file",
        description: "Write content to a file, replacing it entirely.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Apply a string replacement inside a file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old: { type: "string" },
            new: { type: "string" },
          },
          required: ["path", "old", "new"],
        },
      },
      {
        name: "run",
        description: "Run a shell command (test, build, ls, cat, grep).",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "update_plan",
        description: "Update the task plan.",
        parameters: {
          type: "object",
          properties: { steps: { type: "array", items: { type: "object" } } },
          required: ["steps"],
        },
      },
    ];
  }

  tools(): ToolDefinition[] {
    let tools = this.baseTools();
    for (const m of this.mechanisms) if (m.transformTools) tools = m.transformTools(tools);
    return tools;
  }

  /** Publish the current tool schema to the model. Called once per run. */
  notifyTools(): void {
    const m = this.model as ModelBackend & { notifySchema?: (t: ToolDefinition[]) => void };
    if (typeof m.notifySchema === "function") m.notifySchema(this.tools());
  }

  async run(scriptedPlan?: PlanStep[]): Promise<RunResult> {
    this.env.reset();
    for (const m of this.mechanisms) m.reset?.();
    this.messages = [
      { role: "system", content: this.systemPrompt },
      {
        role: "user",
        content: `Task: ${this.env.task.description}\nComplete the task. All ${this.env.task.tests.length} tests must pass.`,
      },
    ];
    this.plan = scriptedPlan ?? this.defaultPlan();
    this.meter = new UsageMeter();
    this.trace = [];
    this.notifiedStepIds = new Set(
      (scriptedPlan ?? this.defaultPlan()).filter((s) => s.status === "done").map((s) => s.id),
    );
    // Publish the schema once, up front: tools() must stay a pure accessor so
    // that measurement paths (toolSchemaTokens) never perturb agent behaviour.
    this.notifyTools();

    let turn = 0;
    let lastResponse: ModelResponse | undefined;

    while (turn < this.maxTurns) {
      turn++;
      const ctx: LoopContext = {
        turn,
        requestsSoFar: this.meter.requests,
        env: this.env,
        plan: this.plan,
        harness: this,
      };

      // Mechanisms may rewrite the request context (compaction, archived
      // observation substitution). The rewrite persists: a compacted context
      // becomes the context for all subsequent turns.
      for (const m of this.mechanisms) {
        if (m.transformContext) this.messages = m.transformContext(this.messages, ctx);
      }

      const req: ModelRequest = { messages: this.messages, tools: this.tools() };
      lastResponse = await this.model.chat(req);
      this.meter.record(lastResponse.usage);

      if (lastResponse.text) {
        this.messages.push({ role: "assistant", content: lastResponse.text });
      }

      const rawCalls = lastResponse.toolCalls ?? [];
      if (rawCalls.length === 0) {
        this.trace.push({
          turn,
          requestTokens: lastResponse.usage.input + lastResponse.usage.output,
          toolCalls: [],
          results: [],
          compacted: false,
          note: lastResponse.stopReason,
        });
        // No calls means no work this turn; record once and stop, regardless
        // of the declared stop reason (end_turn, error, or max_turns).
        break;
      }

      // Mechanisms may rewrite the call batch before execution (e.g. Action
      // Fusion merges a mutation with its follow-up command).
      let calls = rawCalls;
      for (const m of this.mechanisms) {
        if (m.transformCalls) calls = m.transformCalls(calls, ctx);
      }
      const executed = this.executeCalls(calls, ctx);

      const traceEntry: TraceEntry = {
        turn,
        requestTokens: lastResponse.usage.input + lastResponse.usage.output,
        toolCalls: executed.map((e) => e.call),
        results: executed.map((e) => e.result),
        compacted: false,
      };

      for (const { call, result } of executed) {
        let observation = summarizeResult(result);
        for (const m of this.mechanisms) {
          if (m.projectObservation) observation = m.projectObservation(observation, result, ctx);
        }
        this.messages.push({
          role: "tool",
          content: observation,
          name: call.tool,
          callId: result.callId,
        });
      }

      for (const m of this.mechanisms) {
        for (const step of this.plan) {
          if (step.status !== "done") continue;
          // Fire only for steps that completed since the last turn; a step
          // already announced must not re-fire and resample the interval.
          if (this.notifiedStepIds.has(step.id)) continue;
          this.notifiedStepIds.add(step.id);
          if (m.onPlanStepComplete) m.onPlanStepComplete(step, ctx);
        }
      }

      this.trace.push(traceEntry);
      if (lastResponse.stopReason === "end_turn" && calls.length === 0) break;
    }

    const score = this.env.score();
    const success = score === 1 && this.env.task.tests.length > 0;
    return {
      success,
      score,
      turns: turn,
      usage: this.meter.get(),
      cost: this.meter.cost(this.rates),
      trace: this.trace,
      failureReason: success
        ? undefined
        : turn >= this.maxTurns
          ? `max_turns exhausted (score ${score})`
          : `incomplete (score ${score})`,
    };
  }

  protected executeCalls(calls: ToolCall[], ctx: LoopContext): ToolExecution[] {
    const out: ToolExecution[] = [];
    for (const call of calls) {
      // Mint the result id from the request so results correlate back to the
      // call that produced them; duplicate literals would collide within a
      // turn and mis-key the ObservationPack archive.
      const callId = nextCallId();
      let result = this.executeOne(call, callId);
      for (const m of this.mechanisms) {
        if (m.transformResult) result = m.transformResult(result, ctx);
      }
      out.push({ call, result });
    }
    return out;
  }

  protected executeOne(call: ToolCall, callId = nextCallId()): ToolResult {
    const env = this.env;
    switch (call.tool) {
      case "read_file":
        return env.run(`cat ${String(call.args.path ?? "")}`, callId);
      case "write_file": {
        const path = String(call.args.path ?? "");
        const content = String(call.args.content ?? "");
        const runAfter = validateThenRun(call.args.then_run);
        const prior = env.readFile(path);
        env.writeFile(path, content);
        if (runAfter.length) {
          const merged = runAfter.map((c) => env.run(c));
          const ok = merged.every((r) => r.exitCode === 0);
          // Roll the mutation back if any follow-up command failed, so the
          // fused call is atomic with respect to the model's observation.
          if (!ok) env.writeFile(path, prior);
          const stdout = `wrote ${path}\n` + merged.map((r) => summarizeResult(r)).join("\n");
          return {
            callId: merged[0]?.callId ?? callId,
            tool: call.tool,
            stdout,
            stderr: merged.filter((r) => r.stderr).map((r) => r.stderr).join("\n"),
            exitCode: ok ? 0 : 1,
            bytes: stdout.length,
          };
        }
        return {
          callId,
          tool: call.tool,
          stdout: `wrote ${path}`,
          stderr: "",
          exitCode: 0,
          bytes: `wrote ${path}`.length,
        };
      }
      case "edit_file": {
        const path = String(call.args.path ?? "");
        const oldS = String(call.args.old ?? "");
        const newS = String(call.args.new ?? "");
        const current = env.readFile(path);
        if (!current.includes(oldS)) {
          return {
            callId,
            tool: call.tool,
            stdout: "",
            stderr: `edit_file: old string not found in ${path}`,
            exitCode: 1,
            bytes: 0,
            error: "old string not found",
          };
        }
        const runAfter = validateThenRun(call.args.then_run);
        const applied = current.replace(oldS, newS);
        env.writeFile(path, applied);
        if (runAfter.length) {
          const merged = runAfter.map((c) => env.run(c));
          const ok = merged.every((r) => r.exitCode === 0);
          if (!ok) env.writeFile(path, current);
          const stdout = `edited ${path}\n` + merged.map((r) => summarizeResult(r)).join("\n");
          return {
            callId: merged[0]?.callId ?? callId,
            tool: call.tool,
            stdout,
            stderr: merged.filter((r) => r.stderr).map((r) => r.stderr).join("\n"),
            exitCode: ok ? 0 : 1,
            bytes: stdout.length,
          };
        }
        return {
          callId,
          tool: call.tool,
          stdout: `edited ${path}`,
          stderr: "",
          exitCode: 0,
          bytes: `edited ${path}`.length,
        };
      }
      case "run":
        return env.run(String(call.args.command ?? ""), callId);
      case "update_plan": {
        const validated = validatePlanSteps(call.args.steps);
        if (!validated.ok) {
          return {
            callId,
            tool: call.tool,
            stdout: "",
            stderr: validated.error,
            exitCode: 1,
            bytes: 0,
            error: validated.error,
          };
        }
        this.plan = validated.steps;
        return {
          callId,
          tool: call.tool,
          stdout: `plan updated: ${this.plan.length} steps (${this.plan.filter((s) => s.status === "done").length} done)`,
          stderr: "",
          exitCode: 0,
          bytes: 24,
        };
      }
      default: {
        // Mechanisms may contribute their own tools (e.g. recall_observation);
        // only fall back to "unknown tool" if none of them claims the name.
        for (const m of this.mechanisms) {
          const resolved = m.resolveTool?.(call.tool, call.args, callId);
          if (resolved) return resolved;
        }
        return {
          callId,
          tool: call.tool,
          stdout: "",
          stderr: `unknown tool: ${call.tool}`,
          exitCode: 1,
          bytes: 0,
          error: "unknown tool",
        };
      }
    }
  }

  protected defaultPlan(): PlanStep[] {
    return [
      { id: 1, title: "Read files", status: "pending" },
      { id: 2, title: "Edit code", status: "pending" },
      { id: 3, title: "Run tests", status: "pending" },
      { id: 4, title: "Verify", status: "pending" },
    ];
  }

  contextTokens(): number {
    return this.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  }

  toolSchemaTokens(): number {
    return this.tools().reduce((n, t) => n + estimateJsonTokens(t) + 8, 0);
  }
}

const PLAN_STATUSES = ["pending", "in_progress", "done"] as const;
type PlanStatus = (typeof PLAN_STATUSES)[number];

function asPlanStatus(value: unknown): PlanStatus | undefined {
  return PLAN_STATUSES.includes(value as PlanStatus) ? (value as PlanStatus) : undefined;
}

/**
 * Validate model-supplied `then_run` at the trust boundary. A cast would
 * compile while asserting nothing; a bare string or a numeric entry would
 * otherwise crash the run deep inside the shell.
 */
function validateThenRun(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * Validate model-supplied plan steps before they reach `Harness.plan`. The
 * plan is read by every mechanism, so a malformed value is a poisoned-state
 * bug: it would crash one turn later, far from the cause.
 */
function validatePlanSteps(raw: unknown): { ok: true; steps: PlanStep[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "update_plan: steps must be an array" };
  const steps: PlanStep[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return { ok: false, error: "update_plan: step must be an object" };
    const id = (s as { id?: unknown }).id;
    const title = (s as { title?: unknown }).title;
    const status = asPlanStatus((s as { status?: unknown }).status);
    if (typeof id !== "number" || !Number.isFinite(id)) return { ok: false, error: "update_plan: step.id must be a number" };
    if (typeof title !== "string") return { ok: false, error: "update_plan: step.title must be a string" };
    if (!status) {
      return { ok: false, error: `update_plan: step.status must be one of ${PLAN_STATUSES.join(", ")}` };
    }
    steps.push({ id, title, status });
  }
  return { ok: true, steps };
}

export { zeroUsage, addUsage };
export type { Usage };
