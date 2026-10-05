# SoL-Pi — Audit, Round 3

**Date:** 2026-10-05
**Scope:** Follow-up to `AUDIT-2.md` / `REMEDIATION-2.md`. This round was triggered by a set of
external improvement proposals rather than a routine re-audit. One of those proposals, on
inspection, turned out to describe a **correctness defect in the cost model that both prior audit
rounds missed**, so it is reported here as a finding rather than tracked as an enhancement.

The round 2 publish bar is met and nothing below contradicts it. Everything in this document is
**new**: no round-1 or round-2 finding has regressed.

## How this audit was done

Every finding below was reproduced against the running system, not read off the source. The
magnitude of the headline finding was measured with a probe that wrapped the model backend,
recorded the actual per-request message lists, and computed the longest common prefix between
consecutive requests — the quantity a prefix-cache ledger would bill. The probe scripts are
included in each finding's evidence so the numbers are re-derivable.

---

# Part 1 — Findings

## C-1 — The cost ledger never records the quantity the compaction gate optimizes

**Severity: High (for a research artifact making a cost claim)**

**Location:** `src/core/model.ts:121-123`, `src/mechanisms/online-compact.ts:112-150`

**Issue.** `ScriptedModel.usage()` returns `cacheRead: 0, cacheWrite: 0` on every request:

```ts
private usage(input: number, output: number): Usage {
  return { input, cacheRead: 0, cacheWrite: 0, output };
}
```

`UsageMeter` carries both fields, `DEFAULT_RATES` prices both (`cacheReadPerMTok: 0.4`,
`cacheWritePerMTok: 8.0`), and `usageCost` charges them — so the entire accounting pipeline is
wired for cache billing and simply always receives zero. Meanwhile `costGatePasses` decides whether
to compact by weighing a rewrite cost against read savings using `cacheWriteReadRatio` (default
`8 / 0.4 = 20`):

```ts
const readPrice = 1.0;
const writePrice = this.options.cacheWriteReadRatio;
const savings = removed * readPrice * remainingRequests;
const rewriteCost = target * writePrice;
```

The gate therefore optimizes a number the ledger never records. The published cost figures in the
README and `research-results.json` are computed from an all-input ledger, so **no published saving
anywhere in this project reflects cache economics** — and the mechanism whose entire purpose is to
trade a rewrite for read savings cannot have its own benefit observed in the project's own output.

This is the same defect class as H-3 and M-15: a claim the program's output does not back. Both
prior rounds missed it because the fields were present and priced, so a casual read suggests the
accounting is real. It is structurally present and numerically inert.

**Impact.** Every cost figure published by the project is billed at a flat input rate as though no
caching existed. Under the provider model the paper actually assumes, the true ranking of
mechanisms is materially different — see C-2, which is the measured consequence.

**Evidence.** Probe `probe-lcp.ts` wrapped the model, recorded real per-request message lists on
the long-horizon task, and computed the true longest-common-prefix in tokens between consecutive
requests:

```
baseline               reqs=20 total=4,080,995 lcp=3,627,754 (88.9%) delta=453,241
+observation-pack      reqs=20 total=516,027   lcp=55,682    (10.8%) delta=460,345
+online-compact        reqs=20 total=2,535,856 lcp=2,082,108 (82.1%) delta=453,748
+evidence-reducer      reqs=20 total=50,147    lcp=44,778    (89.3%) delta=5,369
```

88.9% of baseline input tokens are a verbatim prefix of the previous request — i.e. cacheable. The
ledger charges all of them at full input price.

**Recommended fix.** Record real cache usage in the model: compute the longest common prefix (by
message content) between the current request and the previous one, bill that prefix at
`cacheReadPerMTok`, bill the appended delta once at `cacheWritePerMTok`, and bill any remaining
non-prefix content at `inputPerMTok`. `UsageMeter` and `usageCost` already work unchanged. This
changes published numbers, so it must go through the round-2 freeze discipline: re-run, re-diff,
regenerate artifacts.

## C-2 — ObservationPack's headline saving is inflated by the missing cache ledger

**Severity: High**

**Location:** consequence of C-1; mechanism at `src/mechanisms/observation-pack.ts:127-149`

**Issue.** This is the measured consequence of C-1, and it is larger than C-1 alone suggests.

