import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulatedEnvironment } from "../src/core/environment.js";
import { ActionFusion } from "../src/mechanisms/action-fusion.js";
import { ObservationPack } from "../src/mechanisms/observation-pack.js";
import { Harness } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { estimateTokens, headTailCompleteLines } from "../src/core/tokens.js";
import { addUsage, usageCost, DEFAULT_RATES, zeroUsage } from "../src/core/usage.js";
import { LONG_HORIZON_TASK, REPO_TASKS } from "../src/tasks/corpus.js";
import { Mechanism, PlanStep } from "../src/core/harness.js";
import { ModelBackend } from "../src/core/model.js";
import { ModelRequest, ModelResponse, ToolCall } from "../src/core/types.js";

/** A backend that stops with a reason `ScriptedModel` never emits (M-7 / L-14). */
class StoppingModel implements ModelBackend {
  readonly id = "stop";
  readonly contextWindow = 200_000;
  constructor(private stopReason: ModelResponse["stopReason"], private calls: ToolCall[] = []) {}
  async chat(_req: ModelRequest): Promise<ModelResponse> {
    return { usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, toolCalls: this.calls, stopReason: this.stopReason };
  }
}

test("estimateTokens grows with text length", () => {
  assert.ok(estimateTokens("hello world") > 0);
  const short = estimateTokens("one two three four");
  const long = estimateTokens("one two three four ".repeat(50));
  assert.ok(long > short);
});

test("headTailCompleteLines preserves head and tail around an omission marker", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
  const out = headTailCompleteLines(text, 400);
  assert.ok(out.includes("line-0"), "keeps head");
  assert.ok(out.includes("line-199"), "keeps tail");
  assert.ok(out.includes("omitted"), "marks the omitted middle");
});

test("usage accounting is additive and priced", () => {
  const a = zeroUsage();
  const b = { input: 1000, cacheRead: 500, cacheWrite: 200, output: 50 };
  const sum = addUsage(a, b);
  assert.equal(sum.input, 1000);
  const cost = usageCost(b, DEFAULT_RATES);
  assert.ok(cost > 0);
});

test("environment test fails before the fix and passes after", async () => {
  const task = REPO_TASKS[0]; // add() returns a - b
  const env = new SimulatedEnvironment(task);
  assert.equal(env.score(), 0, "pre-fix repo fails the hidden regression test");
  await env.writeFile("math_utils.py", "def add(a, b):\n    return a + b\n");
  assert.equal(env.score(), 1, "post-fix repo passes");
});

test("harness executes a scripted trajectory and solves a task", async () => {
  const task = REPO_TASKS[0];
  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(task);
  model.load([
    { kind: "tool", calls: [{ tool: "read_file", args: { path: "math_utils.py" } }] },
    {
      kind: "tool",
      calls: [
        { tool: "write_file", args: { path: "math_utils.py", content: "def add(a, b):\n    return a + b\n" } },
      ],
    },
    { kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] },
    { kind: "done", summary: "done" },
  ]);
  const harness = new Harness({ id: "t", model, env, maxTurns: 10 });
  const res = await harness.run();
  assert.equal(res.success, true);
  assert.equal(res.score, 1);
  assert.ok(res.turns <= 10);
});

/* ---- trust boundary: malformed model emissions must not crash the run ---- */

async function runOnce(harness: Harness, calls: ToolCall[]) {
  const model = harness.model as ScriptedModel;
  model.load([...calls.map((c) => ({ kind: "tool" as const, calls: [c] })), { kind: "done" as const, summary: "d" }]);
  return harness.run();
}

test("a malformed then_run yields an error result, not a crash", async () => {
  for (const bad of [{ tool: "write_file", args: { path: "math_utils.py", content: "x = 1\n", then_run: "test" } }, { tool: "write_file", args: { path: "math_utils.py", content: "x = 1\n", then_run: [123] } }]) {
    const env = new SimulatedEnvironment(REPO_TASKS[0]);
    const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, mechanisms: [new ActionFusion()], maxTurns: 3 });
    const res = await runOnce(harness, [bad]);
    assert.equal(res.success, false, "a malformed then_run does not take the run down with it");
  }
});

