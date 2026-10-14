# SoL-Pi — Remediation Plan, Round 5

**Date:** 2026-10-14
**Basis:** the three extractor-coverage recommendations outstanding from the round-4 critique:

1. `fallbacks` conflates two failure modes — a log the extractor has no rules for, and a
   receipt that could not be trusted — so the stats can dress a coverage gap up as a failed
   verification. Split them.
2. The extractor's limited rule coverage is asserted, not measured. Make it an outcome the
   corpus produces, the way AUDIT-3's cache-prefix probe made cache billing an outcome.
3. Say so in the README's honest-differences section — with the measurement behind it, not a
   hedge.

All three were done in that order on purpose: the stat (1) is what makes the corpus task (2)
observable, and the corpus task is what gives the README sentence (3) a number to cite.

## What moved and why

| | Deliverable | Where | Moves published numbers? |
|---|---|---|---|
| **(1)** | An empty receipt is a distinct failure mode with its own counter: `unrecognisedFormatFallbacks` | `evidence-reducer.ts:189` | No |
| **(2)** | `verifier-003`, a corpus task whose build log is 55,248 bytes of rustc warnings the rules provably do not cover | `corpus.ts` (`rustcLog`, `verifier-003`) | **Yes — every search figure** |
| **(2b)** | A measurement-only probe over real failure logs, and a second labeled activation run on the gap task | `probes/measure-extractor-coverage.ts`, `cli.ts` | Publishes `activation.reducerUnrecognisedFormat` |
| **(3)** | The honest-differences bullet cites the measurement; the gap figures are enforced against the JSON | `README.md`, `check-artifacts.mjs` | No |
| — | Three explainer pills had drifted (two from the 6→7 corpus change, one a mislabel from round 1 that round 2 half-fixed) | `sol-pi-explainer.html` | Corrected, see below |

Only (2) moves numbers, and it moves all of them, because the search corpus went from 6 tasks to
7: `verifier-003` costs real tokens on both sides of every row and its build log is traffic the
reducer cannot compress. That is the point of the task — the published row set now includes the
task that exposes the gap instead of quietly excluding it.

## The fixes

### (1) — `unrecognisedFormatFallbacks`

The new branch sits **before** the verifier (`evidence-reducer.ts:189`): if the extractor produced
zero quotes, the log's format is one the rules do not recognize. That is a coverage gap in the
stand-in, not a receipt that could not be trusted, so it increments its own counter and returns
the verbatim original without ever asking `verify()`. `verify()`'s own
`quotes.length === 0 → false` guard (line 237) is kept as defense in depth: the branch is a
harness-level accounting decision, the guard a statement about what a verified receipt means,
and they are allowed to age independently.

