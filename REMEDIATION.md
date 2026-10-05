# SoL-Pi — Remediation Plan

**Date:** 2026-10-04
**Basis:** Independent verification of `AUDIT.md` findings against the running system. Every
finding referenced below was reproduced with a probe script before being included.

## The sequencing principle that governs everything

Some fixes **move the measured numbers**; others only harden. Regenerating the
explainer/README must happen **once, after all number-moving fixes land** — otherwise the
numbers get transcribed by hand again, which is exactly how M-15 happened. That is a hard
dependency, not a preference.

## Who is actually on fire

Verification reshuffled the audit's severity. Of every confirmed finding, only **three are
active on every shipped run**, and two of those are *documentation* bugs rather than code bugs:

| | Finding | Live on every run? |
|---|---|---|
| **H-3** | Reducer reduces nothing (0 quotes on real logs) | **Yes — and docs claim it dominates savings** |
| **H-4** | Recall is promised to the model, no tool exists | **Yes — and docs promise it** |
| **M-3** | Step-complete re-fires every turn, biases the compaction gate | **Yes — moves numbers** |
| **M-15** | Explainer/README contradict real output | **Yes** |
| H-1, H-2, H-5, H-6, M-1, M-5 | Crashes / gate hole / lookup / leak | Latent — the scripted backend and the fresh-harness-per-run construction never trigger them |

The fire is truthfulness, and the audit was right that this is disqualifying for a research
artifact.

## Two corrections to the audit's impact claims

- **H-5 is overstated.** The audit claims a failing `then_run` lets a bad fix score as
  passing. Measured: score **0** after a failing `then_run` — the scorer is unaffected. The
  real defect is narrower: the fused path reports `exitCode: 1` *after* already mutating,
  breaking the atomicity a single-call interface implies. Worth fixing; it does not
  "silently bank a fix."
- **M-5 does not touch the shipped paths.** The research loop and CLI both construct a
  **fresh harness per task**, so the archive never accumulates during `npm run research`. It
  only bites a reused harness instance. Still a one-line fix, but latent rather than active.

On **M-4**: fix rather than delete. Restoring the nested-property lookup (2 lines) makes the
fusion measurement honest — currently every Action Fusion saving comes from harness-side
`transformCalls` while the README credits the model-side path. That is the same class of
false attribution as H-3.

## Phase A — number-moving fixes (one unit, must land first)

1. **H-3 + M-9 + M-10 together** — these are one fix, not three. The evidence model becomes a
   typed predicate over the log formats `Environment` actually emits (`[summary]`,
   `N passed, M failed`); eligible commands become an exact allowlist; `extractorFidelity`
   becomes deterministic. Fixing the regex alone would immediately expose the nondeterminism
   and the `npm`-prefix over-matching.
2. **M-3** — fire `onPlanStepComplete` only for newly-done steps. This re-tunes `perStep`,
   which changes when compaction fires, which moves **both** `+online-compact` and the
   headline `sol-pi[efficiency]` stack (it includes OnlineContextCompact). Not an isolated
   change.
3. **M-4** — restore the nested lookup so model-side fusion actually runs.
4. **M-11** — compute `score()` once instead of 4×.

⬇️ **Freeze point: published numbers are now final.** Nothing below may change them.

## Phase B — hardening (parallel-safe, numbers unchanged)

5. **H-1, H-2** — type guards at the dispatch boundary returning typed error results instead
   of throwing.
6. **M-2** — mint real per-call `callId`s; delete the string literals.
7. **H-5** — snapshot-and-restore so a fused mutation is atomic.
8. **H-6** — a zero baseline becomes a hard abort, not a rubber stamp.
9. **M-1** — `Object.hasOwn` in `readFile`.
10. **M-8** — actually gate on held-out results, and freeze `summary.best` instead of the
    hardcoded `find(...)!`.
11. **M-5 + M-6** — `reset?()` and `prepare(tools)` on the `Mechanism` interface, with an
    explicit setup step so `tools()` stops mutating model state.

## Phase C — artifact truthfulness (only after the freeze)

12. **Make `npm run research` emit the results tables** (JSON), and have the explainer inject
    them at build. This is the root cause of M-15 — hand-transcription. Correcting `109`→`14`
    by hand would just recreate the failure mode.
13. **H-4** — expose a real `recall_observation` tool rather than deleting the promise. The
    substituted text already instructs the model to recall; wiring the tool makes the harness
    coherent *and* testable, for ~20 lines.
14. Regenerate the README sample output from a real invocation.

