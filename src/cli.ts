import { Environment, TaskSpec } from "./core/environment.js";
import { Harness, HarnessOptions } from "./core/harness.js";
import { ScriptedModel, ScriptStep } from "./core/model.js";
import { ToolCall } from "./core/types.js";
import { DEFAULT_RATES } from "./core/usage.js";
import { SolPiConfig, buildMechanisms } from "./mechanisms/stack.js";
import { AutoResearchLoop, CandidateConfig, heldOutEvaluation, ProposalFamily } from "./research/loop.js";
import { HELD_OUT_ENVIRONMENTS, LONG_HORIZON_TASK, SEARCH_ENVIRONMENTS } from "./tasks/corpus.js";

/**
 * The demo drives the whole pipeline end to end:
 *   1. run the base (Pi) harness on the search environments,
 *   2. run the Auto-Research Loop over candidate mechanism configurations,
 *   3. gate each candidate on capability + efficiency,
 *   4. freeze the retained stack and evaluate on the held-out benchmark.
 */

const FIXTURES: Record<string, { write: string; path: string }> = {
  "repo-001": { path: "math_utils.py", write: "def add(a, b):\n    return a + b\n\n\ndef multiply(a, b):\n    return a * b\n" },
  "repo-002": { path: "format.ts", write: "export function formatStatus(s: string): string {\n  return s.toUpperCase();\n}\n" },
  "repo-003": { path: "main.go", write: "func main() {\n  if !run() { exitCode = 1 }\n}\n\nvar exitCode = 0\n\nfunc run() bool { return false }\n" },
  "verifier-001": { path: "pipeline.py", write: "def normalize(xs):\n    lo, hi = min(xs), max(xs)\n    return [(x - lo) / (hi - lo) for x in xs]\n" },
  "verifier-002": { path: "client.rs", write: "fn fetch() -> bool {\n    for attempt in 0..3 {\n        if try_fetch() { return true }\n    }\n    false\n}\n\nfn try_fetch() -> bool { false }\n" },
  "long-horizon-001": { path: "server.py", write: "def health():\n    return 'ok'\n" },
  "heldout-001": { path: "Validator.java", write: "class Validator { boolean valid(String e) { return e.matches(\"^[a-z0-9+\\\\.]+@[a-z]+\\\\.[a-z]+$\"); } }\n" },
  "heldout-002": { path: "buffer.cpp", write: "char buf[1024];\n" },
};

function planFor(taskId: string): { steps: Array<{ id: number; title: string; status: string }> } {
  void taskId;
  return {
    steps: [
      { id: 1, title: "Read files", status: "done" },
      { id: 2, title: "Edit code", status: "done" },
      { id: 3, title: "Run tests", status: "pending" },
      { id: 4, title: "Verify", status: "pending" },
    ],
  };
}

function planSteps(statuses: Array<"pending" | "in_progress" | "done">) {
  return [
    { id: 1, title: "Read files", status: statuses[0] },
    { id: 2, title: "Edit code", status: statuses[1] },
    { id: 3, title: "Run tests", status: statuses[2] },
    { id: 4, title: "Verify", status: statuses[3] },
  ];
}

function scriptFor(task: TaskSpec, config: CandidateConfig): ScriptStep[] {
  const fix = FIXTURES[task.id];
  const steps: ScriptStep[] = [
    { kind: "tool", calls: [{ tool: "read_file", args: { path: fix.path } }] },
    // plan boundary: reading complete -> OnlineContextCompact evaluates the gate
    {
      kind: "tool",
      calls: [{ tool: "update_plan", args: { steps: planSteps(["done", "in_progress", "pending", "pending"]) } }],
    },
  ];
  const writeCall: ToolCall = { tool: "write_file", args: { path: fix.path, content: fix.write } };
  const runCall: ToolCall = { tool: "run", args: { command: "test" } };
  const supportsFusion = config.mechanisms.includes("ActionFusion");
  steps.push({ kind: "tool", calls: supportsFusion ? [writeCall, runCall] : [writeCall] });
  if (!supportsFusion) steps.push({ kind: "tool", calls: [runCall] });
  // plan boundary: editing complete
  steps.push({
    kind: "tool",
    calls: [{ tool: "update_plan", args: { steps: planSteps(["done", "done", "in_progress", "pending"]) } }],
  });
  steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] });
  steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "build" } }] });
  steps.push({
    kind: "tool",
    calls: [{ tool: "update_plan", args: { steps: planSteps(["done", "done", "done", "done"]) } }],
  });

  // The long-horizon task keeps cycling: each cycle re-emits a large log, so
  // archived observations recur in later requests and the compaction gate is
  // re-evaluated at further plan boundaries.
  if (task.id === "long-horizon-001") {
    for (let i = 0; i < 6; i++) {
      steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "build" } }] });
      steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] });
    }
  }
  steps.push({ kind: "done", summary: "All tests pass." });
  return steps;
}

