import assert from "node:assert/strict";
import { test } from "node:test";
import { AutoResearchLoop, CandidateConfig, EvalResult, ProposalFamily } from "../src/research/loop.js";
import { ModelBackend, ScriptedModel, ScriptStep } from "../src/core/model.js";
import { Harness, HarnessOptions } from "../src/core/harness.js";
import { SimulatedEnvironment } from "../src/core/environment.js";
import { buildMechanisms, MechanismName } from "../src/mechanisms/stack.js";
import { REPO_TASKS } from "../src/tasks/corpus.js";

const FIXTURE = {
  "math_utils.py": "def add(a, b):\n    return a + b\n",
  "format.ts": "export function formatStatus(s: string): string {\n  return s.toUpperCase();\n}\n",
  "main.go": "func main() {\n  if !run() { os.Exit(1) }\n}\n\nfunc run() bool { return false }\n",
};

function scriptFor(taskId: string, config: CandidateConfig) {
  const path = taskId === "repo-001" ? "math_utils.py" : taskId === "repo-002" ? "format.ts" : "main.go";
  const content = FIXTURE[path as keyof typeof FIXTURE];
  const supportsFusion = config.mechanisms.includes("ActionFusion");
  const steps: ScriptStep[] = [
    { kind: "tool", calls: [{ tool: "read_file", args: { path } }] },
    { kind: "tool", calls: [{ tool: "write_file", args: { path, content } }] },
  ];
  if (!supportsFusion) steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] });
  steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] });
  steps.push({ kind: "done", summary: "done" });
  return steps;
}

function buildHarness(config: CandidateConfig, opts: HarnessOptions): Harness {
  return new Harness({
    ...opts,
    mechanisms: buildMechanisms({ mechanisms: config.mechanisms as MechanismName[], ...config.params }),
  });
}

function evalStub(over: Partial<EvalResult> = {}): EvalResult {
  return {
    configId: "stub",
    config: { id: "stub", mechanisms: [], params: {}, family: "improvement-and-evaluation", origin: "test" },
    perTask: [],
    aggregateScore: 0,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    tokenTraffic: 0,
    cost: 0,
    tokenEfficiency: 0,
    solved: 0,
    total: 0,
    traces: [],
    ...over,
  };
}

function makeLoop() {
  // L-13: the factory's constructions are recorded so a test can prove the loop
  // asks for a fresh model per task rather than reusing one conversation's state.
  const constructions: ModelBackend[] = [];
  const modelFactory = () => {
    const model = new ScriptedModel({ id: "test", contextWindow: 200_000 });
    constructions.push(model);
    return model;
  };
  const baseline: CandidateConfig = { id: "pi", mechanisms: [], params: {}, family: "improvement-and-evaluation", origin: "base" };
  const cheap: CandidateConfig = { id: "cheap", mechanisms: ["EvidencePreservingReducer", "ObservationPack"], params: {}, family: "context", origin: "test" };
  const wasteful: CandidateConfig = { id: "wasteful", mechanisms: [], params: {}, family: "tools", origin: "test" };
  return {
    modelFactory,
    baseline,
    candidates: [cheap, wasteful],
    constructions,
    loop: new AutoResearchLoop({
      model: modelFactory,
      tasks: REPO_TASKS,
      baselineConfig: baseline,
      candidates: [cheap, wasteful],
      acceptance: AutoResearchLoop.defaultAcceptance(),
      scriptFor: (task, config) => scriptFor(task.id, config),
      buildHarness,
    }),
  };
}

test("capability gate rejects a candidate that drops score beyond tolerance", () => {
  const { loop } = makeLoop();
  const base = evalStub({ aggregateScore: 0.9 });
  const bad = evalStub({ aggregateScore: 0.5 });
  const out = loop.capabilityGate(bad, base, AutoResearchLoop.defaultAcceptance());
  assert.equal(out.pass, false);
  assert.ok(out.reason.includes("below baseline"));
});

test("capability gate accepts a candidate within tolerance", () => {
  const { loop } = makeLoop();
  const base = evalStub({ aggregateScore: 0.9 });
  const ok = evalStub({ aggregateScore: 0.87 });
  assert.equal(loop.capabilityGate(ok, base, AutoResearchLoop.defaultAcceptance()).pass, true);
});

