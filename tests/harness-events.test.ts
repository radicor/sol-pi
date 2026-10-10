import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulatedEnvironment } from "../src/core/environment.js";
import { Harness, HarnessEvent, Mechanism } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { RunResult } from "../src/core/types.js";
import { LONG_HORIZON_TASK, REPO_TASKS } from "../src/tasks/corpus.js";

/** The trajectory test 5 uses: read, write, run-test, done. */
const SOLVE_SCRIPT = [
  { kind: "tool" as const, calls: [{ tool: "read_file", args: { path: "math_utils.py" } }] },
  {
    kind: "tool" as const,
    calls: [
      { tool: "write_file", args: { path: "math_utils.py", content: "def add(a, b):\n    return a + b\n" } },
    ],
  },
  { kind: "tool" as const, calls: [{ tool: "run", args: { command: "test" } }] },
  { kind: "done" as const, summary: "done" },
];

function buildHarness(): Harness {
  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  model.load(SOLVE_SCRIPT);
  return new Harness({ id: "t", model, env, maxTurns: 10 });
}

/** Drive a harness through the split API instead of `run()`. */
async function drive(harness: Harness): Promise<void> {
  harness.begin();
  while (!(await harness.step()).stopped) {
    /* one turn at a time */
  }
  harness.finish();
}

test("begin + step + finish reproduces run() exactly", async () => {
  const a = buildHarness();
  const resRun = await a.run();

  const b = buildHarness();
  await drive(b);

  // `turn` is protected on the base class but is the loop's own bookkeeping;
  // read it through the same accessor `finish()` reports.
  assert.equal((b as Harness & { turn: number }).turn, resRun.turns, "same turn count");
  // Call ids are minted from a process-global counter, so they differ between
  // runs; compare the trace with ids normalized away rather than deep-equal.
  const strip = (t: RunResult["trace"]) =>
    t.map((e) => ({
      turn: e.turn,
      requestTokens: e.requestTokens,
      compacted: e.compacted,
      note: e.note,
      calls: e.toolCalls.map((c) => ({ tool: c.tool, args: c.args })),
      results: e.results.map((res) => ({
        tool: res.tool,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        bytes: res.bytes,
        error: res.error,
      })),
    }));
  assert.deepEqual(strip(b.trace), strip(resRun.trace), "identical trace modulo call ids");
  assert.deepEqual(b.meter.get(), resRun.usage, "identical usage");
  assert.equal(b.meter.cost(), resRun.cost, "identical cost");
  assert.equal(b.env.score(), resRun.score, "identical score");

  // The final context is identical once the same ids are normalized.
  const msgKey = (m: { role: string; content: string; name?: string }) => `${m.role}:${m.content}:${m.name ?? ""}`;
  assert.deepEqual(
    b.messages.map(msgKey),
    a.messages.map(msgKey),
    "identical final context modulo call ids",
  );
});

test("the event stream covers every loop milestone in order", async () => {
  const events: HarnessEvent[] = [];
  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  model.load(SOLVE_SCRIPT);
  const harness = new Harness({
    id: "t",
    model,
    env,
    maxTurns: 10,
    onEvent: (e) => events.push(e),
  });
  await harness.run();

  const kinds = events.map((e) => e.type);
  assert.equal(kinds[0], "run_started", "opens the run");
  assert.equal(kinds[kinds.length - 1], "run_finished", "closes the run");
  assert.ok(kinds.includes("model_request"), "sees each request");
  assert.ok(kinds.includes("model_response"), "sees each response");
  assert.ok(kinds.includes("calls_prepared"), "sees the prepared batch");
  assert.ok(kinds.includes("tool_started"), "sees each call start");
  assert.ok(kinds.includes("tool_finished"), "sees each call finish");
  assert.ok(kinds.includes("observation_appended"), "sees each observation");
  assert.ok(kinds.includes("turn_ended"), "sees each trace entry");

  // Every non-final turn ends before the next begins; run_started precedes all.
  const firstTurn = kinds.indexOf("turn_ended");
  assert.ok(kinds.slice(0, firstTurn).includes("tool_finished"), "a turn records work before ending");
  assert.equal(kinds.filter((k) => k === "run_started").length, 1, "run starts once");
});

test("model_response usage is cumulative, including the response just recorded", async () => {
  let seen: number[] = [];
  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  model.load(SOLVE_SCRIPT);
  const harness = new Harness({
    id: "t",
    model,
    env,
    maxTurns: 10,
    onEvent: (e) => {
      if (e.type === "model_response") seen.push(e.usage.input + e.usage.output);
    },
  });
  await harness.run();

  assert.ok(seen.length >= 3, "recorded a usage sample per request");
  // Cumulative means monotonic: each sample includes all previous requests.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `usage is cumulative (${seen[i - 1]} -> ${seen[i]})`);
  }
});