function buildHarness(config: CandidateConfig, opts: HarnessOptions): Harness {
  const solConfig: SolPiConfig = {
    mechanisms: config.mechanisms as SolPiConfig["mechanisms"],
    ...config.params,
  };
  return new Harness({ ...opts, mechanisms: buildMechanisms(solConfig) });
}

function row(columns: string[], widths: number[]): string {
  return columns.map((c, i) => String(c).padEnd(widths[i])).join("  ");
}

interface CandidateDef {
  id: string;
  family: ProposalFamily;
  origin: string;
  mechanisms: string[];
  params?: Record<string, unknown>;
}

const CANDIDATES: CandidateDef[] = [
  { id: "pi-baseline", family: "improvement-and-evaluation", origin: "base harness", mechanisms: [] },
  { id: "+action-fusion", family: "tools", origin: "repeated edit->run round trips", mechanisms: ["ActionFusion"] },
  { id: "+online-compact", family: "progress", origin: "context growth between plan steps", mechanisms: ["OnlineContextCompact"] },
  { id: "+evidence-reducer", family: "delegation", origin: "recurring large build/test logs", mechanisms: ["EvidencePreservingReducer"] },
  { id: "+observation-pack", family: "context", origin: "large results resent in full", mechanisms: ["ObservationPack"] },
  {
    id: "sol-pi[efficiency]",
    family: "improvement-and-evaluation",
    origin: "integrated stack",
    mechanisms: ["ActionFusion", "OnlineContextCompact", "EvidencePreservingReducer", "ObservationPack"],
  },
  {
    id: "sol-pi[performance]",
    family: "context",
    origin: "highest-scoring single mechanism",
    mechanisms: ["ObservationPack"],
    params: { observationPack: { fullForRequests: 3, excerptBytes: 2048 } },
  },
  {
    id: "+online-compact-tight",
    family: "progress",
    origin: "context growth between plan steps",
    mechanisms: ["OnlineContextCompact"],
    params: { onlineCompact: { contextWindow: 60_000, compactTargetFraction: 0.45 } },
  },
];