ObservationPack archives a large result and later **substitutes the message content in place**:
`transformContext` rewrites the tool message from the full original to a handle plus excerpt. That
rewrite invalidates the cache prefix for every subsequent request, because the bytes the provider
cached are no longer the bytes being sent. The all-input ledger cannot see this at all — it only
sees that the context got shorter, and bills the saving as pure profit.

The probe's LCP column is the honest picture: ObservationPack drops to **10.8% cacheable prefix**,
by far the lowest of the four mechanisms, because substitution churns content the provider had
already cached. Charging that churn at the write price the paper assumes, the headline saving
collapses:

| mechanism | saving, billed today | saving, cache-honest | delta |
|---|---|---|---|
| `+observation-pack` | 87.4% | **27.0%** | −60.3pp |
| `+online-compact` | 37.9% | 12.1% | −25.8pp |
| `+evidence-reducer` | 98.8% | **98.8%** | 0.0pp |

**Impact.** Two claims in the artifacts are affected. First, the −85.6% long-horizon pill and the
79.5% search-table row both overstate ObservationPack. Second — and this matters more — the
*ranking* changes: ObservationPack currently appears to save dramatically more than it does once
rewrite cost is charged, while the Evidence-Preserving Reducer is unaffected (0.0pp) because it
reduces content **before it ever enters the context** (`transformResult` runs before the
observation is appended, so the receipt *is* the original and the prefix is preserved). The
reducer's dominance is therefore more real than the current figures imply, and ObservationPack's is
less.

This does not make ObservationPack bad — it is still a large net saving. It makes the published
comparison misleading about *why*, and a reader comparing mechanisms would draw the wrong
conclusion about where the value lies.

**Evidence.** Same probe as C-1. The 0.0pp delta for the reducer is explained by hook timing:
`evidence-reducer.ts:172` (`transformResult`, pre-context) versus `observation-pack.ts:127`
(`transformContext`, post-context).

**Recommended fix.** Fixed by C-1's fix — once the ledger records cache traffic, ObservationPack's
rewrite cost appears automatically and the published figures become honest. No separate code change
is needed; the artifacts must be regenerated from the new JSON.

## C-3 — `TraceEntry.compacted` is a dead field

**Severity: Low**

**Location:** `src/core/harness.ts:236`, `src/core/harness.ts:257`

**Issue.** Both trace sites write `compacted: false` as a constant. Nothing ever sets it true. A
reader of a trace entry has no way to tell which turns were compacted or substituted, so the
difference between "the mechanism saved tokens" and "the mechanism fired" is unobservable from
program output.

**Impact.** Low, but it is the same class of problem the audits keep finding: a field that implies
it reports something and reports nothing. A regression in a mechanism could silently reduce
savings while the trace continued to look healthy.

**Recommended fix.** In `Harness.run`, after `transformContext`, compare the message list to the
incoming one; if it changed, set the entry's `compacted` true and record before/after token counts.
Pure observability, no loop behaviour change.

## C-4 — No automated check that published numbers match program output

**Severity: Medium (process)**

**Location:** repo-wide; `README.md`, `research-results.json`, `sol-pi-explainer.html`

**Issue.** The README asserts "every number below is regenerated by the program itself." That
promise is currently enforced by *discipline*: a human must rerun and compare. Two audit rounds
have now found published numbers contradicting program output — H-3/M-15 in round 1, N-2 in round 2.
Each time, the divergence was silent.

**Impact.** The next regression is a matter of when, not if. C-1 and C-2 will regenerate every
published number, which is exactly the operation that has drifted twice already.

**Recommended fix.** A `--check` mode that re-runs and diffs against the committed
`research-results.json`, plus a CI workflow running typecheck, tests, and the check. This converts
the README's promise from a claim into an invariant the CI enforces. Highest robustness-per-line
available, and it institutionalizes the lesson of both audits.

---

# Part 2 — Triage of the remaining proposals

The external proposals not turned into findings above:

- **Reducer receipt cache** (`sourceHash` memoization) — legitimate optimization, safe because the
  receipt is a pure function of the hash. Worth doing; small.
- **Reducer recall tool** — rejected as scope creep. "Evidence-preserving" means the receipt
  preserves verified evidence, not that the agent can page the original. Adding a second recall
  tool doubles the tool surface for a benefit the paper does not claim.
