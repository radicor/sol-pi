import assert from "node:assert/strict";
import { test } from "node:test";
import { Environment } from "../src/core/environment.js";
import { Harness } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { estimateTokens, headTailCompleteLines } from "../src/core/tokens.js";
import { addUsage, usageCost, DEFAULT_RATES, zeroUsage } from "../src/core/usage.js";
import { REPO_TASKS } from "../src/tasks/corpus.js";

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
