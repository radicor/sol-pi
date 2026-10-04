import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionFusion } from "../src/mechanisms/action-fusion.js";
import { EvidencePreservingReducer, RECEIPT_MARKER, SimpleExtractor, hashString } from "../src/mechanisms/evidence-reducer.js";
import { ObservationPack } from "../src/mechanisms/observation-pack.js";
import { OnlineContextCompact } from "../src/mechanisms/online-compact.js";
import { Environment } from "../src/core/environment.js";
import { Harness } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { LONG_HORIZON_TASK, REPO_TASKS } from "../src/tasks/corpus.js";
import { ToolResult } from "../src/core/types.js";

function fakeCtx(requestsSoFar = 5) {
  return {
    turn: 1,
    requestsSoFar,
    env: new Environment(REPO_TASKS[0]),
    plan: [],
    harness: undefined as never,
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
  pack.transformResult(small, fakeCtx(1));
  assert.equal(pack.stats.archived, 0);
});

test("ObservationPack skips verified receipts", () => {
  const pack = new ObservationPack({ thresholdBytes: 1000, fullForRequests: 0 });
  const receipt: ToolResult = { ...bigResult(5000), stdout: `${RECEIPT_MARKER}\nhash: abc\n` };
  pack.transformResult(receipt, fakeCtx(1));
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

test("Online Context Compact reduces tokens on a long-horizon run", async () => {
  const make = async (mechs: never[]) => {
    const model = new ScriptedModel({ id: "m", contextWindow: 60_000 });
    const env = new Environment(LONG_HORIZON_TASK);
    const steps = buildLongScript();
    model.load(steps);
    const h = new Harness({ id: "m", model, env, mechanisms: mechs, maxTurns: 40 });
    return h.run();
  };
  const base = await make([]);
  const withCompact = await make([new OnlineContextCompact({ contextWindow: 60_000 }) as never]);
  assert.ok(
    base.usage.input + base.usage.output > withCompact.usage.input + withCompact.usage.output,
    "compaction should reduce recorded traffic on a long run",
  );
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
