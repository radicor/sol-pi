# SoL-Pi — Remediation Plan, Round 3

**Date:** 2026-10-05
**Basis:** `AUDIT-3.md`. Four findings (C-1…C-4). C-1 and C-2 are correctness defects in the cost
model; C-3 is a dead field; C-4 is a process gap that let the first two classes ship twice.

## The sequencing principle this time

Round 2's discipline was "fix everything that could move a number, re-run, then touch the
artifacts." Round 3 inverts part of it on purpose: **C-1 moves every published number, so the
enforcement (C-4) has to land first.** Otherwise the regeneration that C-1 forces is exactly the
manual operation that drifted in rounds 1 and 2.

So: build the guard, then make the change the guard is for.

## What is actually on fire

| | Finding | Moves published numbers? | Blocks publication? |
|---|---|---|---|
| **C-1** | `usage()` zeroes `cacheRead`/`cacheWrite`; the compaction gate optimizes a quantity the ledger never records | **Yes — every cost figure** | Yes — the cost model contradicts the paper's premise |
| **C-2** | Consequence of C-1: ObservationPack's saving is inflated because substitution invalidates the cache prefix (measured LCP 10.8%) | Yes — fixed by C-1 | Yes |
| **C-3** | `TraceEntry.compacted` is always `false`; trace cannot show which turns a mechanism acted on | No | No — observability |
| **C-4** | No automated check that published numbers match program output; the README's promise is enforced by discipline | No | Yes (process) |

C-2 has no separate fix. It disappears when C-1 lands — the honest figures fall out of the ledger.

## Phase A — enforcement before change (no numbers move)

1. **C-4** — `--check` mode plus CI.
   - `npm run research -- --check` re-runs the pipeline, compares the emitted
     `research-results.json` against the committed file, and exits non-zero on drift.
   - Comparison is structural (same keys, same values) with a tolerance for float formatting.
   - GitHub Actions workflow: `tsc --noEmit`, the test suite, and `--check`.
   - Land this **before** touching the ledger, so the first regeneration is the last one a human
     has to remember.
   - Bundle the CLI ergonomics from the proposals here (`--only`, `--json`) since both touch the
     same argument path — but only if it costs no extra risk; `--check` is the load-bearing part.

⬇️ **Checkpoint: drift is now a CI failure, not an audit finding.**

## Phase B — the cost model (every number moves)

2. **C-1** — real cache accounting in `ScriptedModel.usage()`.
   - Track the previous request's message list on the model.
   - Compute the longest common prefix by message content; bill it at `cacheReadPerMTok`.
   - Bill the appended delta once at `cacheWritePerMTok`.
   - Bill any remaining non-prefix content (compaction rewrites, substitution) at `inputPerMTok`.
   - `UsageMeter`, `usageCost`, and `totalTokens` are unchanged — they already handle the fields.
   - Add a test asserting cache usage is non-zero on the long-horizon task and that a request
     identical to the previous one bills at the read price only. **This test is what would have
     caught C-1.**

⬇️ **Freeze point: every published number regenerates here. Do not edit artifacts by hand.**

3. **C-2** — no code change. Re-run, re-diff, and confirm the measured ranking shift:
   ObservationPack's saving should fall, the reducer's should hold. If it does not, the ledger is
   wrong, not the mechanism — stop and re-derive.
4. **C-3** — set `compacted` true when `transformContext` actually changes the message list, with
   before/after token counts in `note`. Add the trace test.

## Phase C — artifacts (only after the new freeze)

5. Regenerate `research-results.json`, the README sample output, and the explainer tables from the
   new ledger. Every figure is expected to move — that is the point, not a problem.
