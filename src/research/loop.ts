import { TaskSpec } from "../core/environment.js";
import { ModelBackend, ScriptStep } from "../core/model.js";
import { Environment } from "../core/environment.js";
import { Harness, HarnessOptions } from "../core/harness.js";
import { RunResult, TraceEntry } from "../core/types.js";
import { CostRates, DEFAULT_RATES, Usage, addUsage, totalTokens, usageCost, zeroUsage } from "../core/usage.js";

/** Load a per-task script into a scripted backend; a no-op for real backends. */
function loadScript(model: ModelBackend, steps: () => ScriptStep[]): void {
  const m = model as ModelBackend & { load?: (s: ScriptStep[]) => void };
  if (typeof m.load === "function") m.load(steps());
}

/**
 * Read a declared acceptance metric off an eval result. Validates the key
 * rather than casting: a typo in a rule's metric name would otherwise read
 * `undefined`, and `undefined <= 0` is false, so the gate would silently pass.
 */
function gateMetric(result: EvalResult, metric: string): number {
  const value = (result as unknown as Record<string, unknown>)[metric];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`acceptance metric "${metric}" is not a finite number on ${result.configId}`);
  }
  return value;
}


/**
 * The search/development half of the Auto-Research Loop (paper Fig. 2).
 *
 * A candidate mechanism configuration is proposed, implemented, reviewed,
 * and validated on SEARCH environments. Acceptance applies two sequential
 * gates:
 *   1. CAPABILITY gate - every capability metric stays within its
 *      predeclared tolerance (metrics are fixed before search and are never
 *      under the optimizing agent's control),
 *   2. EFFICIENCY gate - the candidate improves at least one declared
 *      efficiency metric.
 * Among candidates that pass both gates, the pipeline retains the
 * nondominated results.
 *
 * The held-out benchmark is reserved for post-freeze evaluation and its
 * results never feed back into search; `heldOutVerdict` applies the same
 * acceptance gates there so a regression rejects the candidate.
 */

export interface EvalResult {
  configId: string;
  config: CandidateConfig;
  perTask: RunResult[];
  aggregateScore: number;
  usage: Usage;
  tokenTraffic: number;
  cost: number;
  tokenEfficiency: number; // cost per unit score
  solved: number;
  total: number;
  traces: TraceEntry[][];
}

export interface CandidateConfig {
  id: string;
  mechanisms: string[];
  params: Record<string, unknown>;
  family: ProposalFamily;
  origin: string;
}

export type ProposalFamily =
  | "context"
  | "progress"
  | "tools"
  | "delegation"
  | "prompt-and-policy"
  | "improvement-and-evaluation";

export interface AcceptanceRule {
  capabilityMetric: string;
  tolerance: number; // relative drop allowed vs. the baseline
  efficiencyMetrics: string[];
  minEfficiencyGain: number; // relative improvement required on >= 1 metric
}

export interface GateOutcome {
  passed: boolean;
  capabilityPassed: boolean;
  efficiencyPassed: boolean;
  reasons: string[];
  dominatedBy?: string[];
}

export interface SearchSummary {
  proposals: number;
  implemented: number;
  retained: string[];
  rejected: string[];
  baseline: EvalResult;
  best: EvalResult;
  generations: GenerationLog[];
}

export interface GenerationLog {
  round: number;
  proposed: string[];
  retained: string[];
  note: string;
}

export interface SearchOptions {
  model: ModelBackend;
  tasks: TaskSpec[];
  baselineConfig: CandidateConfig;
  candidates: CandidateConfig[];
  acceptance: AcceptanceRule;
  rates?: CostRates;
  maxTurns?: number;
  scriptFor: (task: TaskSpec, config: CandidateConfig, model: ModelBackend) => ScriptStep[];
  buildHarness: (config: CandidateConfig, opts: HarnessOptions) => Harness;
  log?: (msg: string) => void;
}

export class AutoResearchLoop {
  private opts: SearchOptions;
  private results = new Map<string, EvalResult>();
  private generations: GenerationLog[] = [];

  constructor(opts: SearchOptions) {
    this.opts = opts;
  }

  /** Capability metrics, tolerances, and efficiency metrics are fixed up front. */
  static defaultAcceptance(): AcceptanceRule {
    return {
      capabilityMetric: "aggregateScore",
      tolerance: 0.05,
      efficiencyMetrics: ["tokenTraffic", "cost"],
      minEfficiencyGain: 0.05,
    };
  }

