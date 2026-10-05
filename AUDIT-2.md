# SoL-Pi — Post-Remediation Validation & Second Audit

**Date:** 2026-10-05
**Scope:** validation of every finding in `AUDIT.md` (2026-10-04) against the state after
`4dbc7b5`, plus a fresh audit of the code and artifacts as they now stand.
**Method:** full read of all 14 modules, all 3 test files, both published artifacts, and both
documents; then empirical verification against the running system. Every claim below that can be
checked by a command was checked by a command. Throwaway probes were deleted afterwards;
`git status` is clean before and after this audit.

**Verification commands actually run:**

```bash
npm run typecheck     # clean, exit 0
npm test              # 38/38 pass
npm run research      # twice; output byte-identical between runs
npm run demo          # produces the same figures as --research
```

---

# Part 1 — Verdict on the remediation

**The remediation is substantively complete and the evidence for it is real.** The three things
`REMEDIATION.md` set as its publish bar are all satisfied, and in each case the fix is the
*substantive* one rather than the *retractive* one:

| Publish bar (`REMEDIATION.md:110-114`) | Status | Ground truth |
|---|---|---|
| H-3 fixed, or its claim retracted | **Fixed** | The reducer now reports `reduced:15, fallbacks:0, savedBytes:1,120,323` on the long-horizon task, and wins the search table at −96.9% cost. It is what the search freezes. The claim is no longer retracted because it no longer needs to be. |
| H-4's tool wired, or its promise removed | **Wired** | `recall_observation` is contributed by `transformTools`, served by `resolveTool`, and the substituted view points at it. A test exercises the dispatch path. |
| All artifacts regenerated from real output | **Done** | All 35 published figures I cross-checked in the README and explainer match `research-results.json` exactly (see Part 1.3). The pipeline is no longer hand-transcribed. |

The two claims the fix invalidated are documented honestly in both artifacts: Action Fusion is
reported at −0.1% with an explanation of why the earlier −23.6% was missing work, and the reducer
is correctly named as the dominant mechanism rather than "the large-object mechanisms"
collectively.

Two honest deviations from the audit's literal recommendations, both defensible:

- **H-6** was implemented as `return { pass: false, ... }` rather than the recommended `throw`. It
  closes the hole — a zero baseline now rejects every candidate instead of rubber-stamping them —
  and it is tested (`tests/research.test.ts:90`). Not matching the letter of the recommendation is
  fine here; the property the recommendation existed to protect is what was restored.
- **M-4** was fixed rather than deleted, as `REMEDIATION.md:42-44` argued for. This was the right
  call: the fix *exposed* the fake −23.6% saving, which deleting the code path would have left
  credited to the harness side forever.

## 1.1 Per-finding validation

**Closed — verified against the running system (29 findings)**

