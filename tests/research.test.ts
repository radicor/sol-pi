import assert from "node:assert/strict";
import { test } from "node:test";
import { AutoResearchLoop, CandidateConfig, ProposalFamily } from "../src/research/loop.js";
import { ScriptedModel, ScriptStep } from "../src/core/model.js";
import { Harness, HarnessOptions } from "../src/core/harness.js";
import { Environment } from "../src/core/environment.js";
import { buildMechanisms } from "../src/mechanisms/stack.js";
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
    mechanisms: buildMechanisms({ mechanisms: config.mechanisms as never[], ...config.params }),
  });
}

function makeLoop() {
  const model = new ScriptedModel({ id: "test", contextWindow: 200_000 });
  const baseline: CandidateConfig = { id: "pi", mechanisms: [], params: {}, family: "improvement-and-evaluation", origin: "base" };
  const cheap: CandidateConfig = { id: "cheap", mechanisms: ["EvidencePreservingReducer", "ObservationPack"], params: {}, family: "context", origin: "test" };
  const wasteful: CandidateConfig = { id: "wasteful", mechanisms: [], params: {}, family: "tools", origin: "test" };
  return {
    model,
    baseline,
    loop: new AutoResearchLoop({
      model,
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
  const { loop, baseline } = makeLoop();
  const base = { ...baseline, aggregateScore: 0.9 } as never;
  const bad = { ...baseline, aggregateScore: 0.5 } as never;
  const out = loop.capabilityGate(bad, base, AutoResearchLoop.defaultAcceptance());
  assert.equal(out.pass, false);
  assert.ok(out.reason.includes("below baseline"));
});

test("capability gate accepts a candidate within tolerance", () => {
  const { loop, baseline } = makeLoop();
  const base = { ...baseline, aggregateScore: 0.9 } as never;
  const ok = { ...baseline, aggregateScore: 0.87 } as never;
  assert.equal(loop.capabilityGate(ok, base, AutoResearchLoop.defaultAcceptance()).pass, true);
});

test("efficiency gate requires a declared metric to improve", () => {
  const { loop, baseline } = makeLoop();
  const rule = AutoResearchLoop.defaultAcceptance();
  const base = { ...baseline, tokenTraffic: 1000, cost: 10 } as never;
  const better = { ...baseline, tokenTraffic: 500, cost: 10 } as never;
  const worse = { ...baseline, tokenTraffic: 990, cost: 10 } as never;
  assert.equal(loop.efficiencyGate(better, base, rule).pass, true);
  assert.equal(loop.efficiencyGate(worse, base, rule).pass, false);
});

test("nondominated selection drops a dominated candidate", () => {
  const { loop, baseline } = makeLoop();
  const mk = (id: string, score: number, cost: number, traffic: number) =>
    ({ ...baseline, configId: id, aggregateScore: score, cost, tokenTraffic: traffic } as never);
  const a = mk("a", 1.0, 100, 1000);
  const b = mk("b", 0.9, 200, 2000); // worse on every axis -> dominated by a
  const c = mk("c", 0.9, 50, 2000); // cheaper than a, lower score -> not dominated
  const kept = loop.nondominated([a, b, c]).map((r) => (r as { configId: string }).configId);
  assert.deepEqual(kept.sort(), ["a", "c"]);
  assert.ok(!kept.includes("b"));
});

test("the search loop evaluates, gates, and retains candidates", async () => {
  const { loop } = makeLoop();
  const summary = await loop.run();
  assert.equal(summary.proposals, 2);
  assert.ok(summary.baseline.aggregateScore > 0, "baseline solves tasks");
  assert.ok(summary.retained.length + summary.rejected.length === 2);
});

test("acceptance metrics are fixed up front and not derived from candidates", () => {
  const rule = AutoResearchLoop.defaultAcceptance();
  assert.equal(rule.capabilityMetric, "aggregateScore");
  assert.equal(rule.tolerance, 0.05);
  assert.deepEqual(rule.efficiencyMetrics, ["tokenTraffic", "cost"]);
});