The stat flows through `stats()`, `reset()`, the CLI's activation block, and a new field
`activation.reducerUnrecognisedFormat` in `research-results.json` — a second labeled activation
experiment that reports `costSaved: 0` exactly, because the same `modelFactory()` drives both
sides of the comparison (round 2's single-shared-model bug would have made it −0.3%).

Pinned by `tests/extractor-coverage.test.ts` (new, 7 tests) and one new case in
`tests/mechanisms.test.ts`:

- an unrecognised log leaves the original verbatim, `unrecognisedFormatFallbacks === 1`,
  `fallbacks === 0`;
- a fabricated receipt (a stub extractor that never read the log) counts the other way:
  `fallbacks === 1`, `unrecognisedFormatFallbacks === 0` — it fails verification on **two**
  independent checks (source hash and exact quotes), so no single-check mutation can smuggle it
  through;
- `verify()` still rejects an empty receipt on its own.

### (2) — the gap as a measured outcome

`rustcLog()` (`corpus.ts`) emits 300 warning blocks the way rustc really does — span pointers,
caret underlines, `note:`/`= help:` lines, and a closing `warning: 300 warnings emitted` — 55,248
bytes, 0 rule matches, 0 quotes. `verifier-003` is a rust/infra fix task whose build is that log,
on a body whose fix turns `false` into `Ok(...)`. Because `runBuild` always exits 0 and returns
`tool: "build"` (an allowlisted tool), and its prelude matches no rule, every build run of the
three-script task lands in the new branch: the run records
`stats={"reduced":0,"fallbacks":0,"unrecognisedFormatFallbacks":3,"savedBytes":0}` and saves
**exactly 0** cost against the same task without the mechanism.

The probe is measurement-only, mirroring AUDIT-3's `measure-cache-prefix.ts`:
`probes/measure-extractor-coverage.ts` runs the rules against nine logs — rustc warnings, rustc
errors, go, tsc, maven, eslint, a real pytest failure, the fixture's pytest log, and
verifier-003's log — and prints rule matches, quote counts, and the verdict. Six formats match
zero rules and yield no quotes; the two pytest logs yield evidence. Nothing in the probe passes or
fails the build; it only reports, so the claim "measured, not assumed" is an artifact the repo
produces rather than a sentence in a README.

### (3) — the honest-differences bullet, pinned

The README bullet now states the limitation and cites the measurement: the probe's five uncovered
formats, the 55,248-byte task, the 3 unrecognised-format fallbacks, and the exact-0 cost saving
under `activation.reducerUnrecognisedFormat`. `check-artifacts.mjs` enforces all three against the
JSON and the corpus itself (it imports `rustcLog()` and compares the byte count), so the sentence
cannot drift into a hedge without the gate going red. The checker now runs under `tsx` for that
import (`package.json`), which tsx resolves to the `.ts` module.

### Incidental drift, caught during the re-freeze

Three explainer mechanism-card pills did not survive the number movement, and one was never right:

- OnlineContextCompact's card said `prototype: −34.0% traffic`. That figure was the 6-task search
  table's traffic reduction; under the 7-task corpus it is **−32.5%**, so the pill moved.
- ObservationPack's card carried a green `−97.7% cost on long-horizon` pill — but 97.7% is the
  **Reducer's** long-horizon saving, not ObservationPack's. This is the same defect class as
  round 2's N-2 (a search figure labelled as long-horizon): the value was corrected then, but to
  the wrong mechanism's number, and it followed the Reducer through the round-4 re-freeze.
  ObservationPack's card now carries its own measured figure (**−69.5%**), and the Reducer's
  pill (**−97.7%**) moved into the Reducer's card.
- The Reducer card gained a fourth pill, `measured gap: rustc logs yield no evidence`, in the
  warning colour.

`check-artifacts.mjs` now field-compares each mechanism card's long-horizon pill against **that
mechanism's own** `activation.costSaved`, and the compact card's traffic pill against the search
table — verified non-vacuous by setting all three to wrong values and watching the checker report
three MISMATCHes and DIVERGED.

## The mutation proofs

Each new assertion was broken in source, run, and seen red before restore. (Working-tree backups,
not `git checkout` — the round-5 edits are uncommitted.)

| Mutation | Tests that went red |
|---|---|
| Delete the zero-quote branch | unrecognised-format stat; through-harness verifier-003; the mechanisms empty-receipt case |
| Count the gap as a verification fallback (`unrecognisedFormatFallbacks++` → `fallbacks++`) | same three — the distinction, not just the existence of the counter |
| Drop the stat from the `stats` getter | same three **plus** the fabricated-receipt case (it asserts the field too) |
| Add a rule matching rustc `warning:` lines | verifier-003 matches no rule; **through-harness verifier-003 reduces the log** — the measurement would move if the coverage claim drifted |
| Stop counting verification fallbacks | the fabricated-receipt case only — isolates the distinction from the fallback side |
| Remove `verify()`'s own empty-receipt guard | `verify()` keeps its empty-receipt guard. The test was strengthened first: its receipt and result now share an exit status, so the guard is the *only* check that can fail. Before that the exit-status check masked it and the mutation survived (a real warning, not a vacuous test) |
| Strip the pytest-shaped rules | the pytest-yields-evidence case, plus three pre-existing reducer tests |

The fabricated-receipt case deserves a note: no single verifier mutation turns it green, because
the receipt fails the source-hash **and** the exact-quote checks independently. The mutation that
isolates the behavior under test is removing the fallback count from the failing-verify path.

## The published numbers, re-frozen and re-diffed

The corpus gained a seventh task whose cost is mostly rustc log traffic the reducer cannot touch.
Every absolute cost rose; most savings *shrank*, and the reducer's headline moved deliberately:

| id | cost (was) | cost (now) | saving vs. baseline (was) | (now) |
|---|---|---|---|---|
| pi-baseline | $8.1102 | $8.6935 | — | — |
| +action-fusion | $8.1200 | $8.7042 | −0.1% | −0.1% |
| +online-compact | $7.1176 | $7.7009 | 12.2% | 11.4% |
| +evidence-reducer | $0.2676 | $0.8509 | 96.7% | **90.2%** |
| +observation-pack | $3.8827 | $4.2844 | 52.1% | 50.7% |
| sol-pi[efficiency] | $1.5617 | $1.9628 | 80.7% | 77.4% |
| sol-pi[performance] | $4.9012 | $5.3637 | 39.6% | 38.3% |
| +online-compact-tight | $5.0378 | $5.6211 | 37.9% | 35.3% |

The reducer's own cost more than tripled relative ($0.2676 → $0.8509) because the new task's
55 KiB build log travels through it three times unreduced. That is the number the critique asked
to see published rather than excluded. The long-horizon activation block is unchanged — it runs
on the long-horizon task, not the search corpus: the reducer still saves 97.7%, ObservationPack
69.5%, OnlineContextCompact 22.4%. **The retained set, the held-out inputs, the acceptance rule,
and the held-out verdict (95.5% saved, PASS) did not move at all.**

As in rounds 3–4, the regeneration went through the guards: `npm run check` re-runs the pipeline
and field-compares against the committed JSON, and `npm run check-artifacts` cross-checks the
README and the explainer against it — 8 table rows in both artifacts, the headline stat, all 7
bars, the four mechanism-card pills, and the three gap figures.

## Publish bar

1. All three deliverables landed, each with a test that fails when the fix is reverted. ✅
2. `npm run check` passes against the regenerated JSON. ✅
3. `npm run check-artifacts` passes — every published figure matches the JSON, including the gap
   figures. ✅
4. `npm test` and `npm run typecheck` clean — 157/157, no errors. ✅