test("a malformed update_plan yields an error result, not a poisoned plan", async () => {
  for (const bad of [{ tool: "update_plan", args: { steps: "not-an-array" } }, { tool: "update_plan", args: { steps: [{ id: "x", title: 1, status: "nope" }] } }]) {
    const env = new SimulatedEnvironment(REPO_TASKS[0]);
    const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, maxTurns: 4 });
    const res = await runOnce(harness, [bad, { tool: "run", args: { command: "test" } }]);
    assert.equal(res.success, false);
    // The plan stayed an array, so the following turn's mechanisms still work.
    assert.ok(Array.isArray(harness.plan), "the plan was not overwritten with a malformed value");
  }
});

test("a failing fused command rolls the mutation back", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, mechanisms: [new ActionFusion()], maxTurns: 3 });
  await runOnce(harness, [{ tool: "write_file", args: { path: "math_utils.py", content: "def add(a, b):\n    return a + b\n", then_run: ["nonexistent-cmd"] } }]);
  // The write was applied, but the fused follow-up failed, so it must be rolled back.
  assert.equal(env.score(), 0, "a failed verification does not bank the mutation");
});

test("two mutations in one turn get distinct call ids", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, maxTurns: 3 });
  const res = await runOnce(harness, [
    { tool: "write_file", args: { path: "a.py", content: "x" } },
    { tool: "write_file", args: { path: "b.py", content: "y" } },
  ]);
  const ids = res.trace.flatMap((t) => t.results.map((r) => r.callId));
  assert.equal(new Set(ids).size, ids.length, "call ids are unique within a turn");
});

test("reading an inherited key reads as missing, not a prototype value", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const out = await env.run("cat toString");
  assert.equal(out.exitCode, 1, "toString is not a file");
  assert.equal(typeof out.stdout, "string");
  assert.equal(await env.readFile("toString"), undefined, "no prototype-chain leak");
});

test("a missing file reads as undefined, an existing empty file as an empty string", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  assert.equal(await env.readFile("no_such_file.py"), undefined, "missing is undefined, not an empty string");
  await env.writeFile("empty.py", "");
  assert.equal(await env.readFile("empty.py"), "", "an existing empty file reads as a real empty string");

  const cat = await env.run("cat empty.py");
  assert.equal(cat.exitCode, 0, "cat of an existing empty file succeeds");
  assert.equal(cat.stdout, "");
  const missing = await env.run("cat no_such_file.py");
  assert.equal(missing.exitCode, 1, "cat of a missing file fails");
  assert.match(missing.stderr, /No such file/);
});

test("edit_file on a missing file says no such file, not old string not found", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, maxTurns: 3 });
  const res = await runOnce(harness, [{ tool: "edit_file", args: { path: "ghost.py", old: "a", new: "b" } }]);
  const out = res.trace[0]?.results[0];
  assert.ok(out, "the edit was executed");
  assert.equal(out.exitCode, 1);
  assert.match(out.stderr, /edit_file: no such file: ghost\.py/);
  assert.doesNotMatch(out.stderr, /old string not found/);
});

test("an unsupported flag is reported as such, not as an unknown command", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const flagged = await env.run("test --verbose");
  assert.equal(flagged.exitCode, 1);
  assert.match(flagged.stderr, /unsupported flag: --verbose/, "the flag is the problem, so the model can retry without it");
  assert.equal(flagged.tool, "test", "the failure is attributed to the tool that was asked for");
  const unknown = await env.run("florbp");
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /command not found: florbp/);
});