- **Pluggable token estimator** — reasonable seam but low value here. The README already discloses
  the word-based estimator honestly; a pluggable hook nobody uses is still a hook to maintain.
- **`--only` / `--json` CLI ergonomics** — genuine iteration convenience. Bundle with C-4's work
  since both touch the CLI argument path.

---

# Release recommendation

### 🟠 One more pass before external publication

Round 2's bar is met — no published claim is contradicted by program output *under the project's
own cost model*. But that cost model is itself unsound for a paper whose central claim is cache
economics. C-1 and C-2 are the last substantive honesty gap: they are the reason the published
savings cannot be compared to the paper's without a footnote.

The good news is structural: fixing C-1 fixes C-2 automatically, the accounting pipeline is already
built (`UsageMeter`, `DEFAULT_RATES`, `usageCost` all work), and C-4 ensures the resulting
regeneration is the last one a human has to remember to do.

**Bar for the next round:** fix C-1, regenerate every published number from the new ledger, and
land C-4 so the freeze is enforced rather than trusted.

---

## Re-audit status (2026-10-05, after `REMEDIATION-3.md`)

All four findings are closed. The corrections were measured, not assumed.

### C-1: the ledger now records cache traffic

`ScriptedModel` tracks the previous request's messages and splits each request into a cache-read
prefix, a cache-write tail, and a fresh portion for anything a mechanism rewrote mid-context.
`usage()` no longer zeroes the two cache fields, and it subtracts them out of `input` so the four
fields sum to the request without double counting. Two regression tests guard it: a long-horizon
run must record non-zero read *and* write traffic with the prefix dominating, and a verbatim repeat
request must bill at the read price only (`input` = 0). Both were verified non-vacuous by zeroing
the cache fields again and watching them fail.

The hook-timing prediction in C-2 held exactly:

| mechanism | LCP, cache-honest | cost saving, billed today | cost saving, cache-honest | delta |
|---|---|---|---|---|
| `+observation-pack` | **10.8%** | 79.5% | **52.2%** | −27.3pp |
| `+online-compact` | 82.1% | 33.7% | **12.3%** | −21.4pp |
| `+evidence-reducer` | 89.3% | 96.9% | **96.8%** | −0.1pp |

The earlier table above reported the saving collapse as 87.4%→27.0% and 37.9%→12.1%; those were
hand-derived from the LCP ratios. The ledger's own figures are the authoritative ones now, and they
are less dramatic but the same shape: both substituting mechanisms shrink, the reducer holds. The
ranking the audit predicted is confirmed — the reducer carries the saving, and ObservationPack's
contribution is materially smaller than the old figures implied.

One thing the audit did not predict: the probe measures `+online-compact` at **82.1% cacheable
prefix**, yet its saving still falls 21.4pp. Compaction shortens the context but rewrites it, so
each rewrite pays the full input price for the invalidated suffix. The saving is real (cost $8.10 →
$7.11, traffic 4.70M → 3.10M) — it is just mostly eaten by the rewrite it causes. That is the
cost the gate was already reasoning about in `costGatePasses`, which the old ledger made
invisible.

### C-3: the trace now shows which turns rewrote the context

`compacted` is set when a mechanism's `transformContext` actually returns a different message list,
with before/after token counts in `note`; a run with no context mechanism marks zero turns.
Measured on the long-horizon task: baseline 0 rewrites, OnlineContextCompact 4, ObservationPack 12.
ObservationPack rewriting nearly every turn after archiving begins is the C-2 effect made visible
in the trace.

The same edit fixed a latent instance of the C-1 bug class: `TraceEntry.requestTokens` used
`input + output`, which under the new ledger excludes the cached prefix. It now sums input, read,
and write.

### C-4: enforcement is in place and passing

`npm run check` re-runs the pipeline and compares against the committed JSON, capturing the
committed file *before* the write. It now passes against the regenerated file. CI runs typecheck,
the suite, and the check on Node 22.

### Tests

44 tests, up from 41. The three additions are the C-1 pair and the C-3 trace test; the compaction
test was rewritten because `input + output` inverted under the new ledger — compaction raises the
uncached share while lowering total traffic, which is now what it asserts.
