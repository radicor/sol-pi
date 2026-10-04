import { Environment, summarizeResult } from "./environment.js";
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
    if (this.model instanceof Object && "notifySchema" in this.model) {
      (this.model as { notifySchema: (t: ToolDefinition[]) => void }).notifySchema(tools);
    }
    return tools;
  }

  async run(scriptedPlan?: PlanStep[]): Promise<RunResult> {
    this.env.reset();
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
        if (lastResponse.stopReason === "end_turn") break;
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
          if (step.status === "done") if (m.onPlanStepComplete) m.onPlanStepComplete(step, ctx);
        }
      }

      this.trace.push(traceEntry);
      if (lastResponse.stopReason === "end_turn" && calls.length === 0) break;
    }

    const success = this.env.allTestsPassed();
    return {
      success,
      score: this.env.score(),
      turns: turn,
      usage: this.meter.get(),
      cost: this.meter.cost(this.rates),
      trace: this.trace,
      failureReason: success ? undefined : `score ${this.env.score()} after ${turn} turns`,
    };
  }

  protected executeCalls(calls: ToolCall[], ctx: LoopContext): ToolExecution[] {
    const out: ToolExecution[] = [];
    for (const call of calls) {
      let result = this.executeOne(call);
      for (const m of this.mechanisms) {
        if (m.transformResult) result = m.transformResult(result, ctx);
      }
      out.push({ call, result });
    }
    return out;
  }

  protected executeOne(call: ToolCall): ToolResult {
    const env = this.env;
    switch (call.tool) {
      case "read_file":
        return env.run(`cat ${String(call.args.path ?? "")}`);
      case "write_file": {
        const path = String(call.args.path ?? "");
        const content = String(call.args.content ?? "");
        env.writeFile(path, content);
        const runAfter = (call.args.then_run as string[] | undefined) ?? [];
        if (runAfter.length) {
          const merged = runAfter.map((c) => env.run(c));
          const stdout = `wrote ${path}\n` + merged.map((r) => summarizeResult(r)).join("\n");
          return {
            callId: merged[0]?.callId ?? "call_fused",
            tool: call.tool,
            stdout,
            stderr: merged.filter((r) => r.stderr).map((r) => r.stderr).join("\n"),
            exitCode: merged.every((r) => r.exitCode === 0) ? 0 : 1,
            bytes: stdout.length,
          };
        }
        return {
          callId: "call_write",
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
            callId: "call_edit",
            tool: call.tool,
            stdout: "",
            stderr: `edit_file: old string not found in ${path}`,
            exitCode: 1,
            bytes: 0,
            error: "old string not found",
          };
        }
        env.writeFile(path, current.replace(oldS, newS));
        const runAfter = (call.args.then_run as string[] | undefined) ?? [];
        if (runAfter.length) {
          const merged = runAfter.map((c) => env.run(c));
          const stdout = `edited ${path}\n` + merged.map((r) => summarizeResult(r)).join("\n");
          return {
            callId: merged[0]?.callId ?? "call_fused",
            tool: call.tool,
            stdout,
            stderr: merged.filter((r) => r.stderr).map((r) => r.stderr).join("\n"),
            exitCode: merged.every((r) => r.exitCode === 0) ? 0 : 1,
            bytes: stdout.length,
          };
        }
        return {
          callId: "call_edit",
          tool: call.tool,
          stdout: `edited ${path}`,
          stderr: "",
          exitCode: 0,
          bytes: `edited ${path}`.length,
        };
      }
      case "run":
        return env.run(String(call.args.command ?? ""));
      case "update_plan": {
        const steps = (call.args.steps as PlanStep[]) ?? [];
        if (steps.length) this.plan = steps;
        return {
          callId: "call_plan",
          tool: call.tool,
          stdout: `plan updated: ${this.plan.length} steps (${this.plan.filter((s) => s.status === "done").length} done)`,
          stderr: "",
          exitCode: 0,
          bytes: 24,
        };
      }
      default:
        return {
          callId: "call_unknown",
          tool: call.tool,
          stdout: "",
          stderr: `unknown tool: ${call.tool}`,
          exitCode: 1,
          bytes: 0,
          error: "unknown tool",
        };
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

export { zeroUsage, addUsage };
export type { Usage };