function toConfig(d: CandidateDef): CandidateConfig {
  return { id: d.id, mechanisms: d.mechanisms, params: d.params ?? {}, family: d.family, origin: d.origin };
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function printTable(results: Map<string, import("./research/loop.js").EvalResult>): void {
  const widths = [24, 10, 14, 12, 10, 12, 14];
  console.log();
  console.log(row(["harness", "score", "traffic(B)", "cost($)", "solved", "tok eff", "vs base cost"], widths));
  console.log("-".repeat(110));
  const base = results.get("pi-baseline");
  for (const [id, r] of results) {
    const vs = base && base.configId !== id ? `${(((base.cost - r.cost) / base.cost) * 100).toFixed(1)}%` : "--";
    console.log(
      row([id, fmt(r.aggregateScore), (r.tokenTraffic / 1e9).toFixed(4), r.cost.toFixed(2), `${r.solved}/${r.total}`, r.tokenEfficiency.toFixed(4), vs], widths),
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const doResearch = args.includes("--research");

  const model = new ScriptedModel({ id: "gpt-5.6-sol", contextWindow: 200_000, outputTokensPerTurn: 60 });
  console.log("SoL-Pi prototype — Auto-Research Loop for harness token efficiency");
  console.log(`model backend: ${model.id}   search environments: ${SEARCH_ENVIRONMENTS.length}   held-out: ${HELD_OUT_ENVIRONMENTS.length}`);

  const loop = new AutoResearchLoop({
    model,
    tasks: SEARCH_ENVIRONMENTS,
    baselineConfig: toConfig(CANDIDATES[0]),
    candidates: CANDIDATES.slice(1).map(toConfig),
    acceptance: AutoResearchLoop.defaultAcceptance(),
    rates: DEFAULT_RATES,
    maxTurns: 24,
    scriptFor: (task, config) => scriptFor(task, config),
    buildHarness,
    log: (msg) => console.log(msg),
  });

  const summary = await loop.run();
  const all = new Map<string, import("./research/loop.js").EvalResult>([...loop.getResults()]);

  printTable(all);

  console.log();
  console.log("acceptance rule (fixed before search, never under the optimizer's control):");
  console.log("  capability gate : aggregateScore must stay within 5% of the baseline");
  console.log("  efficiency gate : tokenTraffic or cost must improve by >= 5%");
  console.log(`retained        : ${summary.retained.join(", ") || "(none)"}`);
  console.log(`rejected        : ${summary.rejected.join(", ") || "(none)"}`);

  if (doResearch) {
    console.log();
    console.log("=== FREEZE + HELD-OUT EVALUATION (results do not feed back into search) ===");
    const frozen = toConfig(CANDIDATES.find((c) => c.id === "sol-pi[efficiency]")!);
    const heldOut = await heldOutEvaluation(
      frozen,
      HELD_OUT_ENVIRONMENTS,
      buildHarness,
      model,
      DEFAULT_RATES,
      24,
      (task, config) => scriptFor(task, config),
    );
    console.log(
      `held-out ${frozen.id}: score=${fmt(heldOut.aggregateScore)} solved=${heldOut.solved}/${heldOut.total} cost=$${heldOut.cost.toFixed(2)} traffic=${(heldOut.tokenTraffic / 1e9).toFixed(4)}B`,
    );
    const baseHeld = await heldOutEvaluation(
      toConfig(CANDIDATES[0]),
      HELD_OUT_ENVIRONMENTS,
      buildHarness,
      model,
      DEFAULT_RATES,
      24,
      (task, config) => scriptFor(task, config),
    );
    console.log(
      `held-out ${baseHeld.configId}: score=${fmt(baseHeld.aggregateScore)} solved=${baseHeld.solved}/${baseHeld.total} cost=$${baseHeld.cost.toFixed(2)} traffic=${(baseHeld.tokenTraffic / 1e9).toFixed(4)}B`,
    );
    const saved = ((baseHeld.cost - heldOut.cost) / baseHeld.cost) * 100;
    console.log(`cost saved on held-out: ${saved.toFixed(1)}%`);
  }

  console.log();
  console.log("=== single-task mechanism activation on the long-horizon task (paper Fig. 6 style) ===");
  for (const mech of ["ActionFusion", "ObservationPack", "EvidencePreservingReducer", "OnlineContextCompact"] as const) {
    const cfg: CandidateConfig = { id: mech, mechanisms: [mech], params: {}, family: "tools", origin: "add-one" };
    const task = LONG_HORIZON_TASK;
    const env = new Environment(task);
    loadScript(model, () => scriptFor(task, cfg));
    const h = buildHarness(cfg, { id: mech, model, env, maxTurns: 40 });
    const res = await h.run();
    const stats = (h.mechanisms[0] as unknown as { stats?: Record<string, number> }).stats;
    console.log(
      `${mech.padEnd(26)} turns=${res.turns} tokens=${(res.usage.input + res.usage.output).toLocaleString()} cost=$${res.cost.toFixed(3)} stats=${JSON.stringify(stats ?? {})}`,
    );
  }
}

function loadScript(model: ScriptedModel, steps: () => ScriptStep[]): void {
  model.load(steps());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