## Phase D — accessibility (independent track, no numbers involved)

15. **M-13** landmarks, table `scope`/`<caption>`, diagram and chart semantics.
16. **M-12** bar-chart breakpoint below 480px.
17. **M-14** `color-scheme` plus a live `prefers-color-scheme` listener.

## Tests to interleave, not bolt on

L-19 is the uncomfortable one: `ObservationPack.transformResult` is a pass-through, so two
existing tests **cannot fail**. Add a regression test that runs the reducer over real
`bigLog()` output and asserts `reduced > 0` — that test is what would have caught H-3, and its
absence is why the bug shipped. Also replace the `as never[]` casts (L-21) so the tests
actually type-check the configs they exercise.

## Deferred

- **L-13** (shared `ScriptedModel`) — rated "Needs Verification" in the audit; it is the
  invariant the whole measurement story rests on. Add a comment now; do the real work only
  before any parallelism.
- **L-15 / L-16 / L-17** (empty-file handling, `grep undefined`, flag parsing) — cosmetic in a
  simulated shell.
- The full type/spacing scale (**I-2**) — real churn for no correctness gain.

## Publish bar

Three things, not twelve:

1. H-3 fixed, or its claim retracted.
2. H-4's tool wired, or its promise removed.
3. All artifacts regenerated from real output.

Roughly a focused day, matching the audit's estimate. Phase D can run concurrently since it
never touches numbers.

---

## Status after implementation (2026-10-04)

All four phases landed. `npm run typecheck` is clean and the suite went **24 → 38 tests**, all
passing. `npm run research` now writes `research-results.json`, and the README and explainer
figures were regenerated from it and cross-checked programmatically.

### What changed, and what it moved

| Finding | Fix | Effect on published numbers |
|---|---|---|
| H-3 + M-9 + M-10 | Evidence is now a typed predicate over the log formats `Environment` emits, ordered by evidentiary value; exact tool allowlist; hash-seeded fidelity | **The headline change.** Reducer went from `reduced:0` to 15 logs reduced and 1.12 MB saved; it now wins the efficiency table (−96.9% cost) and is what search freezes |
| M-3 | `onPlanStepComplete` fires once per newly-done step via a notified-id set | Gate samples are no longer dragged toward 1 request/step |
| M-4 | Model reads `then_run` nested under `properties`; `tryFuse` also covers `edit_file` | Model-side fusion now runs. **Revealed a fake saving:** `+action-fusion` was reported at −23.6% only because a bare-string `then_run` was dropped and `test` never ran. Honest figure is −0.1% — this corpus's scripted policy already batches write+run in one turn |
| M-11, M-7 | `score()` computed once; trace no longer double-pushes on non-`end_turn` stops; `failureReason` distinguishes budget exhaustion from incompleteness | None |
| H-1, H-2, M-2 | Type guards for `then_run` and `update_plan.steps`; per-call `callId`s; fused mutations roll back on failure; `Object.hasOwn` in `readFile` | None — all hardening |
| H-6, L-2 | Zero baseline aborts the capability gate; gate metrics validated by key | None (latent), now tested |
| M-8 | `heldOutVerdict` re-applies both gates; freeze uses `summary.best`, not a hardcoded id | Frozen candidate is now `+evidence-reducer` instead of the hardcoded `sol-pi[efficiency]` |
| M-5 + M-6 | `reset?()` on the `Mechanism` interface, called per run; `notifyTools()` explicit, `tools()` pure | None |
| H-4 | `recall_observation` tool contributed by ObservationPack and served via a new `resolveTool` hook | Substituted view now points at a real affordance |
| M-13, M-12, M-14, L-8 | `<main>`/`<footer>`, ordered-list diagram with hidden arrows, table captions + `scope`, `role="img"` on the chart, bar breakpoint at 480px, `color-scheme` + live theme listener, meta description | Presentation only |
| L-3–L-9 | `traffic(M)` units, computed separator width, cell truncation, dead-code deletions | Presentation only |

### Two claims the fix invalidated, now documented honestly

1. **Action Fusion does not save tokens in this corpus.** The measured −23.6% was missing work,
   not saved work. The README and explainer both say so.
2. **The reducer, not ObservationPack, dominates.** The narrative copy that credited the
   "large-object mechanisms" collectively was wrong about which one; it is now stated correctly.

The deeper change the audit called for — stop hand-transcribing numbers — is addressed by
`research-results.json`: `npm run research` is now the single source, and the artifact tables
were generated from it.

