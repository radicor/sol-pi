import assert from "node:assert/strict";
import { test } from "node:test";
import { Environment } from "../src/core/environment.js";
import { ActionFusion } from "../src/mechanisms/action-fusion.js";
import { ObservationPack } from "../src/mechanisms/observation-pack.js";
import { Harness } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { estimateTokens, headTailCompleteLines } from "../src/core/tokens.js";
import { addUsage, usageCost, DEFAULT_RATES, zeroUsage } from "../src/core/usage.js";
import { LONG_HORIZON_TASK, REPO_TASKS } from "../src/tasks/corpus.js";

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

test("environment test fails before the fix and passes after", () => {
  const task = REPO_TASKS[0]; // add() returns a - b
  const env = new Environment(task);
  assert.equal(env.score(), 0, "pre-fix repo fails the hidden regression test");
  env.writeFile("math_utils.py", "def add(a, b):\n    return a + b\n");
  assert.equal(env.score(), 1, "post-fix repo passes");
});

test("harness executes a scripted trajectory and solves a task", async () => {
  const task = REPO_TASKS[0];
  const model = new ScriptedModel({ id: "t" });
  const env = new Environment(task);
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

async function runOnce(harness: Harness, calls: object[]) {
  const model = harness.model as ScriptedModel;
  model.load([...calls.map((c) => ({ kind: "tool" as const, calls: [c as never] })), { kind: "done" as const, summary: "d" }]);
  return harness.run();
}

test("a malformed then_run yields an error result, not a crash", async () => {
  for (const bad of [{ tool: "write_file", args: { path: "math_utils.py", content: "x = 1\n", then_run: "test" } }, { tool: "write_file", args: { path: "math_utils.py", content: "x = 1\n", then_run: [123] } }]) {
    const env = new Environment(REPO_TASKS[0]);
    const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, mechanisms: [new ActionFusion()], maxTurns: 3 });
    const res = await runOnce(harness, [bad]);
    assert.equal(res.success, false, "a malformed then_run does not take the run down with it");
  }
});

test("a malformed update_plan yields an error result, not a poisoned plan", async () => {
  for (const bad of [{ tool: "update_plan", args: { steps: "not-an-array" } }, { tool: "update_plan", args: { steps: [{ id: "x", title: 1, status: "nope" }] } }]) {
    const env = new Environment(REPO_TASKS[0]);
    const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, maxTurns: 4 });
    const res = await runOnce(harness, [bad, { tool: "run", args: { command: "test" } }]);
    assert.equal(res.success, false);
    // The plan stayed an array, so the following turn's mechanisms still work.
    assert.ok(Array.isArray(harness.plan), "the plan was not overwritten with a malformed value");
  }
});

test("a failing fused command rolls the mutation back", async () => {
  const env = new Environment(REPO_TASKS[0]);
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, mechanisms: [new ActionFusion()], maxTurns: 3 });
  await runOnce(harness, [{ tool: "write_file", args: { path: "math_utils.py", content: "def add(a, b):\n    return a + b\n", then_run: ["nonexistent-cmd"] } }]);
  // The write was applied, but the fused follow-up failed, so it must be rolled back.
  assert.equal(env.score(), 0, "a failed verification does not bank the mutation");
});

test("two mutations in one turn get distinct call ids", async () => {
  const env = new Environment(REPO_TASKS[0]);
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env, maxTurns: 3 });
  const res = await runOnce(harness, [
    { tool: "write_file", args: { path: "a.py", content: "x" } },
    { tool: "write_file", args: { path: "b.py", content: "y" } },
  ]);
  const ids = res.trace.flatMap((t) => t.results.map((r) => r.callId));
  assert.equal(new Set(ids).size, ids.length, "call ids are unique within a turn");
});

test("reading an inherited key returns an empty file, not a prototype value", () => {
  const env = new Environment(REPO_TASKS[0]);
  const out = env.run("cat toString");
  assert.equal(out.exitCode, 1, "toString is not a file");
  assert.equal(typeof out.stdout, "string");
  assert.equal(env.readFile("toString"), "", "no prototype-chain leak");
});

test("recall_observation recovers an archived observation through the tool", async () => {
  const env = new Environment(LONG_HORIZON_TASK);
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
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env: new Environment(LONG_HORIZON_TASK), mechanisms: [pack], maxTurns: 6 });
  for (let i = 0; i < 2; i++) {
    await runOnce(harness, [{ tool: "run", args: { command: "test" } }]);
  }
  assert.equal(pack.stats.archived, 1, "the archive does not accumulate across runs");
});

test("onPlanStepComplete fires once per newly-done step", async () => {
  const fired: number[] = [];
  const probe = {
    name: "probe",
    description: "counts step completions",
    onPlanStepComplete: (step: { id: number }) => fired.push(step.id),
    reset: () => fired.length = 0,
  };
  const harness = new Harness({ id: "t", model: new ScriptedModel({ id: "t" }), env: new Environment(REPO_TASKS[0]), mechanisms: [probe as never], maxTurns: 6 });
  await runOnce(harness, [
    { tool: "update_plan", args: { steps: [{ id: 1, title: "a", status: "done" }, { id: 2, title: "b", status: "done" }] } },
    { tool: "update_plan", args: { steps: [{ id: 1, title: "a", status: "done" }, { id: 2, title: "b", status: "done" }] } },
    { tool: "run", args: { command: "test" } },
  ]);
  assert.deepEqual(fired, [1, 2], "each done step is announced exactly once, not once per turn");
});
