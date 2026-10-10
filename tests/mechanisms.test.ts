import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionFusion } from "../src/mechanisms/action-fusion.js";
import { EvidencePreservingReducer, RECEIPT_MARKER, SimpleExtractor, hashString } from "../src/mechanisms/evidence-reducer.js";
import { ObservationPack } from "../src/mechanisms/observation-pack.js";
import { OnlineContextCompact } from "../src/mechanisms/online-compact.js";
import { SimulatedEnvironment } from "../src/core/environment.js";
import { Harness, LoopContext, Mechanism } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { LONG_HORIZON_TASK, REPO_TASKS } from "../src/tasks/corpus.js";
import { ToolResult } from "../src/core/types.js";
import { totalTokens } from "../src/core/usage.js";

function fakeCtx(requestsSoFar = 5): LoopContext {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const harness = new Harness({ id: "probe", model: new ScriptedModel({ id: "probe" }), env });
  return {
    turn: 1,
    requestsSoFar,
    env,
    plan: [],
    harness,
  };
}

function bigResult(bytes: number, callId = "call_x", tool = "test"): ToolResult {
  const lines: string[] = ["============================= test session starts ============================="];
  let len = lines[0].length;
  let i = 0;
  while (len < bytes) {
    const l = `log line ${i} with some filler text to pad the length out`;
    lines.push(l);
    len += l.length + 1;
    i++;
  }
  // Real build/test logs carry failure evidence the extractor can quote.
  lines.push("_______________________________ test_add _______________________________");
  lines.push("E       AssertionError: add(2, 3) returned -1, expected 5");
  lines.push("=========== 1 passed, 1 failed in 0.5s ===========");
  const body = lines.join("\n");
  return { callId, tool, stdout: body, stderr: "", exitCode: 1, bytes: body.length };
}

/* ---------------- Action Fusion ---------------- */

test("Action Fusion exposes a then_run parameter on mutation tools", () => {
  const fusion = new ActionFusion();
  const tools = fusion.transformTools([
    {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    },
    { name: "run", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } },
  ]);
  const write = tools.find((t) => t.name === "write_file");
  assert.ok((write!.parameters as Record<string, unknown>).properties, "properties preserved");
  assert.ok(((write!.parameters as Record<string, unknown>).properties as Record<string, unknown>).then_run, "then_run added");
});

test("Action Fusion merges an edit followed by a run into one call", () => {
  const fusion = new ActionFusion();
  const out = fusion.transformCalls(
    [
      { tool: "write_file", args: { path: "a.py", content: "x" } },
      { tool: "run", args: { command: "test" } },
    ],
    fakeCtx(),
  );
  assert.equal(out.length, 1);
  assert.deepEqual((out[0].args.then_run as string[]), ["test"]);
  assert.equal(fusion.fusedCount, 1);
});

test("Action Fusion leaves inspection commands separate", () => {
  const fusion = new ActionFusion();
  const out = fusion.transformCalls(
    [
      { tool: "write_file", args: { path: "a.py", content: "x" } },
      { tool: "run", args: { command: "cat a.py" } },
    ],
    fakeCtx(),
  );
  assert.equal(out.length, 2, "commands that inspect the mutation result stay separate");
  assert.equal(fusion.fusedCount, 0);
});

/* ---------------- ObservationPack ---------------- */

test("ObservationPack archives large results and substitutes an excerpt after the grace window", () => {
  const pack = new ObservationPack({ thresholdBytes: 1000, excerptBytes: 200, fullForRequests: 2 });
  const result = bigResult(5000);
  const ctx = fakeCtx(10);
  // Projection is what the harness stores in the context; it also archives.
  const archived = pack.projectObservation(result.stdout, result, ctx);
  assert.equal(archived, result.stdout, "full result for the first requests");

  // Substitution happens on later requests, when the context is re-projected.
  const tool = { role: "tool", content: result.stdout, name: "run", callId: "call_x" } as const;
  const later = pack.transformContext([{ role: "system", content: "s" }, tool], fakeCtx(13));
  const projected = later.find((m) => m.callId === "call_x");
  assert.ok(projected!.content.includes("archived"), "later requests get the archived view");
  assert.ok(projected!.content.length < result.stdout.length, "substituted view is smaller");
  assert.ok(pack.has("obs:call_x"));
  assert.equal(pack.recall("obs:call_x"), result.stdout, "exact original is recoverable");
});

test("ObservationPack leaves small results untouched", () => {
  const pack = new ObservationPack({ thresholdBytes: 1000 });
  const small = bigResult(100);
  // Exercise the real path: projectObservation is what decides to archive.
  const out = pack.projectObservation(small.stdout, small, fakeCtx(1));
  assert.equal(out, small.stdout, "small results pass through unchanged");
  assert.equal(pack.stats.archived, 0);
});