| # | Finding | Verification |
|---|---|---|
| H-1 | `then_run` unvalidated | `validateThenRun` (`harness.ts:469`) guards both `write_file` and `edit_file`; malformed string and `[123]` forms now yield error results. Test `core.test.ts:74`. |
| H-2 | `update_plan` poisons the plan | `validatePlanSteps` (`harness.ts:479`) checks array shape and per-element `id`/`title`/`status`; returns a typed error result, so the plan stays an array. Test `core.test.ts:83` asserts `Array.isArray(harness.plan)` after a malformed emission. |
| H-3 | Reducer reduces nothing | Evidence is now a typed, priority-ordered predicate over the formats `Environment` emits. Real run: `reduced:15`, `savedBytes:1,120,323`. Regression test `mechanisms.test.ts:154` runs the reducer over the corpus's own `bigLog()` output — the test whose absence let the bug ship. |
| H-4 | Recall unreachable | `recall_observation` in `transformTools` (`observation-pack.ts:56`), served via `resolveTool` (`:77`) and the harness's mechanism-first dispatch (`harness.ts:422`). Test `core.test.ts:121`. |
| H-5 | Fused mutation not atomic | Prior content snapshotted and restored on any non-zero `then_run` exit, in both `write_file` (`harness.ts:332`) and `edit_file` (`:374`). Test `core.test.ts:94` asserts `env.score()` is 0 after a failed fused verification. |
| H-6 | Zero baseline rubber-stamps | `loop.ts:191` returns `pass:false`; a zero-baseline search therefore retains nothing rather than everything. Test `research.test.ts:90`. |
| M-1 | Prototype-chain lookup | `Object.hasOwn` at `environment.ts:46`. Test `core.test.ts:113`. |
| M-2 | Hardcoded `callId` literals | Base tools mint ids from the call in `executeCalls` (`harness.ts:306`); the four literals are gone. Test `core.test.ts:102` asserts uniqueness within a turn. **See N-1: the fix is reintroduced in the new tool.** |
| M-3 | `onPlanStepComplete` re-fires | `notifiedStepIds` (`harness.ts:99`) seeded with pre-done steps and extended per newly-done step. Test `core.test.ts:146` asserts `[1, 2]` over two identical plan updates. |
| M-4 | Model-side fusion dead | `fusionParam` (`model.ts:131`) reads the nested `properties`, and `tryFuse` covers `edit_file`. Real run reports `modelFused:1` with `fused:0` — the model-side path now carries the whole effect. |
| M-5 | Mechanism state never resets | `reset?()` on the interface, called at the top of `run()` (`harness.ts:178`); every mechanism implements it. Test `core.test.ts:137` asserts the archive does not accumulate. |
| M-6 | `tools()` mutates model state | `tools()` is now pure; `notifyTools()` is a separate explicit call once per run (`harness.ts:194`). |
| M-7 | Duplicate trace entries; conflated `failureReason` | Zero-call responses break once regardless of `stopReason` (`harness.ts:236`); `failureReason` splits `max_turns exhausted` from `incomplete` (`:292`). |
| M-8 | Held-out gate not enforced; hardcoded freeze | `heldOutVerdict` (`loop.ts:352`) re-applies both gates; the CLI freezes `summary.best` (`cli.ts:197`) and sets `process.exitCode = 2` on validation failure. Real run freezes `+evidence-reducer`, not the previously-hardcoded `sol-pi[efficiency]`. |
| M-9 | Loose prefix matching | Exact allowlist: `eligibleTools.includes(result.tool)` (`evidence-reducer.ts:176`). Test `mechanisms.test.ts:193` covers both prefix-adjacent rejects and the five allowlisted names. |
| M-10 | Nondeterministic fidelity | Drop decision seeded by the log's own hash (`evidence-reducer.ts:123`). Verified: two full `npm run research` runs produced byte-identical output; test `mechanisms.test.ts:184` asserts a stable quote set. |
| M-11 | `score()` re-evaluated 4× | Computed once at `harness.ts:283`; `success`, `score`, and `failureReason` all derive from it. |
| M-12 | Bar chart collapses below ~360px | Breakpoint at 480px stacks the label above the bar (`explainer.html:142`). Recomputed: the 4px-track width only occurs above the breakpoint, where the layout no longer applies. |
| M-13 | No landmarks or semantics | `<main>` and `<footer>` present; diagram is an ordered list with `aria-hidden` arrows; both tables have `<caption>` and `scope="col"` on all 10 headers; chart carries `role="img"` with a summary `aria-label`. Heading sequence unchanged at `1,2,2,2,2,3,3,3,3,2,3,3,3,2,2` — still no skipped levels. |
| M-14 | Theme snapshotted; no `color-scheme` | `color-scheme` declared per theme; `matchMedia("change")` listener follows the OS while `?theme=` stays authoritative. One `addEventListener` in the document, as intended. |
| M-15 | Published numbers contradict output | See 1.3. |
| L-2 | Gate metric unvalidated | `gateMetric` (`loop.ts:19`) throws on a non-finite key instead of letting `undefined <= 0` pass. Test `research.test.ts:101`. |
| L-3 | `traffic(B)` header over millions | Header is `traffic(M)`, matching the `/1e6` divisor. |
| L-4 | Magic separator width | Width computed from the column array (`cli.ts:151`). |
| L-5 | `row()` never truncates | Overlong cells are truncated with an ellipsis (`cli.ts:97`). |
| L-6 | Dead `.val good` class | `td.good` is now genuinely used by the result cells. |
| L-7 | Inline `import()` type annotations | Hoisted to a top-level import of `EvalResult`. |
| L-8 | No meta description | Present (`explainer.html:6`). |
| L-11 | Non-null assertion on hardcoded id | Replaced by `summary.best` with a baseline fallback. |
| L-16 | `grep` leaks `undefined` | Guarded with a "missing target file" error (`environment.ts:78`). |
| L-19 (half) | Test doubles down a no-op | The reducer half is fixed: the new regression test would have caught H-3. |
| L-21 (half) | `as never[]` casts | `tests/research.test.ts` now types configs as `MechanismName[]`. |