test("cancellation stops the loop after the current turn", async () => {
  const ac = new AbortController();
  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(LONG_HORIZON_TASK);
  model.load([
    ...Array.from({ length: 12 }, () => ({ kind: "tool" as const, calls: [{ tool: "run", args: { command: "build" } }] })),
    { kind: "done" as const, summary: "done" },
  ]);
  const harness = new Harness({ id: "t", model, env, maxTurns: 40 });
  harness.begin();
  await harness.step();
  // Abort between turns: the current turn completes, the next does not start.
  ac.abort();
  const r = await harness.step({ signal: ac.signal });
  assert.equal(r.stopped, true, "a stepped harness honours an aborted signal");
  assert.equal(harness.stopReason, "cancelled");
  assert.equal((harness as Harness & { turn: number }).turn, 1, "exactly one turn ran");
  const res = harness.finish();
  assert.equal(res.failureReason, "cancelled");
});

test("resume continues a session without resetting meter, trace, or context", async () => {
  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  model.load(SOLVE_SCRIPT);
  const harness = new Harness({ id: "t", model, env, maxTurns: 10 });

  harness.begin([{ role: "user", content: "first prompt" }]);
  while (!(await harness.step()).stopped) {
    /* turn */
  }
  const afterFirst = { requests: harness.meter.requests, trace: harness.trace.length, msgs: harness.messages.length };

  harness.resume("second prompt");
  assert.equal(harness.messages[harness.messages.length - 1].content, "second prompt", "resume appends the user message");
  assert.equal((harness as Harness & { turn: number }).turn, 0, "resume resets only the turn budget");
  while (!(await harness.step()).stopped) {
    /* turn */
  }

  assert.ok(harness.meter.requests > afterFirst.requests, "the meter kept counting");
  assert.ok(harness.trace.length > afterFirst.trace, "the trace kept growing");
  assert.ok(harness.messages.length > afterFirst.msgs, "the context kept growing");
});

test("event handlers are passive: they cannot alter the run", async () => {
  const reference = buildHarness();
  const resRef = await reference.run();

  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  model.load(SOLVE_SCRIPT);
  const nosy: Mechanism = {
    name: "nosy",
    description: "records nothing",
    transformContext: (msgs) => msgs,
  };
  const harness = new Harness({
    id: "t",
    model,
    env: new SimulatedEnvironment(REPO_TASKS[0]),
    mechanisms: [nosy],
    maxTurns: 10,
    onEvent: (e) => {
      if (e.type === "tool_started") {
        // A handler that tries to interfere must not change the outcome.
        harness.messages.push({ role: "user", content: "interference" });
      }
    },
  });
  const res = await harness.run();

  // The interference did land in the context (the handler is called), but it
  // could not change control flow: same turns, same score, same trace shape.
  assert.equal(res.turns, resRef.turns, "turn count is unaffected by a handler");
  assert.equal(res.score, resRef.score, "score is unaffected by a handler");
  assert.equal(res.trace.length, resRef.trace.length, "trace length is unaffected");
  assert.ok(harness.messages.some((m) => m.content === "interference"), "the handler did run");
});

test("context_rewritten reports before/after and the summary text", async () => {
  const collected: HarnessEvent[] = [];
  const model = new ScriptedModel({ id: "t" });
  const env = new SimulatedEnvironment(LONG_HORIZON_TASK);
  model.load([
    ...Array.from({ length: 6 }, () => ({ kind: "tool" as const, calls: [{ tool: "run", args: { command: "build" } }] })),
    { kind: "done" as const, summary: "done" },
  ]);
  const rewriter: Mechanism = {
    name: "rewriter",
    description: "halves the context to exercise the event",
    transformContext: (msgs) => {
      if (msgs.length < 6) return msgs;
      const head = msgs.slice(0, 2);
      const tail = msgs.slice(-2);
      return [...head, { role: "user", content: "[compacted summary]" }, ...tail];
    },
  };
  const harness = new Harness({
    id: "t",
    model,
    env,
    mechanisms: [rewriter],
    maxTurns: 20,
    onEvent: (e) => {
      collected.push(e);
    },
  });
  await harness.run();

  const isRewrite = (e: HarnessEvent): e is Extract<HarnessEvent, { type: "context_rewritten" }> =>
    e.type === "context_rewritten";
  const rewrites = collected.filter(isRewrite);

  assert.ok(rewrites.length > 0, "the rewrite fired");
  const r = rewrites[0];
  assert.ok(r.before > r.after, "before exceeds after");
  assert.equal(r.summary, "[compacted summary]", "the event carries the inserted summary text");
  // The trace note and the event agree on the counts.
  const entry = harness.trace.find((t) => t.compacted);
  assert.ok(entry, "the trace marked the rewritten turn");
  assert.ok(entry!.note!.includes(String(r.after)), "the trace note quotes the same after-count");
});