test("ObservationPack skips verified receipts", () => {
  const pack = new ObservationPack({ thresholdBytes: 1000, fullForRequests: 0 });
  const receipt: ToolResult = { ...bigResult(5000), stdout: `${RECEIPT_MARKER}\nhash: abc\n` };
  // Below threshold it would pass through anyway, so archive via the receipt path.
  const out = pack.projectObservation(receipt.stdout, receipt, fakeCtx(1));
  assert.equal(out, receipt.stdout, "receipts pass through unchanged");
  assert.equal(pack.stats.archived, 0, "receipts preserve verified evidence");
});

/* ---------------- Evidence-Preserving Reducer ---------------- */

test("hashString is deterministic and content-sensitive", () => {
  assert.equal(hashString("abc"), hashString("abc"));
  assert.notEqual(hashString("abc"), hashString("abd"));
});

test("Reducer converts a large log into a verified receipt", () => {
  const reducer = new EvidencePreservingReducer({ thresholdBytes: 1000 });
  const big = bigResult(6000, "call_big", "test");
  const out = reducer.transformResult(big, fakeCtx(1));
  assert.ok(out.stdout.startsWith(RECEIPT_MARKER), "output is a receipt");
  assert.ok(out.bytes < big.bytes, "receipt is smaller");
  assert.equal(reducer.stats.reduced, 1);
  assert.equal(reducer.stats.fallbacks, 0);
  assert.ok(reducer.originalFor("call_big") !== undefined, "exact original archived");
});

test("Reducer falls back to the original when verification fails", () => {
  // Fidelity 0 makes the extractor omit quotes that the verifier requires.
  const extractor = new SimpleExtractor(0);
  const reducer = new EvidencePreservingReducer({ thresholdBytes: 1000, extractorFidelity: 0 }, extractor);
  const big = bigResult(6000, "call_bad", "test");
  const out = reducer.transformResult(big, fakeCtx(1));
  assert.equal(out.stdout, big.stdout, "unverifiable receipts fall back to the original");
  assert.equal(reducer.stats.fallbacks, 1);
});

test("Reducer bypasses file reads and search results", () => {
  const reducer = new EvidencePreservingReducer({ thresholdBytes: 1000 });
  const read = bigResult(6000, "call_read", "cat");
  reducer.transformResult(read, fakeCtx(1));
  assert.equal(reducer.stats.reduced, 0, "only build/test logs are eligible");
});

test("Reducer reduces the corpus's own bigLog output (regression: the extractor once matched none of it)", async () => {
  // The shipped corpus emits bracketed `[dep]`/`[warn]`/`[summary]` lines, and
  // the original evidence regex required a line-start letter, so every log
  // produced zero quotes and the verifier fell back unconditionally. This test
  // asserts the reducer actually reduces what the environment generates.
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const out = await env.run("test");
  const reducer = new EvidencePreservingReducer({ thresholdBytes: 1000 });
  const result = reducer.transformResult(out, fakeCtx(1));

  assert.ok(result.stdout.startsWith(RECEIPT_MARKER), "a real test log becomes a receipt");
  assert.ok(reducer.stats.reduced === 1, "reduced a real log");
  assert.ok(reducer.stats.fallbacks === 0, "no fallback");
  assert.ok(reducer.stats.savedBytes > 0, "saved bytes");
  assert.ok(reducer.originalFor(out.callId) !== undefined, "exact original archived");

  // Deterministic across repeated extractions of the same log.
  const again = new EvidencePreservingReducer({ thresholdBytes: 1000 }).transformResult(out, fakeCtx(1));
  assert.equal(again.stdout, result.stdout, "identical logs yield identical receipts");
});

test("Reducer selects failure evidence ahead of routine warnings", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const out = await env.run("test");
  const receipt = new SimpleExtractor(1.0).extract(out.stdout, 1);
  const kinds = receipt.quotes.map((q) => q.slice(0, 30));
  assert.ok(kinds.some((q) => /AssertionError/.test(q)), "the assertion is quoted");
  assert.ok(kinds.some((q) => /passed|failed/.test(q)), "the tally line is quoted");
});

test("Reducer applies the fidelity knob deterministically", async () => {
  const env = new SimulatedEnvironment(REPO_TASKS[0]);
  const out = await env.run("test");
  const counts = Array.from({ length: 4 }, () => new SimpleExtractor(0.6).extract(out.stdout, 1).quotes.length);
  assert.ok(counts.every((c) => c === counts[0]), "same log always yields the same quote set");
  assert.ok(counts[0] > 0, "a sub-unit fidelity still keeps evidence");
  assert.equal(new SimpleExtractor(0).extract(out.stdout, 1).quotes.length, 0);
});