  async evaluate(config: CandidateConfig): Promise<EvalResult> {
    const perTask: RunResult[] = [];
    const traces: TraceEntry[][] = [];
    let usage = zeroUsage();

    for (const task of this.opts.tasks) {
      const env = new Environment(task);
      loadScript(this.opts.model, () => this.opts.scriptFor(task, config, this.opts.model));
      const harness = this.opts.buildHarness(config, {
        id: config.id,
        model: this.opts.model,
        env,
        maxTurns: this.opts.maxTurns ?? 24,
        rates: this.opts.rates ?? DEFAULT_RATES,
      });
      const res = await harness.run();
      perTask.push(res);
      traces.push(res.trace);
      usage = addUsage(usage, res.usage);
    }

    const rates = this.opts.rates ?? DEFAULT_RATES;
    const total = perTask.length;
    const solved = perTask.filter((r) => r.success).length;
    const aggregateScore = total === 0 ? 0 : perTask.reduce((s, r) => s + r.score, 0) / total;
    const cost = usageCost(usage, rates);
    const traffic = totalTokens(usage);
    return {
      configId: config.id,
      config,
      perTask,
      aggregateScore,
      usage,
      tokenTraffic: traffic,
      cost,
      tokenEfficiency: aggregateScore > 0 ? cost / aggregateScore : Infinity,
      solved,
      total,
      traces,
    };
  }

  /** Gate 1: capability within the predeclared tolerance of the baseline. */
  capabilityGate(cand: EvalResult, baseline: EvalResult, rule: AcceptanceRule): { pass: boolean; reason: string } {
    const b = gateMetric(baseline, rule.capabilityMetric);
    const c = gateMetric(cand, rule.capabilityMetric);
    // A degenerate baseline makes the tolerance meaningless: every candidate
    // would pass, including one that solves nothing. That is precisely the
    // optimiser-gaming hole the fixed-tolerance design exists to close, so a
    // zero baseline aborts the gate instead of rubber-stamping candidates.
    if (b <= 0) return { pass: false, reason: `baseline ${rule.capabilityMetric} is 0; capability gate undefined` };
    const rel = (b - c) / b;
    if (rel > rule.tolerance) {
      return { pass: false, reason: `${rule.capabilityMetric} ${c.toFixed(3)} is ${(rel * 100).toFixed(1)}% below baseline ${b.toFixed(3)} (tolerance ${(rule.tolerance * 100).toFixed(0)}%)` };
    }
    return { pass: true, reason: `${rule.capabilityMetric} within tolerance` };
  }

  /** Gate 2: improves at least one declared efficiency metric by the required gain. */
  efficiencyGate(cand: EvalResult, baseline: EvalResult, rule: AcceptanceRule): { pass: boolean; reason: string } {
    const improved: string[] = [];
    for (const m of rule.efficiencyMetrics) {
      const b = gateMetric(baseline, m);
      const c = gateMetric(cand, m);
      if (b <= 0) continue;
      const gain = (b - c) / b;
      if (gain >= rule.minEfficiencyGain) improved.push(`${m} -${(gain * 100).toFixed(1)}%`);
    }
    if (improved.length === 0) {
      return { pass: false, reason: `no efficiency metric improved by >= ${(rule.minEfficiencyGain * 100).toFixed(0)}%` };
    }
    return { pass: true, reason: improved.join(", ") };
  }

  /** Retain the nondominated set among candidates that pass both gates. */
  nondominated(passed: EvalResult[]): EvalResult[] {
    const kept: EvalResult[] = [];
    for (const c of passed) {
      let dominated = false;
      for (const k of passed) {
        if (k.configId === c.configId) continue;
        // k dominates c if it is no worse on every objective and strictly better on one
        const noWorse = k.aggregateScore >= c.aggregateScore - 1e-9 && k.cost <= c.cost + 1e-9 && k.tokenTraffic <= c.tokenTraffic + 1e-9;
        const strictlyBetter = k.aggregateScore > c.aggregateScore + 1e-9 || k.cost < c.cost - 1e-9 || k.tokenTraffic < c.tokenTraffic - 1e-9;
        if (noWorse && strictlyBetter) {
          dominated = true;
          break;
        }
      }
      if (!dominated) kept.push(c);
    }
    return kept;
  }

  async run(): Promise<SearchSummary> {
    const log = this.opts.log ?? (() => undefined);
    // Fresh search log: a reused loop instance must not accumulate rounds from
    // a previous run, the same reset semantics the harness applies per run().
    this.generations = [];
    log(`[search] baseline = ${this.opts.baselineConfig.id}`);
    const baseline = await this.evaluate(this.opts.baselineConfig);
    this.results.set(baseline.configId, baseline);
    log(`[search] baseline score=${baseline.aggregateScore.toFixed(3)} traffic=${(baseline.tokenTraffic / 1e6).toFixed(4)}M cost=$${baseline.cost.toFixed(2)}`);

    const rule = this.opts.acceptance;
    const passed: EvalResult[] = [];
    const rejected: string[] = [];

    let round = 0;
    for (const cand of this.opts.candidates) {
      round++;
      const res = await this.evaluate(cand);
      this.results.set(cand.id, res);

      const cap = this.capabilityGate(res, baseline, rule);
      const eff = this.efficiencyGate(res, baseline, rule);
      const outcome: GateOutcome = {
        passed: cap.pass && eff.pass,
        capabilityPassed: cap.pass,
        efficiencyPassed: eff.pass,
        reasons: [cap.reason, eff.reason],
      };

      const tag = outcome.passed ? "RETAIN" : "REJECT";
      log(
        `[gate] ${cand.id.padEnd(22)} score=${res.aggregateScore.toFixed(3)} traffic=${(res.tokenTraffic / 1e6).toFixed(4)}M cost=$${res.cost.toFixed(2)} -> ${tag} | ${outcome.reasons.join(" | ")}`,
      );

      if (outcome.passed) passed.push(res);
      else rejected.push(cand.id);

      this.generations.push({
        round,
        proposed: [cand.id],
        retained: outcome.passed ? [cand.id] : [],
        note: outcome.reasons.join("; "),
      });
    }

    const retained = this.nondominated(passed);
    const best = retained.reduce<EvalResult | undefined>(
      (b, r) => (b === undefined || r.tokenEfficiency < b.tokenEfficiency ? r : b),
      undefined,
    ) ?? baseline;

    log(`[search] retained ${retained.length}/${this.opts.candidates.length} candidates; best=${best.configId}`);
    return {
      proposals: this.opts.candidates.length,
      implemented: this.opts.candidates.length,
      retained: retained.map((r) => r.configId),
      rejected,
      baseline,
      best,
      generations: this.generations,
    };
  }