## 1.2 Findings deferred by the plan, and their current status

`REMEDIATION.md` explicitly deferred these. They remain open and are re-listed in Part 3 with their
present severity, so the record stays honest rather than quietly dropping them.

**L-1** (compaction injects `role:"user"` mid tool-run, `online-compact.ts:185`) — unchanged.
**L-13** (one `ScriptedModel` shared across the whole search) — unchanged; the code comment the
plan promised is not present either. **L-15** (empty file indistinguishable from missing) —
unchanged. **L-18** (module-global `callSeq` never resets) — unchanged, and now more visible: see
N-4, where the shell counter's ids are the ones that actually reach the context.

## 1.3 The M-15 check, done properly

Rather than eyeballing the artifacts, I cross-checked every prototype figure in both artifacts
against `research-results.json` programmatically — 37 assertions covering all 8 candidate rows in
both documents (traffic, cost, score, and vs-baseline), the mechanism activation stats quoted in
the explainer's pills and prose, and the README's `[gate]` and held-out sample lines.

**All 37 match.** The missing candidate row is present (`+online-compact-tight`, all 8 rows now),
the substitution count reads 14 where it once read 109, the `[gate]` line carries the real reason
text (`tokenTraffic -97.6%, cost -96.9%`, not the invented `RETAIN | -80.4% traffic, -79.8% cost`
form), and the unit is right. The demo and research paths also produce identical figures, so the
file the artifacts cite is the file either invocation writes.

The two residual problems are not transcription errors — that failure mode is genuinely closed.
They are *scope* errors, where a correct number is labelled with the wrong measurement. See N-2
and N-3.

---

# Part 2 — New findings

These did not exist at the time of the first audit. Two of them are direct side effects of fixes
that were correctly applied, which is worth stating plainly: the H-4 fix created N-1, and the
M-15 regeneration created N-2. Both are in the same category the first audit called disqualifying
for external publication — published claims that the program does not back — so they should be
cleared before the explainer is shared, even though neither affects any code correctness or any
measured number.

## N-1 · `recall_observation` reintroduces the hardcoded `callId` defect M-2 removed

**Severity:** Medium · **Category:** Reliability (regression of a fixed finding) · **Confidence:**
Confirmed by reproduction

**Location:** `src/mechanisms/observation-pack.ts:84` and `:97`.

**Issue:** M-2's finding was that `ToolResult.callId` must be minted per call, because (a) a real
provider rejects duplicate `tool_call_id`s in one request, and (b) `ObservationPack` keys its
archive as `obs:${result.callId}`, so colliding ids mis-key the archive. The fix threaded a real id
through every base-tool branch. The `resolveTool` added to wire H-4 returns the constant string
`"recall"` on both its success and error branches, so the two reasons M-2 gave both apply again to
this one tool.

**Impact:** Two `recall_observation` calls in a single turn produce two tool messages with the same
id. This is latent in the shipped corpus — the scripted policy never calls the tool — but any real
model can emit it, and it is precisely the "harness has never been exercised against a provider
that validates" gap the first audit named as an architectural issue.

**Evidence:**

```
turn-3 (dual recall) result callIds: [ 'recall', 'recall' ]
distinct: 1
archive keys: [ 'obs:call_2', 'obs:call_4', 'obs:recall' ]   <- one obs:recall entry for two recalls
messages with callId 'recall': 2 (both full bodies share one id)
pack.stats: { archived: 3, substituted: 3, recalled: 2, bytesArchived: 226835 }
```

