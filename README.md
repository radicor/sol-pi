# SoL-Pi

A working prototype of **SoL-Pi: Recursively Scaling Auto-Research Loops for Efficient Agent
Harness** (Liu et al., arXiv:2609.20519, NVIDIA / NTU / MIT, 2026).

The paper's claim is that token efficiency for long-horizon agents can be won at the
**harness** layer — the code that mediates between a model and its environment — without any
model training. This repo implements that idea end to end: a runnable agent harness, the four
mechanisms the paper's search retained, and the Auto-Research Loop that discovers and gates
them.

> **Status:** an independent audit is in [`AUDIT.md`](./AUDIT.md) (2026-10-04). It records three
> user-facing claims that the current output contradicts — the Evidence-Preserving Reducer reduces nothing
> (`reduced:0, savedBytes:0`), ObservationPack's on-demand recall has no tool behind it, and the published
> figures have drifted from `npm run research`. Read it before citing any number from this README or from
> the explainer.

```bash
npm install
npm run research     # run the full Auto-Research Loop + held-out evaluation
npm run demo         # search loop without the held-out stage
npm test             # 24 tests across all mechanisms and both gates
npm run typecheck
```

## Layout

```
src/
  core/
    harness.ts       base agent loop; mechanism hook points
    environment.ts   simulated repo world: files, shell, test runner
    model.ts         scripted model backend (stands in for GPT-5.6 Sol / Opus 5)
    tokens.ts        token estimation, head/tail excerpting
    usage.ts         token traffic accounting + API cost model
  mechanisms/
    action-fusion.ts          Action Fusion
    online-compact.ts         Online Context Compact
    observation-pack.ts       ObservationPack
    evidence-reducer.ts       Evidence-Preserving Reducer
    stack.ts                  composition into the SoL-Pi harness
  research/
    loop.ts          search loop, two sequential gates, nondominated retention,
                      freeze, and held-out evaluation
  tasks/
    corpus.ts        search environments (repo-derived + verifier-driven) and
                      held-out environments
  cli.ts             demo driver
tests/               unit tests
sol-pi-explainer.html  visual explainer artifact
```

## The base harness

`Harness` (`src/core/harness.ts`) is the "Pi"-style loop: expose a tool schema, let the model
emit calls, execute them against the environment, append observations to the context, repeat.
Every mechanism is a `Mechanism` that hooks into one of five points without altering control
flow:

| Hook | When it runs | Used by |
| --- | --- | --- |
| `transformTools` | before the schema is sent | Action Fusion (adds `then_run`) |
| `transformCalls` | after the model emits, before execution | Action Fusion (merges calls) |
| `transformResult` | after a tool runs | Evidence-Preserving Reducer |
| `projectObservation` | before an observation enters the context | ObservationPack (archiving) |
| `transformContext` | before every request | ObservationPack (substitution), Online Context Compact |
| `onPlanStepComplete` | at plan boundaries | Online Context Compact |

The model backend is a `ScriptedModel` whose policy is fixed per task. Because the model's
behaviour is held constant across harness configurations, any measured token difference is
attributable to the harness — which is the property the paper's evaluation depends on.

## The four mechanisms

**Action Fusion** — an edit followed by a separate build/test command costs three API calls.
Fusion adds an optional `then_run` to file-mutation tools and returns both outcomes in one
observation: 3 calls → 2. Commands that inspect the mutation result (`cat`, `grep`, …) are
left separate, matching the paper's fallback boundary.

**Online Context Compact** — at each plan-step completion the harness estimates remaining
requests (from observed requests-per-step and unfinished steps), caps that estimate by what
would fill the context window, and then applies the **cost gate**: compact only when projected
input savings exceed the cache-rewrite cost. Later compactions require a larger margin to
account for unrecovered rewrite cost. Compaction is also permitted near the window limit,
provided it actually shortens the context.

**ObservationPack** — results above 10 KiB are archived locally, sent in full for the next two
requests, then replaced by a stable handle plus a head/tail excerpt of complete lines. The
exact original is recoverable through the handle. The mechanism runs on `transformContext`, so
substitution applies to *recurring* observations in later requests, not just the first one.

**Evidence-Preserving Reducer** — build/test logs ≥ 4 KiB are compressed by a low-cost
extractor model into a receipt, which a deterministic verifier then checks: schema, source
hash, exit status, verbatim quotes, non-empty evidence, and size. Any failure falls back to
the exact original. It runs before ObservationPack, which recognizes the receipt marker and
skips it so verified evidence is preserved.

## The Auto-Research Loop

`AutoResearchLoop` (`src/research/loop.ts`) implements the search half of the paper's Fig. 2:

1. Evaluate the baseline harness on the search environments.
2. For each candidate: propose, implement, review, run.
3. **Capability gate** — every capability metric must stay within its predeclared tolerance.
   Metrics and tolerances are fixed before search and are not under the optimizer's control.
4. **Efficiency gate** — at least one declared efficiency metric must improve.
5. Among candidates passing both gates, retain the **nondominated** set.
6. **Freeze**, then evaluate on the held-out benchmark. Held-out results never feed back into
   search; a failed validation rejects the candidate outright.

The default acceptance rule fixes `aggregateScore` within 5% and requires `tokenTraffic` or
`cost` to improve by at least 5%.

## Environments

Following the paper's two construction paths (`src/tasks/corpus.ts`):

- **Repository-derived** — a pre-fix repo state paired with a hidden regression test that
  fails before the accepted patch and passes after it.
- **Verifier-driven** — an executable verifier defines success, allowing multiple solution
  paths.

The corpus is a compact stand-in for the paper's 535 environments, plus a deliberately
long-horizon task whose verbose build logs give the context-heavy mechanisms something to act
on. Held-out environments are kept in a separate export and are never touched by search.

## Sample output

```
[gate] +observation-pack      score=1.000 traffic=0.0009B cost=$1.91 -> RETAIN | -80.4% traffic, -79.8% cost
[gate] sol-pi[efficiency]     score=1.000 traffic=0.0009B cost=$1.92 -> RETAIN | -80.2% traffic, -79.7% cost
[gate] +online-compact-tight  score=1.000 traffic=0.0026B cost=$5.36 -> RETAIN | -43.7% traffic, -43.4% cost
held-out sol-pi[efficiency]: score=1.000 solved=2/2 cost=$0.39
held-out pi-baseline:        score=1.000 solved=2/2 cost=$1.12
cost saved on held-out: 65.5%
```

## Honest differences from the paper

- The model is a deterministic scripted backend, not GPT-5.6 Sol or Opus 5. Its policy is
  fixed so that token deltas reflect harness changes only.
- The corpus is 6 search + 2 held-out environments, not 535 + EdgeBench's 51.
- Token estimation is character/word based, not a real BPE tokenizer.
- Cost figures use a fixed price table and are not comparable in magnitude to the paper's
  production runs. What is comparable is the *shape*: score preserved, cost down, and
  savings concentrated in the large-object mechanisms.
- The extractor model is a regex-based stand-in for GPT-5.6 Luna, parameterised by a fidelity
  knob so the verifier's pass and fallback paths both get exercised.

## The explainer

`sol-pi-explainer.html` is a self-contained visual walkthrough of the loop, the gates, the
four mechanisms, and a side-by-side of paper vs. prototype results. Open it directly in a
browser; it follows Cube's `theme` query parameter and falls back to `prefers-color-scheme`.