  getResults(): ReadonlyMap<string, EvalResult> {
    return this.results;
  }
}

/**
 * Held-out evaluation. Runs only AFTER the candidate is frozen; results never
 * feed back into the search. A failed validation rejects the candidate
 * outright.
 */
export async function heldOutEvaluation(
  config: CandidateConfig,
  tasks: TaskSpec[],
  buildHarness: (config: CandidateConfig, opts: HarnessOptions) => Harness,
  model: ModelBackend,
  rates: CostRates = DEFAULT_RATES,
  maxTurns = 24,
  scriptFor: (task: TaskSpec, config: CandidateConfig, model: ModelBackend) => ScriptStep[],
): Promise<EvalResult> {
  const perTask: RunResult[] = [];
  const traces: TraceEntry[][] = [];
  let usage = zeroUsage();

  for (const task of tasks) {
    const env = new Environment(task);
    loadScript(model, () => scriptFor(task, config, model));
    const harness = buildHarness(config, { id: config.id, model, env, maxTurns, rates });
    const res = await harness.run();
    perTask.push(res);
    traces.push(res.trace);
    usage = addUsage(usage, res.usage);
  }

  const total = perTask.length;
  const solved = perTask.filter((r) => r.success).length;
  const aggregateScore = total === 0 ? 0 : perTask.reduce((s, r) => s + r.score, 0) / total;
  const cost = usageCost(usage, rates);
  return {
    configId: config.id,
    config,
    perTask,
    aggregateScore,
    usage,
    tokenTraffic: totalTokens(usage),
    cost,
    tokenEfficiency: aggregateScore > 0 ? cost / aggregateScore : Infinity,
    solved,
    total,
    traces,
  };
}

/**
 * Apply the acceptance gates to a held-out result. The README promises that a
 * failed validation rejects the candidate outright; this is where that
 * promise is enforced, after the freeze.
 */
export function heldOutVerdict(
  heldOut: EvalResult,
  baseline: EvalResult,
  acceptance: AcceptanceRule,
): { pass: boolean; reasons: string[] } {
  const capability = heldOutVerdictCapability(heldOut, baseline, acceptance);
  if (!capability.pass) return { pass: false, reasons: [capability.reason] };
  const efficiency = heldOutVerdictEfficiency(heldOut, baseline, acceptance);
  if (!efficiency.pass) return { pass: false, reasons: [efficiency.reason] };
  return { pass: true, reasons: [capability.reason, efficiency.reason] };
}

function heldOutVerdictCapability(heldOut: EvalResult, baseline: EvalResult, rule: AcceptanceRule) {
  const b = gateMetric(baseline, rule.capabilityMetric);
  const c = gateMetric(heldOut, rule.capabilityMetric);
  if (b <= 0) return { pass: false, reason: `baseline ${rule.capabilityMetric} is 0; validation undefined` };
  const rel = (b - c) / b;
  return rel > rule.tolerance
    ? { pass: false, reason: `${rule.capabilityMetric} ${(rel * 100).toFixed(1)}% below baseline on held-out tasks` }
    : { pass: true, reason: `${rule.capabilityMetric} within tolerance` };
}

function heldOutVerdictEfficiency(heldOut: EvalResult, baseline: EvalResult, rule: AcceptanceRule) {
  const improved: string[] = [];
  for (const m of rule.efficiencyMetrics) {
    const b = gateMetric(baseline, m);
    const c = gateMetric(heldOut, m);
    if (b <= 0) continue;
    if ((b - c) / b >= rule.minEfficiencyGain) improved.push(`${m} -${(((b - c) / b) * 100).toFixed(1)}%`);
  }
  return improved.length === 0
    ? { pass: false, reason: `no efficiency metric held its gain on held-out tasks (>= ${(rule.minEfficiencyGain * 100).toFixed(0)}%)` }
    : { pass: true, reason: improved.join(", ") };
}

export { };