Both bodies reach the context (the substitution guard `m.content !== entry.original` keeps the
second full), so this is a correlation and archive-keying defect, not data loss. But only the first
recalled body is ever archived, and a real provider would reject the request outright.

**Recommended fix:** Have `resolveTool` accept the call (or let `executeOne` pass the allocated id
through to mechanism-resolved tools, as it already does for the base branches) and mint
`callId: nextCallId()`. This is a two-line change and it restores the invariant M-2 established.

## N-2 · The explainer labels a search-aggregate figure as a long-horizon figure

**Severity:** Medium · **Category:** Visual Consistency (claims integrity) · **Confidence:** Confirmed
by measurement

**Location:** `sol-pi-explainer.html:344`.

**Issue:** The ObservationPack card reads `prototype: 15 archived, 14 substitutions` (correctly,
long-horizon activation figures) and then `−79.5% cost on long-horizon`. The 79.5% is the
ObservationPack row's cost reduction across the **six search environments**; it is not the
long-horizon task, which the activation section measures separately.

**Impact:** A reader comparing the pill to the activation table finds a number that does not
reconcile with either table — the exact M-15 failure mode, on a smaller scale, in the mechanism card
the audit originally flagged by name. The two adjacent pills now disagree about which measurement
they are reporting.

**Evidence:** I re-ran the long-horizon task with and without ObservationPack, replicating
`cli.ts`'s activation script:

```
long-horizon baseline cost = 6.667
long-horizon ObsPack  cost = 0.961
actual long-horizon saving = 85.6%
```

**Recommended fix:** Either report the measured long-horizon figure (−85.6%) or reword the pill to
`−79.5% cost across search environments`. The former is stronger and is already the section the
pill sits next to.

## N-3 · The explainer attributes a transfer signature to the prototype, which runs no transfer

**Severity:** Medium · **Category:** Reliability (claims integrity) · **Confidence:** Confirmed

**Location:** `sol-pi-explainer.html:472-473`; the unused backend factory at `src/core/model.ts:140`.

**Issue:** §6 states that the paper's Fig. 6 shows lower trigger rates on Opus 5 with efficiency
still improving, and continues *"the prototype's gate logs reproduce this same signature."* They do
not, because no second backend is run anywhere. `makeBackend` is exported and documented as *"Used
for the transfer experiment: identical policy, different backend id"* and is never called in `src/`
or `tests/`. The CLI instantiates exactly one `ScriptedModel` (`gpt-5.6-sol`) for search, held-out,
and activation alike.

**Impact:** This is the same class as the original H-4 finding — an affordance the artifact asserts
that the program provides no evidence for. It is the only remaining sentence in either artifact that
asserts a prototype behaviour with no run behind it. Everything else in §6 is correctly attributed
to the paper.

**Recommended fix:** Either run a second backend (the factory exists; `heldOutEvaluation` already
accepts a model, so a second scripted id is a small addition to the CLI and would make the claim
real) or drop the clause to *"the paper's Fig. 6 shows this signature; the prototype runs a single
backend and does not reproduce it."* The README does not make this claim, so only the explainer
needs editing.

## N-4 · The `callId` allocated for a call is discarded by `read_file` and `run`

**Severity:** Low · **Category:** Reliability (consistency of the result contract) · **Confidence:**
Confirmed

**Location:** `src/core/harness.ts:320` (`read_file`), `:395` (`run`).

**Issue:** `executeCalls` allocates an id per call and passes it to `executeOne`, but the two
dispatch branches that delegate to the shell return `env.run(...)` verbatim. `Environment.run`
mints its own id from the same module-global counter, so the passed `callId` is unused on those
paths and the result carries the shell's id rather than the call's.