6. **Update the narrative, not just the numbers.** The README and explainer both credit the
   "large-object mechanisms" collectively. Under honest accounting the reducer carries the saving
   and ObservationPack's contribution is smaller than implied. Say so. Also re-check the
   long-horizon pill (N-2's fix) against the new figure.
7. Re-run the AUDIT-3 probe (LCP measurement) against the new ledger and record the corrected
   table in `AUDIT-3.md` as a status note, so the before/after is documented in one place.

## Deferred

- **Reducer receipt cache** — legitimate, small, safe. Bundle if Phase B goes cleanly; otherwise
  it carries no urgency and does not touch any published number.
- **Reducer recall tool** — rejected (see `AUDIT-3.md` Part 2).
- **Pluggable token estimator** — deferred; the disclosure in the README covers the honesty angle
  and the seam adds maintenance for no current user.

## Publish bar

1. Cache usage is non-zero and tested; the compaction gate's decision is observable in the ledger.
2. `--check` passes in CI against the regenerated JSON.
3. Every published figure regenerated from the new ledger, with the narrative updated to match the
   corrected ranking.
4. `npm test` and `npm run typecheck` clean.

## Not in scope

No mechanism behaviour changes. Compaction still fires on the same rule; ObservationPack still
substitutes on the same schedule; the corpus and acceptance rule are untouched. Only the ledger
changes — which is precisely why the numbers move.

---

## Status after Phase A (2026-10-05)

The enforcement layer landed before any number moved, as the sequencing required.

### `--check` is a real guard, not a flag

The first implementation was vacuous and I caught it only by testing it: `--check` read
`research-results.json` *after* the run had overwritten it, so it always compared fresh output
against itself and reported "matches" unconditionally. Perturbing the committed file returned exit
0. The fix captures the committed file **before** the write. Re-tested the same way: a perturbed
file now exits 3 and names the drifted paths exactly:

```
check FAILED: 2 field(s) drifted from the committed file:
  /table/4/cost: 1.55 -> 1.9399559999999998
  /activation/base: missing, now {"turns":21,"tokens":3323869,"cost":6.663138}
```

The comparison is structural on parsed values rather than textual, so float formatting (`1.0` vs
`1`) is not a spurious failure — the same tolerance that makes the check trustworthy also makes it
usable as a development command rather than a ceremony.

### CI is wired and installable

`.github/workflows/ci.yml` runs typecheck, the suite, and `--check` on Node 22. Wiring it exposed a
latent problem: `package.json` declared **no dependencies at all** while `package-lock.json` carried
`tsx`, `typescript`, and `@types/node` marked `dev: true`. `npm ci` would have failed on the first
CI run. The manifest now declares them at their locked versions, and `npm ci --dry-run` resolves 45
packages cleanly.

### Probe kept as an artifact

`probes/measure-cache-prefix.ts` is committed (imports rewritten to relative paths, verified to run
from the repo) so the LCP measurements in `AUDIT-3.md` are re-derivable rather than cited.

### Where things stand

Typecheck clean, 41/41 tests pass, `npm run check` exits 0 against the committed JSON. The numbers
have not moved yet — Phase B has not started. When it does, `--check` failing is the expected and
desired signal that the artifacts need regenerating.

## Status after Phase B and Phase C (2026-10-05)

Phases A, B, and C are complete. Every published number was regenerated from the program; none was
hand-edited.

### Phase B — the ledger

`ScriptedModel` now bills three quantities per request: the longest common prefix with the previous
request at the read price, the appended tail at the write price, and anything a mechanism rewrote
mid-context at the full input price. `usage()` subtracts the two cache fields out of `input`, so
the four fields still sum to the request without double counting. This is the only place the
mechanism behaviour changes — and it changes nothing about the mechanisms, only what they cost.

The C-2 prediction was confirmed by the run, not just by the probe. `+online-compact`'s cost *rose*
($6.27 -> $7.11) and its saving fell 33.7% -> 12.3%, because its rewrite is now billed.
`+evidence-reducer` held at ~96.8%. The reducer acts before the observation reaches the context, so
the receipt *is* the original and the prefix survives; ObservationPack substitutes in place, so it
does not.

### Two more instances of the same bug class

The `input + output` idiom stopped meaning "request size" the moment the cache fields were
populated. It had been used in three places. `cli.ts`'s activation block was fixed during Phase B;
`TraceEntry.requestTokens` and the compaction test were found by the failing suite and fixed during
C-3. All three now use the whole request. The suite is the reason the last two surfaced — which is
the argument for having made the ledger change behind the tests rather than alongside them.

### C-3

`compacted` is now true when `transformContext` returns a different message list, carrying
before/after token counts in `note`. Verified non-vacuous by reverting the flag to a constant and
watching the new test fail. Measured: baseline 0 rewrites, OnlineContextCompact 4,
ObservationPack 12 on the long-horizon task.

### Phase C — artifacts

`research-results.json`, the README sample block, and the explainer's table, headline stat,
long-horizon pill, and bar chart were regenerated. The bar chart's order changed:
sol-pi[performance] (39.6%) and +online-compact-tight (37.9%) swapped places.

The narrative was updated rather than just the numbers. Both artifacts now say plainly that the
substituting mechanisms shrink once rewrite cost is billed and that the reducer carries the saving —
the conclusion the audit reached, now stated where a reader will see it.

### A second guard, found while writing the first one

`--check` proves the JSON is reproducible, but nothing proved the README and the explainer actually
quoted it — the hand-transcription drift that C-2 was about. Writing the cross-checker exposed two
real defects in the artifacts it was meant to guard: the explainer's baseline row had lost its
`<td>` wrapper around the em-dash, and its `vs. base` column was unsigned while the bar chart used
a typographic minus. `probes/check-artifacts.mjs` now covers all 8 table rows in both artifacts, the
headline stat, the long-horizon pill, and all 7 bars, and runs in CI alongside `--check`. Verified
by perturbing a README figure and watching it fail.

### Publish bar

1. Cache usage is non-zero and tested. :white_check_mark:
2. `--check` passes against the regenerated JSON. :white_check_mark:
3. Every published figure regenerated, narrative updated to the corrected ranking. :white_check_mark:
4. `npm test` and `npm run typecheck` clean — 44/44, no errors. :white_check_mark:
