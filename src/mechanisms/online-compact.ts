import { LoopContext, Mechanism, PlanStep } from "../core/harness.js";
import { Message } from "../core/types.js";
import { estimateTokens } from "../core/tokens.js";

/**
 * Online Context Compact (paper Sec. 2.4).
 *
 * Uses plan-step completion to reconsider *when* to compact the context.
 *
 * At each completion boundary the harness:
 *   1. estimates remaining model requests from the observed requests between
 *      completed steps and the number of unfinished steps,
 *   2. caps that estimate by the requests that would fill the remaining
 *      context window at the observed growth rate,
 *   3. compares projected input savings against the estimated extra cost of
 *      rewriting the prompt cache (the cost gate),
 *   4. invokes native compaction only when the gate passes, or when context
 *      usage approaches the window limit and compaction can shorten it.
 *
 * Later compactions also account for unrecovered rewrite costs and therefore
 * require a larger savings margin.
 */

export interface OnlineCompactOptions {
  contextWindow: number;
  /** Cache write/read price ratio used by the cost gate. */
  cacheWriteReadRatio?: number;
  /** Extra margin required after a previous compaction has not yet paid off. */
  laterCompactionMargin?: number;
  /** Fraction of the context window that counts as "approaching the limit". */
  windowLimitFraction?: number;
  /** Target context length after compaction, as a fraction of the window. */
  compactTargetFraction?: number;
  /** Maximum number of compactions per run. */
  maxCompactions?: number;
  /** Maximum number of recent messages retained verbatim by compaction. */
  maxTailMessages?: number;
}

export class OnlineContextCompact implements Mechanism {
  readonly name = "OnlineContextCompact";
  readonly description =
    "Reconsider context compaction at plan-step boundaries; compact only when projected input savings exceed the cache-rewrite cost.";

  private options: Required<OnlineCompactOptions>;
  private compactions = 0;
  private lastCompactionRequest = -1;
  private lastCompactionRemovedTokens = 0;
  private gateEvaluations = 0;
  private gatePasses = 0;
  private requestsBetweenSteps: number[] = [];
  private stepCompletionsSeen = 0;

  constructor(options: OnlineCompactOptions) {
    this.options = {
      contextWindow: options.contextWindow,
      cacheWriteReadRatio: options.cacheWriteReadRatio ?? 8 / 0.4,
      laterCompactionMargin: options.laterCompactionMargin ?? 1.5,
      windowLimitFraction: options.windowLimitFraction ?? 0.85,
      compactTargetFraction: options.compactTargetFraction ?? 0.5,
      maxCompactions: options.maxCompactions ?? 4,
      maxTailMessages: options.maxTailMessages ?? 4,
    };
  }

  onPlanStepComplete(step: PlanStep, ctx: LoopContext): void {
    if (step.status !== "done") return;
    this.stepCompletionsSeen++;
    const requests = ctx.requestsSoFar - (this.lastStepRequest ?? 0);
    this.requestsBetweenSteps.push(Math.max(1, requests));
    this.lastStepRequest = ctx.requestsSoFar;
    void ctx;
  }

  private lastStepRequest = 0;

  transformContext(messages: Message[], ctx: LoopContext): Message[] {
    if (this.compactions >= this.options.maxCompactions) return messages;
    if (ctx.requestsSoFar === this.lastCompactionRequest) return messages;

    const tokens = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    if (tokens < 1000) return messages;

    // The gate is reconsidered at plan-step boundaries...
    const stepsCompleted = ctx.plan.filter((s) => s.status === "done").length;
    const atBoundary = stepsCompleted > this.stepsCompletedAtLastGate;
    // ...and when context usage approaches the window limit, where the paper
    // invokes native compaction provided it can shorten the context.
    const nearLimit = tokens > this.options.contextWindow * this.options.windowLimitFraction;
    if (!atBoundary && !nearLimit) return messages;
    if (atBoundary) this.stepsCompletedAtLastGate = stepsCompleted;

    this.gateEvaluations++;
    if (!this.costGatePasses(tokens, ctx)) return messages;

    this.lastCompactionRequest = ctx.requestsSoFar;
    return this.compact(messages);
  }

  private stepsCompletedAtLastGate = 0;

  /**
   * The cost gate (paper Sec. 2.4).
   *
   * Compacting shortens the context but rewrites the cached prefix, which is
   * billed at the cache-write rate. The gate compares, in dollars:
   *
   *   savings = (tokens - target) * cacheReadPrice * remainingRequests
   *   cost    =  target            * cacheWritePrice
   *
   * Later compactions require a larger margin to account for rewrite costs
   * that have not yet been recovered. Near the context-window limit the gate
   * is bypassed, provided compaction would actually shorten the context.
   */
  costGatePasses(tokens: number, ctx: LoopContext): boolean {
    const window = this.options.contextWindow;
    const remainingSteps = ctx.plan.filter((s) => s.status !== "done").length;

    const perStep = this.requestsBetweenSteps.length
      ? this.requestsBetweenSteps.reduce((a, b) => a + b, 0) / this.requestsBetweenSteps.length
      : 3;

    const growthPerRequest = tokens / Math.max(1, ctx.requestsSoFar);
    const remainingWindow = Math.max(0, window - tokens);
    const requestsToFill = growthPerRequest > 0 ? remainingWindow / growthPerRequest : Infinity;
    const remainingRequests = Math.min(perStep * Math.max(1, remainingSteps), isFinite(requestsToFill) ? requestsToFill : remainingSteps * perStep);
    if (remainingRequests <= 0) return false;

    const target = Math.min(tokens, window * this.options.compactTargetFraction);
    const removed = tokens - target;
    if (removed <= 0) return false;

    const readPrice = 1.0;
    const writePrice = this.options.cacheWriteReadRatio;
    const savings = removed * readPrice * remainingRequests;
    const rewriteCost = target * writePrice;

    let required = rewriteCost;
    if (this.compactions > 0) {
      // Account for the previous compaction's unrecovered rewrite cost.
      const recovered = removed * readPrice * Math.max(0, ctx.requestsSoFar - this.lastCompactionRequest);
      const previouslyRemoved = this.lastCompactionRemovedTokens;
      const unrecovered = Math.max(0, previouslyRemoved * writePrice - recovered);
      required = rewriteCost * this.options.laterCompactionMargin + unrecovered;
    }

    const nearLimit = tokens > window * this.options.windowLimitFraction;
    const shortens = target < tokens;

    const passes = savings > required || (nearLimit && shortens);
    if (passes) this.gatePasses++;
    return passes;
  }

  /**
   * Native compaction: keep the system + task prompts, summarize the middle,
   * and keep a recent tail sized by a token budget (not a fixed message
   * count, since a single large observation can otherwise exceed the target).
   */
  compact(messages: Message[]): Message[] {
    const target = Math.min(
      messages.reduce((n, m) => n + estimateTokens(m.content), 0),
      this.options.contextWindow * this.options.compactTargetFraction,
    );
    const head = messages.slice(0, 2);
    const headTokens = head.reduce((n, m) => n + estimateTokens(m.content), 0);

    // Grow the tail backwards until the token budget is spent. Observations
    // can be much larger than a whole turn of dialogue, so the budget, not a
    // fixed message count, decides how much is kept verbatim.
    const tail: Message[] = [];
    let tailTokens = 0;
    for (let i = messages.length - 1; i >= 2; i--) {
      const t = estimateTokens(messages[i].content);
      if (headTokens + tailTokens + t > target) break;
      tail.unshift(messages[i]);
      tailTokens += t;
      if (tail.length >= this.options.maxTailMessages) break;
    }

    const middle = messages.slice(2, messages.length - tail.length);
    if (middle.length === 0) return messages;

    const summary = this.summarize(middle);
    const before = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    const compacted: Message[] = [
      ...head,
      { role: "user", content: `[compacted ${middle.length} messages]\n${summary}` },
      ...tail,
    ];
    const after = compacted.reduce((n, m) => n + estimateTokens(m.content), 0);

    this.lastCompactionRemovedTokens = Math.max(0, before - after);
    this.compactions++;
    return compacted;
  }

  private summarize(messages: Message[]): string {
    const lines: string[] = [];
    for (const m of messages) {
      if (m.role === "tool") {
        const snippet = m.content.slice(0, 160).replace(/\n+/g, " ");
        lines.push(`- ${m.name ?? "tool"}: ${snippet}`);
      } else if (m.role === "assistant" && m.content) {
        lines.push(`- assistant: ${m.content.slice(0, 120).replace(/\n+/g, " ")}`);
      }
    }
    return `Compacted history (${messages.length} messages):\n${lines.slice(-12).join("\n")}`;
  }

  get stats() {
    return {
      compactions: this.compactions,
      gateEvaluations: this.gateEvaluations,
      gatePasses: this.gatePasses,
      lastRemovedTokens: this.lastCompactionRemovedTokens,
    };
  }

  reset(): void {
    this.compactions = 0;
    this.lastCompactionRequest = -1;
    this.lastCompactionRemovedTokens = 0;
    this.gateEvaluations = 0;
    this.gatePasses = 0;
    this.requestsBetweenSteps = [];
    this.stepCompletionsSeen = 0;
    this.lastStepRequest = 0;
    this.stepsCompletedAtLastGate = 0;
  }
}