**Impact:** No collision — both draw from one counter, so ids stay unique, which is why nothing
fails. The cost is that the result contract M-2 articulated ("results correlate back to the request
that produced them") holds for mutations and plans but not for reads and runs, the two most common
calls; and one id is allocated and wasted per shell call. This is also what makes the id numbering
in N-1's evidence (`obs:call_2` for the first shell result) harder to predict than it should be.

**Recommended fix:** Thread the passed id into the shell results, or have `Environment.run` accept
an id. Either way the shell's own counter becomes internal.

---

# Part 3 — Second audit: what remains

## Still open, carried forward

| # | Finding | Where | Note |
|---|---|---|---|
| L-1 | Compaction injects `role:"user"` into the middle of a tool-call run, breaking the assistant→tool alternation real providers validate | `online-compact.ts:185` | Unchanged. Now the most consequential remaining gap in the message contract, given N-1. |
| L-13 | One `ScriptedModel` shared across every task, candidate, and the held-out run | `loop.ts:110-112`, `282` | Unchanged; correctness still rests entirely on sequential execution. Deferred deliberately, but the code comment `REMEDIATION.md:102` promised was not added either. |
| L-15 | An empty file is indistinguishable from a missing one | `environment.ts:70,80` | Unchanged; deferred as cosmetic. |
| L-18 | Module-global `callSeq` never resets; ids grow process-wide and interleave across `Environment` instances | `environment.ts:3` | Unchanged, and now entangled with N-4. |
| L-10 | `AutoResearchLoop.generations` is never cleared in `run()`, so a second call accumulates rounds | `loop.ts:125,269` | Not mentioned in the remediation at all. One-line fix, same shape as the M-5 fix that *was* made. |
| L-14 (half) | No test exercises a zero-call response with a non-`end_turn` stop reason, or the `max_turns exhausted` failure reason | `harness.ts:226-236` | The zero-baseline half of L-14 is now tested; the stop-reason half is not. M-7's fix is therefore unguarded by a test. |
| L-17 (half) | Unsupported flags read as an unknown command for a supported tool | `environment.ts:84-95` | Improved: the message now reports only the leading word, so `test --verbose` no longer echoes the arguments. Flags are still unsupported. |

## Partially fixed — residual worth recording

- **L-9 (dead code).** `planFor`, `ActionFusion.planStep`, `Environment.outputLog`, and
  `stepCompletionsSeen` are all correctly deleted. Three items the remediation's table claims were
  not: `UsageMeter.perRequestUsage` (`usage.ts:66`, still unreferenced), the unused `rates`
  parameter on `UsageMeter.tokens()` (`usage.ts:74`), and `excerpt`/`estimateTokens` imported but
  never used in `evidence-reducer.ts:1`. The last one is a small irony: the file's previous
  re-export of those names was the original L-9 finding, and the fix turned the re-export into an
  unused import.
- **L-19 (the other half).** The two `ObservationPack` tests
  (`mechanisms.test.ts:105-117`) still call `transformResult`, which the mechanism deliberately
  made a pass-through when archiving moved to `projectObservation`. Both assert `stats.archived ===
  0`, which is true regardless of the threshold or marker logic under test — so neither can fail.
  The reducer regression test added for H-3 is what makes the suite honest about the reducer; the
  ObservationPack pair should be rewritten against `projectObservation` + `transformContext` to
  give it the same property.
- **L-20.** The partition assertion now compares against `summary.proposals` rather than the
  literal `2`, which is better, but it remains a partition identity — every candidate lands in
  `retained` or `rejected` by construction, so it still cannot fail.
- **L-21 (the other half).** `tests/mechanisms.test.ts:237,246` still declares its mechanism arrays
  as `never[]` and casts a mechanism `as never`, so those configs are not type-checked.
- **L-12.** `FIXTURES[task.id]` is now guarded with a throw (`cli.ts:48`), but `scriptFor` still
  ignores its third `model` parameter, and every call site passes only two arguments against a
  three-parameter signature.

## Verified clean, re-checked adversarially

So the record is not read as uniformly negative:

- **No XSS sink.** The remediation added script and ARIA without introducing `innerHTML`,
  `document.write`, `eval`, `new Function`, or `insertAdjacentHTML`. The theme module reads
  `URLSearchParams` against an explicit `=== "light" || === "dark"` allowlist, and the new
  `addEventListener` only re-runs that same allowlist.
- **Contrast passes WCAG 2.2 AA in both themes.** Recomputed all token pairs: dark-theme body text
  16.02:1, dim text 7.76:1, every accent 5.16–6.86:1. Light-theme body 15.80:1; the four thin pairs
  the original audit flagged as marginal (`--accent2`, `--warn`, `--purple`, and `--purple` on the
  isolation background at 4.51:1) are all still above 4.5 and were not made worse. The audit's I-1
  headroom caveat stands unchanged.
- **Heading hierarchy is clean** and the new landmark elements added no levels.
- **No horizontal scroll below the chart breakpoint.** The 4px track the original audit measured at
  320px is now above the 480px breakpoint where that layout no longer applies.
- **`npm test`, `npm run demo`, and `npm run research` all work as documented**, and `npm run
  research` is reproducible — two runs produced byte-identical output, which is what M-10's fix was
  for.
- **Unknown tools are still not silently dropped**, and mechanism-contributed tools now get first
  refusal before that fallback (`harness.ts:422`).
- **No secrets, no network, no process execution, no filesystem.** The scope clarification in the
  first audit still holds in full; nothing in the remediation added a surface.

---

# Release recommendation

### 🟢 Internally consistent and safe to run

`npm run research` and `npm run demo` are reproducible, the suite is green, the typecheck is clean,
and the code paths the audit called dangerous are guarded and tested. Every High finding from the
first audit is closed with verification, and the two number-moving fixes produced *more* honest
figures rather than better-looking ones — the fake −23.6% is gone and the mechanism that actually
dominates is now the one the narrative names.

### 🟠 One more pass before external publication

The bar `REMEDIATION.md` set was "fix H-3, wire H-4, regenerate every number." That bar is met. The
bar the first audit set was stricter — *no published claim the program's own output contradicts* —
and three sentences remain short of it: N-2's mislabelled figure, N-3's unsupported transfer claim,
and N-1's reintroduced id literal (latent, but a real provider would reject it). All three are small
and none requires regenerating any number, because none of them touches a measurement:

1. **N-2** — one pill's wording, or one number changed to the measured 85.6%.
2. **N-3** — drop one clause, or add a second scripted backend to the CLI (the factory already
   exists and `heldOutEvaluation` already takes a model).
3. **N-1** — two lines in `resolveTool`.

Clearing those three is comfortably under an hour and takes the artifacts from "numbers are right"
to "every claim is backed." L-1 and L-13 are the two deferred items I would not let drift much
further: both are about the harness's contract with a real provider, and both become load-bearing
the moment a non-scripted backend is attached.

---

## Re-audit status (2026-10-05, after `REMEDIATION-2.md`)

All four findings are closed. The three sentences flagged above are gone, and the verification
was not a code read:

- **N-1** — `resolveTool` now receives the harness-allocated `callId` and both branches carry it.
  The regression test is provably non-vacuous: reverting the two literals to `"recall"` makes it
  fail with *"two recalls in one turn must not share an id"*, re-applying the fix makes it pass.
- **N-4** — `read_file` and `run` thread the id they were given. This was the one fix that could
  have moved a published number, because it shifts the `obs:call_N` handles that appear inside
  observation text. It did not: the post-fix `research-results.json` diffs **strictly additively**
  against the pre-fix file. No existing value changed.
- **N-2** — the pill now reads −85.6%, and that figure is no longer quoted by hand: `npm run
  research` emits a no-mechanism baseline row and a `costSaved` field per mechanism, so the
  long-horizon delta is program-generated like every other published number.
- **N-3** — retracted, not simulated. A second backend sharing `ScriptedModel`'s policy would have
  produced byte-identical results, which is the same defect class this audit hunts. The explainer
  now says plainly what the prototype does *not* show.

Suite: 38 → 41 tests, all green; typecheck clean; two consecutive `npm run research` runs remain
byte-identical. The release recommendation is now 🟢 for internal use, and the remaining bar to
external publication is the deferred set (L-1, L-13) rather than any contradiction between the
artifacts and the program's own output.