test("Reducer only reduces the exact tool allowlist, not name prefixes", () => {
  const reducer = new EvidencePreservingReducer({ thresholdBytes: 1000 });
  for (const tool of ["testing", "npm-audit", "cargo-lint", "cat", "grep"]) {
    reducer.transformResult(bigResult(6000, `call_${tool}`, tool), fakeCtx(1));
  }
  assert.equal(reducer.stats.reduced, 0, "prefix-adjacent names are not build/test logs");
  for (const tool of ["test", "pytest", "npm", "build", "cargo"]) {
    reducer.transformResult(bigResult(6000, `call_${tool}`, tool), fakeCtx(1));
  }
  assert.equal(reducer.stats.reduced, 5, "the allowlisted tool names reduce");
});

/* ---------------- Online Context Compact ---------------- */

test("cost gate compares projected savings against the cache-rewrite cost", () => {
  const compact = new OnlineContextCompact({ contextWindow: 100_000, compactTargetFraction: 0.5 });
  const ctx = { ...fakeCtx(10), plan: [
    { id: 1, title: "a", status: "done" as const },
    { id: 2, title: "b", status: "in_progress" as const },
  ] };
  // A large context with several requests remaining should pass.
  assert.ok(compact.costGatePasses(90_000, ctx));
  // A tiny context has nothing worth compacting.
  assert.ok(!compact.costGatePasses(2_000, ctx));
});

test("compaction shortens the context while keeping the head and tail", () => {
  const compact = new OnlineContextCompact({ contextWindow: 100_000 });
  const messages = [
    { role: "system" as const, content: "system prompt" },
    { role: "user" as const, content: "task description" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: "tool" as const, content: `observation ${i} `.repeat(200), name: "run", callId: `c${i}` })),
    { role: "assistant" as const, content: "final answer" },
  ];
  const before = messages.reduce((n, m) => n + m.content.length, 0);
  const out = compact.compact(messages);
  const after = out.reduce((n, m) => n + m.content.length, 0);
  assert.ok(after < before, "compaction shortens the context");
  assert.equal(out[0].role, "system", "system prompt preserved");
  assert.equal(out[out.length - 1].content, "final answer", "recent turns preserved");
  assert.ok(out.some((m) => m.content.includes("compacted")), "middle is summarized");
});

test("Online Context Compact reduces traffic on a long-horizon run", async () => {
  const base = await buildAndRun([]);
  const withCompact = await buildAndRun([new OnlineContextCompact({ contextWindow: 60_000 })]);

  // Traffic is the whole request volume, so it must total the cached prefix in
  // too. Comparing `input + output` alone would invert: compaction rewrites
  // mid-context, so its suffix bills at the fresh price and its `input` is
  // far *higher* than the baseline's, which mostly bills at the read price.
  assert.ok(
    totalTokens(base.usage) > totalTokens(withCompact.usage),
    "compaction should reduce recorded traffic on a long run",
  );
  assert.ok(base.cost > withCompact.cost, "compaction should reduce cost on a long run");
  assert.ok(
    withCompact.usage.input > base.usage.input,
    "compaction invalidates the prefix cache, so its uncached input share is larger",
  );
});

test("the trace records which turns rewrote the context, with before/after counts", async () => {
  const base = await buildAndRun([]);
  const withCompact = await buildAndRun([new OnlineContextCompact({ contextWindow: 60_000 })]);

  assert.ok(
    base.trace.every((t) => !t.compacted),
    "a run with no context mechanism must mark no turn as rewritten",
  );

  const rewrites = withCompact.trace.filter((t) => t.compacted);
  assert.ok(rewrites.length > 0, "compaction must mark the turns it rewrote");
  for (const t of rewrites) {
    assert.ok(t.note, "a rewritten turn must carry a note");
    const counts = t.note!.match(/(\d+) -> (\d+) tokens/);
    assert.ok(counts, `the note must carry before/after token counts, got "${t.note}"`);
    const [, before, after] = counts;
    assert.ok(Number(after) < Number(before), "a rewrite must shorten the context");
  }
});

function buildLongScript() {
  const fix = { path: "server.py", content: "def health():\n    return 'ok'\n" };
  const steps: { kind: "tool"; calls: { tool: string; args: Record<string, unknown> }[] }[] = [
    { kind: "tool", calls: [{ tool: "read_file", args: { path: fix.path } }] },
    { kind: "tool", calls: [{ tool: "write_file", args: { path: fix.path, content: fix.content } }] },
    { kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] },
  ];
  for (let i = 0; i < 8; i++) {
    steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "build" } }] });
    steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] });
  }
  return steps;
}

function buildAndRun(mechs: Mechanism[]) {
  const model = new ScriptedModel({ id: "m", contextWindow: 60_000 });
  const env = new SimulatedEnvironment(LONG_HORIZON_TASK);
  model.load(buildLongScript());
  const h = new Harness({ id: "m", model, env, mechanisms: mechs, maxTurns: 40 });
  return h.run();
}