test("a zero-baseline capability gate aborts instead of rubber-stamping", () => {
  // A degenerate baseline would otherwise pass every candidate, including one
  // that also scores zero — the optimiser-gaming hole fixed gates exist to close.
  const { loop } = makeLoop();
  const base = evalStub({ aggregateScore: 0 });
  const cand = evalStub({ aggregateScore: 0, tokenTraffic: 1, cost: 0.01 });
  const out = loop.capabilityGate(cand, base, AutoResearchLoop.defaultAcceptance());
  assert.equal(out.pass, false);
  assert.ok(out.reason.includes("undefined"), out.reason);
});

test("gate rejects an undeclared metric name rather than passing on undefined", () => {
  const { loop } = makeLoop();
  const base = evalStub({ aggregateScore: 0.9 });
  const cand = evalStub({ aggregateScore: 0.9 });
  const typo = { ...AutoResearchLoop.defaultAcceptance(), capabilityMetric: "aggreggateScore" };
  assert.throws(() => loop.capabilityGate(cand, base, typo), /aggreggateScore/);
});

test("efficiency gate requires a declared metric to improve", () => {
  const { loop } = makeLoop();
  const rule = AutoResearchLoop.defaultAcceptance();
  const base = evalStub({ tokenTraffic: 1000, cost: 10 });
  const better = evalStub({ tokenTraffic: 500, cost: 10 });
  const worse = evalStub({ tokenTraffic: 990, cost: 10 });
  assert.equal(loop.efficiencyGate(better, base, rule).pass, true);
  assert.equal(loop.efficiencyGate(worse, base, rule).pass, false);
});

test("nondominated selection drops a dominated candidate", () => {
  const { loop } = makeLoop();
  const a = evalStub({ configId: "a", aggregateScore: 1.0, cost: 100, tokenTraffic: 1000 });
  const b = evalStub({ configId: "b", aggregateScore: 0.9, cost: 200, tokenTraffic: 2000 }); // worse on every axis
  const c = evalStub({ configId: "c", aggregateScore: 0.9, cost: 50, tokenTraffic: 2000 }); // cheaper, not dominated
  const kept = loop.nondominated([a, b, c]).map((r) => r.configId);
  assert.deepEqual(kept.sort(), ["a", "c"]);
  assert.ok(!kept.includes("b"));
});

test("the search loop evaluates, gates, and retains candidates", async () => {
  const { loop, candidates } = makeLoop();
  const summary = await loop.run();
  assert.equal(summary.proposals, 2);
  assert.ok(summary.baseline.aggregateScore > 0, "baseline solves tasks");

  // L-20: the summary's retained/rejected partition is only meaningful if it
  // agrees with the acceptance gates recomputed from the recorded results.
  // `retained.length + rejected.length === proposals` is true by construction
  // and would hold even if run() filed every candidate under the wrong list.
  const rule = AutoResearchLoop.defaultAcceptance();
  const results = loop.getResults();
  const baseline = results.get(summary.baseline.configId)!;
  const expectedRetained: string[] = [];
  const expectedRejected: string[] = [];
  for (const cand of candidates) {
    const res = results.get(cand.id)!;
    const cap = loop.capabilityGate(res, baseline, rule);
    const eff = loop.efficiencyGate(res, baseline, rule);
    if (cap.pass && eff.pass) expectedRetained.push(cand.id);
    else expectedRejected.push(cand.id);
  }
  assert.deepEqual(
    summary.rejected.slice().sort(),
    expectedRejected.sort(),
    "the rejected list is exactly the candidates the recomputed gates fail",
  );
  assert.deepEqual(
    summary.retained.slice().sort(),
    loop.nondominated(expectedRetained.map((id) => results.get(id)!)).map((r) => r.configId).sort(),
    "the retained list is exactly the gate-passing candidates, minus the dominated",
  );
});

test("a model is built per task, so no conversation state leaks across evaluations", async () => {
  // L-13: the loop owns no model state — it asks the factory for one model per
  // task evaluation. A single shared backend would carry per-conversation state
  // (the scripted model's prefix-cache accounting compares each request against
  // the previous one) across task boundaries, billing every new conversation
  // against the tail of the one before it.
  const { loop, constructions } = makeLoop();
  await loop.run();
  assert.equal(constructions.length, 9, "(1 baseline + 2 candidates) x 3 tasks: one fresh model each");
  assert.equal(new Set(constructions).size, 9, "each is a distinct instance, never a handed-back shared one");
});

test("acceptance metrics are fixed up front and not derived from candidates", () => {
  const rule = AutoResearchLoop.defaultAcceptance();
  assert.equal(rule.capabilityMetric, "aggregateScore");
  assert.equal(rule.tolerance, 0.05);
  assert.deepEqual(rule.efficiencyMetrics, ["tokenTraffic", "cost"]);
});
