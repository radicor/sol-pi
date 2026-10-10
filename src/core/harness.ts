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
  /**
   * Passive observer of the loop. Handlers run synchronously at the loop's own
   * milestones; the loop never reads a return value and no control-flow
   * decision depends on one, so wiring a handler cannot change what a run does.
   */
  onEvent?: (event: HarnessEvent) => void;
}

/**
 * Milestones in the harness loop, in firing order. `context_rewritten` reuses
 * the before/after pair the trace already records, so an observer sees the
 * same compaction fact the trace documents.
 */
export type HarnessEvent =
  | { type: "run_started"; plan: PlanStep[] }
  | { type: "context_rewritten"; turn: number; before: number; after: number; summary?: string }
  | { type: "model_request"; turn: number; request: ModelRequest }
  | { type: "model_response"; turn: number; response: ModelResponse; usage: Usage }
  | { type: "calls_prepared"; turn: number; calls: ToolCall[] }
  | { type: "tool_started"; turn: number; callId: string; call: ToolCall }
  | { type: "tool_finished"; turn: number; callId: string; call: ToolCall; result: ToolResult }
  | { type: "observation_appended"; turn: number; callId: string; message: Message }
  | { type: "plan_updated"; turn: number; plan: PlanStep[] }
  | { type: "plan_step_done"; turn: number; step: PlanStep }
  | { type: "turn_ended"; turn: number; entry: TraceEntry }
  | { type: "run_finished"; turns: number; result: RunResult };

export interface RunOptions {
  signal?: AbortSignal;
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
  // Loop state lives on the instance so a host can drive one turn at a time.
  protected turn = 0;
  protected lastResponse: ModelResponse | undefined;
  protected aborted = false;
  private readonly onEvent?: (event: HarnessEvent) => void;