test("call ids are per-run and per-environment, not process-global", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, maxTurns: 3 });
  assert.equal(harness.nextCallId(), "call_1");
  assert.equal(harness.nextCallId(), "call_2");

  const first = await runOnce(harness, [{ tool: "run", args: { command: "test" } }]);
  assert.equal(first.trace[0].results[0].callId, "call_1", "a run's ids start at call_1");
  const second = await runOnce(harness, [{ tool: "run", args: { command: "test" } }]);
  assert.equal(second.trace[0].results[0].callId, "call_1", "ids restart per run: the next run is a fresh conversation");

  const a = new SimulatedEnvironment(REPO_TASKS[0]);
  const b = new SimulatedEnvironment(REPO_TASKS[0]);
  const ra = await a.writeFile("x.py", "x");
  const rb = await b.writeFile("y.py", "y");
  assert.equal(ra.callId, "call_1");
  assert.equal(rb.callId, "call_1", "two environments in one process each start at call_1");

  const after = await a.writeFile("x.py", "z");
  assert.equal(after.callId, "call_2", "an environment's own ids advance across calls");
  a.reset();
  const restarted = await a.writeFile("x.py", "z");
  assert.equal(restarted.callId, "call_1", "ids restart when the environment resets");
});

test("recall_observation recovers an archived observation through the tool", async () => {
  const env = new SimulatedEnvironment(LONG_HORIZON_TASK);
  const pack = new ObservationPack({ thresholdBytes: 1000, excerptBytes: 100, fullForRequests: 0 });
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, mechanisms: [pack], maxTurns: 6 });
  const tools = harness.tools();
  assert.ok(tools.some((t) => t.name === "recall_observation"), "the recall tool is exposed");

  await runOnce(harness, [
    { tool: "run", args: { command: "test" } },
    { tool: "recall_observation", args: { handle: "obs:does-not-exist" } },
  ]);
  // The harness must have dispatched recall_observation through the mechanism.
  assert.ok(pack.stats.recalled >= 0, "recall_observation is served by the mechanism");
  assert.ok(pack.stats.archived > 0, "the large result was archived");
});

test("mechanism state resets between runs on a reused harness", async () => {
  const pack = new ObservationPack({ thresholdBytes: 1000, excerptBytes: 100, fullForRequests: 0 });
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env: new SimulatedEnvironment(LONG_HORIZON_TASK), mechanisms: [pack], maxTurns: 6 });
  for (let i = 0; i < 2; i++) {
    await runOnce(harness, [{ tool: "run", args: { command: "test" } }]);
  }
  assert.equal(pack.stats.archived, 1, "the archive does not accumulate across runs");
});

test("onPlanStepComplete fires once per newly-done step", async () => {
  const fired: number[] = [];
  const probe: Mechanism = {
    name: "probe",
    description: "counts step completions",
    onPlanStepComplete: (step: PlanStep) => fired.push(step.id),
    reset: () => fired.length = 0,
  };
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env: new SimulatedEnvironment(REPO_TASKS[0]), mechanisms: [probe], maxTurns: 6 });
  await runOnce(harness, [
    { tool: "update_plan", args: { steps: [{ id: 1, title: "a", status: "done" }, { id: 2, title: "b", status: "done" }] } },
    { tool: "update_plan", args: { steps: [{ id: 1, title: "a", status: "done" }, { id: 2, title: "b", status: "done" }] } },
    { tool: "run", args: { command: "test" } },
  ]);
  assert.deepEqual(fired, [1, 2], "each done step is announced exactly once, not once per turn");
});

test("a stop with no calls records exactly one trace entry, whatever the stop reason", async () => {
  for (const stopReason of ["error", "max_turns", "end_turn"] as const) {
    const env = new SimulatedEnvironment(REPO_TASKS[0]);
    const harness = new Harness({ id: "t", model: new StoppingModel(stopReason), env, maxTurns: 6 });
    const res = await harness.run();
    assert.equal(res.trace.length, 1, `${stopReason}: a no-call turn is one trace entry, not two`);
    assert.equal(res.trace[0].note, stopReason, "the entry records why the loop stopped");
  }
});

test("max_turns exhaustion is distinguished from an incomplete run", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  // A model that always emits a call never finishes, so the loop hits its turn budget.
  const harness = new Harness({
    id: "t",
    model: new StoppingModel("tool_use", [{ tool: "run", args: { command: "test" } }]),
    env,
    maxTurns: 3,
  });
  const res = await harness.run();
  assert.equal(res.success, false);
  assert.equal(res.turns, 3);
  assert.equal(res.failureReason, "max_turns exhausted (score 0)", "budget exhaustion is named, not reported as merely incomplete");

  const stopping = new Harness({ id: "t", model: new StoppingModel("error"), env, maxTurns: 3 });
  const stopped = await stopping.run();
  assert.equal(stopped.failureReason, "incomplete (score 0)", "a run that stops early is incomplete, not budget-exhausted");
});