  constructor(opts: HarnessOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.env = opts.env;
    this.mechanisms = opts.mechanisms ?? [];
    this.maxTurns = opts.maxTurns ?? 30;
    this.rates = opts.rates ?? DEFAULT_RATES;
    this.onEvent = opts.onEvent;
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

  /**
   * One-time setup for a fresh run: resets the environment and mechanism state,
   * seeds the conversation, and publishes the tool schema. When
   * `initialMessages` is omitted the task description seeds the context, which
   * is what the research path does; a host supplies its own system + user
   * messages instead.
   */
  begin(initialMessages?: Message[], scriptedPlan?: PlanStep[]): void {
    this.env.reset();
    for (const m of this.mechanisms) m.reset?.();
    this.messages =
      initialMessages ?? [
        { role: "system", content: this.systemPrompt },
        {
          role: "user",
          content: `Task: ${this.env.task.description}\nComplete the task. All ${this.env.task.tests.length} tests must pass.`,
        },
      ];
    this.plan = scriptedPlan ?? this.defaultPlan();
    this.meter = new UsageMeter();
    this.trace = [];
    this.turn = 0;
    this.lastResponse = undefined;
    this.aborted = false;
    this.notifiedStepIds = new Set(
      (scriptedPlan ?? this.defaultPlan()).filter((s) => s.status === "done").map((s) => s.id),
    );
    // Publish the schema once, up front: tools() must stay a pure accessor so
    // that measurement paths (toolSchemaTokens) never perturb agent behaviour.
    this.notifyTools();
    this.emit({ type: "run_started", plan: this.plan });
  }

  /**
   * Continue an existing conversation with a new user message. Only the
   * per-prompt turn budget resets; messages, meter, trace, plan, and mechanism
   * state persist, so a multi-prompt session is one continuous run.
   */
  resume(userMessage: string): void {
    this.messages.push({ role: "user", content: userMessage });
    this.turn = 0;
    this.lastResponse = undefined;
    this.aborted = false;
  }

  /**
   * Advance exactly one turn. Returns `{ stopped: true }` when the loop must
   * not continue — either the budget is exhausted, the model ended its turn
   * with no calls, or the run was cancelled.
   */
  async step(opts?: { signal?: AbortSignal }): Promise<{ stopped: boolean }> {
    if (opts?.signal?.aborted) this.aborted = true;
    if (this.aborted) return { stopped: true };
    if (this.turn >= this.maxTurns) return { stopped: true };
    this.turn++;
    const ctx: LoopContext = {
      turn: this.turn,
      requestsSoFar: this.meter.requests,
      env: this.env,
      plan: this.plan,
      harness: this,
    };

    // Mechanisms may rewrite the request context (compaction, archived
    // observation substitution). The rewrite persists: a compacted context
    // becomes the context for all subsequent turns. Record whether one
    // actually acted, so the trace can show which turns rewrote the context
    // rather than claiming every turn is uncompacted.
    let contextRewrite: { before: number; after: number } | undefined;
    let rewriteSummary: string | undefined;
    for (const m of this.mechanisms) {
      if (!m.transformContext) continue;
      const before = this.messages.reduce((n, msg) => n + estimateTokens(msg.content) + 4, 0);
      const rewritten = m.transformContext(this.messages, ctx);
      if (rewritten === this.messages) continue;
      const after = rewritten.reduce((n, msg) => n + estimateTokens(msg.content) + 4, 0);
      // A compaction inserts a summary message; surface its text so an
      // observer can show what replaced the context without knowing which
      // mechanism acted.
      const inserted = rewritten.find((msg) => !this.messages.includes(msg));
      rewriteSummary = inserted && inserted.role !== "tool" ? inserted.content : rewriteSummary;
      this.messages = rewritten;
      contextRewrite = { before, after };
    }
    if (contextRewrite) {
      this.emit({
        type: "context_rewritten",
        turn: this.turn,
        before: contextRewrite.before,
        after: contextRewrite.after,
        summary: rewriteSummary,
      });
    }

    const req: ModelRequest = { messages: this.messages, tools: this.tools() };
    this.emit({ type: "model_request", turn: this.turn, request: req });
    const lastResponse = await this.model.chat(req);
    this.lastResponse = lastResponse;
    this.meter.record(lastResponse.usage);
    this.emit({
      type: "model_response",
      turn: this.turn,
      response: lastResponse,
      usage: this.meter.get(),
    });

    if (lastResponse.text) {
      this.messages.push({ role: "assistant", content: lastResponse.text });
    }

    const rawCalls = lastResponse.toolCalls ?? [];
    const compactedNote =
      contextRewrite === undefined
        ? undefined
        : `context rewritten: ${contextRewrite.before} -> ${contextRewrite.after} tokens`;
    if (rawCalls.length === 0) {
      this.trace.push({
        turn: this.turn,
        requestTokens: lastResponse.usage.input + lastResponse.usage.cacheRead + lastResponse.usage.cacheWrite,
        toolCalls: [],
        results: [],
        compacted: contextRewrite !== undefined,
        note: [compactedNote, lastResponse.stopReason].filter(Boolean).join("; ") || undefined,
      });
      this.emit({ type: "turn_ended", turn: this.turn, entry: this.trace[this.trace.length - 1] });
      // No calls means no work this turn; record once and stop, regardless
      // of the declared stop reason (end_turn, error, or max_turns).
      return { stopped: true };
    }

    // Mechanisms may rewrite the call batch before execution (e.g. Action
    // Fusion merges a mutation with its follow-up command).
    let calls = rawCalls;
    for (const m of this.mechanisms) {
      if (m.transformCalls) calls = m.transformCalls(calls, ctx);
    }
    this.emit({ type: "calls_prepared", turn: this.turn, calls });
    const executed = await this.executeCalls(calls, ctx);

    const traceEntry: TraceEntry = {
      turn: this.turn,
      // `input` excludes the cached prefix and written delta, which are billed
      // at their own rates; the request's full size is all three together.
      requestTokens: lastResponse.usage.input + lastResponse.usage.cacheRead + lastResponse.usage.cacheWrite,
      toolCalls: executed.map((e) => e.call),
      results: executed.map((e) => e.result),
      compacted: contextRewrite !== undefined,
      note: compactedNote,
    };

    for (const { call, result } of executed) {
      let observation = summarizeResult(result);
      for (const m of this.mechanisms) {
        if (m.projectObservation) observation = m.projectObservation(observation, result, ctx);
      }
      const message: Message = {
        role: "tool",
        content: observation,
        name: call.tool,
        callId: result.callId,
      };
      this.messages.push(message);
      this.emit({ type: "observation_appended", turn: this.turn, callId: result.callId, message });
    }

    for (const m of this.mechanisms) {
      for (const step of this.plan) {
        if (step.status !== "done") continue;
        // Fire only for steps that completed since the last turn; a step
        // already announced must not re-fire and resample the interval.
        if (this.notifiedStepIds.has(step.id)) continue;
        this.notifiedStepIds.add(step.id);
        if (m.onPlanStepComplete) m.onPlanStepComplete(step, ctx);
        this.emit({ type: "plan_step_done", turn: this.turn, step });
      }
    }

    this.trace.push(traceEntry);
    this.emit({ type: "turn_ended", turn: this.turn, entry: traceEntry });
    if (lastResponse.stopReason === "end_turn" && calls.length === 0) return { stopped: true };
    return { stopped: false };
  }

  /** Why the loop stopped, in the terms a host reports to its user. */
  get stopReason(): "end_turn" | "max_turn_requests" | "cancelled" {
    if (this.aborted) return "cancelled";
    if (this.turn >= this.maxTurns) return "max_turn_requests";
    return "end_turn";
  }

  /** Compute the RunResult from current state. */
  finish(): RunResult {
    const score = this.env.score();
    const success = score === 1 && this.env.task.tests.length > 0;
    const result: RunResult = {
      success,
      score,
      turns: this.turn,
      usage: this.meter.get(),
      cost: this.meter.cost(this.rates),
      trace: this.trace,
      failureReason: success
        ? undefined
        : this.aborted
          ? "cancelled"
          : this.turn >= this.maxTurns
            ? `max_turns exhausted (score ${score})`
            : `incomplete (score ${score})`,
    };
    this.emit({ type: "run_finished", turns: this.turn, result });
    return result;
  }

  async run(scriptedPlan?: PlanStep[], opts?: RunOptions): Promise<RunResult> {
    this.begin(undefined, scriptedPlan);
    while (!(await this.step({ signal: opts?.signal })).stopped) {
      /* advance one turn at a time */
    }
    return this.finish();
  }

  protected emit(event: HarnessEvent): void {
    this.onEvent?.(event);
  }

  protected async executeCalls(calls: ToolCall[], ctx: LoopContext): Promise<ToolExecution[]> {
    const out: ToolExecution[] = [];
    for (const call of calls) {
      // Mint the result id from the request so results correlate back to the
      // call that produced them; duplicate literals would collide within a
      // turn and mis-key the ObservationPack archive.
      const callId = nextCallId();
      this.emit({ type: "tool_started", turn: this.turn, callId, call });
      let result = await this.executeOne(call, callId);
      for (const m of this.mechanisms) {
        if (m.transformResult) result = m.transformResult(result, ctx);
      }
      this.emit({ type: "tool_finished", turn: this.turn, callId, call, result });
      out.push({ call, result });
    }
    return out;
  }

  protected async executeOne(call: ToolCall, callId = nextCallId()): Promise<ToolResult> {
    const env = this.env;
    switch (call.tool) {
      case "read_file":
        return await env.run(`cat ${String(call.args.path ?? "")}`, callId);
      case "write_file": {
        const path = String(call.args.path ?? "");
        const content = String(call.args.content ?? "");
        const runAfter = validateThenRun(call.args.then_run);
        const prior = await env.readFile(path);
        await env.writeFile(path, content);
        if (runAfter.length) {
          const merged = await Promise.all(runAfter.map((c) => env.run(c)));
          const ok = merged.every((r) => r.exitCode === 0);
          // Roll the mutation back if any follow-up command failed, so the
          // fused call is atomic with respect to the model's observation.
          if (!ok) await env.writeFile(path, prior);
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
        const current = await env.readFile(path);
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
        await env.writeFile(path, applied);
        if (runAfter.length) {
          const merged = await Promise.all(runAfter.map((c) => env.run(c)));
          const ok = merged.every((r) => r.exitCode === 0);
          if (!ok) await env.writeFile(path, current);
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
        return await env.run(String(call.args.command ?? ""), callId);
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
        this.emit({ type: "plan_updated", turn: this.turn, plan: this.plan });
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