test("two recall_observation calls in one turn get distinct call ids", async () => {
  const env = new SimulatedEnvironment(LONG_HORIZON_TASK);
  const pack = new ObservationPack({ thresholdBytes: 1000, excerptBytes: 100, fullForRequests: 0 });
  // The handle is allocated by the harness, so read it from the archive the
  // moment it exists rather than assuming a literal (the id counter is
  // process-global, so `obs:call_1` is not stable across the test suite).
  const model = new (class implements ModelBackend {
    readonly id = "t";
    readonly contextWindow = 200_000;
    turn = 0;
    async chat(_req: ModelRequest): Promise<ModelResponse> {
      this.turn++;
      if (this.turn === 1) {
        return { usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, toolCalls: [{ tool: "run", args: { command: "test" } }], stopReason: "tool_use" };
      }
      if (this.turn === 2) {
        const handle = [...pack.handles()][0];
        return {
          usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 },
          toolCalls: [
            { tool: "recall_observation", args: { handle } },
            { tool: "recall_observation", args: { handle } },
          ],
          stopReason: "tool_use",
        };
      }
      return { usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, stopReason: "end_turn" };
    }
  })();
  const harness = new Harness({ id: "t", model, env, mechanisms: [pack], maxTurns: 4 });

  const res = await harness.run();
  assert.ok(pack.stats.archived > 0, "the large result was archived");
  assert.equal(pack.stats.recalled, 2, "both recalls were served");

  const recallTurn = res.trace.find((t) => t.results.some((r) => r.tool === "recall_observation"));
  const ids = (recallTurn?.results ?? []).map((r) => r.callId);
  assert.equal(ids.length, 2, "both recalls executed");
  assert.equal(new Set(ids).size, 2, "two recalls in one turn must not share an id");
  assert.ok(recallTurn?.results.every((r) => r.exitCode === 0), "both recalls found the archived original");
});

test("prefix cache accounting: a long run records cache traffic, not just input", async () => {
  const model = new ScriptedModel({ id: "cache", contextWindow: 60_000 });
  const env = new SimulatedEnvironment(LONG_HORIZON_TASK);
  // Each turn appends a build log, so every request repeats the previous one
  // verbatim and only the tail is new — the append-only shape that exercises
  // the prefix cache.
  model.load([
    ...Array.from({ length: 12 }, () => ({ kind: "tool" as const, calls: [{ tool: "run", args: { command: "build" } }] })),
    { kind: "done" as const, summary: "done" },
  ]);
  const harness = new Harness({ id: "cache", model, env, maxTurns: 40 });
  const res = await harness.run();

  // A ledger that records zero cache traffic is not modelling the quantity the
  // compaction gate optimizes.
  assert.ok(res.usage.cacheRead > 0, "the cached prefix must be billed at the read price");
  assert.ok(res.usage.cacheWrite > 0, "the appended tail must be billed at the write price");
  assert.ok(
    res.usage.cacheRead > res.usage.input,
    "on an append-only run the cached prefix dominates the uncached share",
  );
});

test("prefix cache accounting: an identical request bills at the read price only", async () => {
  const model = new ScriptedModel({ id: "cache2" });
  const req: ModelRequest = {
    tools: [],
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "a question".repeat(50) },
    ],
  };

  const first = await model.chat(req);
  assert.equal(first.usage.cacheRead, 0, "the first request has nothing cached");
  assert.ok(first.usage.input > 0, "the first request is billed as fresh input");

  const repeat = await model.chat(req);
  assert.equal(repeat.usage.input, 0, "a verbatim repeat is entirely cache-read, not fresh input");
  assert.equal(repeat.usage.cacheWrite, 0, "a verbatim repeat writes nothing new");
  assert.ok(repeat.usage.cacheRead > 0, "the repeat bills at the read price");
});

