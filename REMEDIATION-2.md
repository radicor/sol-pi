# SoL-Pi — Remediation Plan, Round 2

**Date:** 2026-10-05
**Basis:** `AUDIT-2.md`. Four new findings (N-1…N-4) plus carried-forward test gaps from the first
audit. Each finding below was reproduced with a probe before being included.

## The sequencing principle this time

`REMEDIATION.md`'s freeze point existed because hand-transcription was the failure mode. That is
solved: `research-results.json` is the single source and the artifacts were generated from it. The
risk this round is narrower but real — **two of the four findings touch id allocation**, and the
`obs:call_N` handle is the one place an id lands inside message *content*, so an id shift can
perturb token traffic even though callIds ride in a separate field.

So the rule is the same shape: **fix everything that could move a number, re-run, and only then
touch the artifacts.** Re-validation is a diff now, not an audit — that is what makes the freeze
cheap instead of fragile.

## What is actually on fire

Of the four, three block external publication and one is consistency:

| | Finding | Moves published numbers? | Blocks publication? |
|---|---|---|---|
| **N-1** | `recall_observation` returns constant `callId: "recall"` — the M-2 defect, reintroduced by the H-4 fix | No (the scripted policy never calls it) | Yes — a real provider rejects duplicate ids |
| **N-2** | Explainer labels the 6-task search aggregate (−79.5%) as a long-horizon figure (measured: −85.6%) | No — copy only | Yes — same class as M-15 |
| **N-3** | Explainer says the prototype reproduces the paper's Opus 5 transfer signature; no second backend is ever run | Depends on the fix chosen | Yes — unsupported claim |
| **N-4** | The per-call id is discarded by `read_file`/`run`, whose results carry the shell counter's id | **Maybe** — handle strings shift | No |

N-4 is the only one that could move numbers, and only via handle length. Same digit count in every
case I traced, but *traced* is not *verified* — hence the gate below.

## The decision that needs a human

N-3's recommended fix was "run a second backend, or drop the clause." Running it is the better fix
and matches how round 1 handled the analogous choices (it wired the tool rather than retracting the
promise, and fixed the dead code path rather than deleting it). But there is a trap: `ScriptedModel`
ignores its `id` for behaviour, so a second backend with the same script and window produces
**byte-identical** results — a renamed run dressed as a transfer, which is precisely the defect
this audit has been hunting. A real transfer needs a genuine behavioural difference. The candidates:

- **Context budget.** Opus 5 at 1M vs GPT-5.6 Sol at 200k. Same policy, different window.
  `OnlineContextCompact` is the only mechanism that reads the window, so trigger rates genuinely
  differ — a real, mechanistically explainable instance of "mechanisms trigger less often on the
  unseen backend." Cheap and honest.
- **Policy shape.** A backend that does *not* batch the write and the run in one turn. This is the
  faithful simulation of the paper's setup and has a side benefit: it gives Action Fusion actual
  work to do, where the current corpus admits it measures ~0%. More faithful, more invented.

Retracting the clause is always safe. Expanding the experiment is only better if the simulation is
defensible — and that is a modelling call, not an engineering one.

## Phase A — code (could touch numbers)

1. **N-1** — thread the harness-allocated id into `resolveTool` and use it in the recall result.
   Interface change: `resolveTool?(name, args, callId)`. Two lines in `observation-pack.ts`.
2. **N-4** — `Environment.run(command, callId = nextCallId())`; the two delegating branches pass the
   id through instead of letting the shell mint its own. Also removes the allocate-and-discard that
   currently advances the counter once per shell call.

⬇️ **Gate: re-run `npm run research` and diff against the committed `research-results.json`.**
If every figure is unchanged, numbers stay frozen and the artifacts can be edited. If anything
moved, that is itself a finding — stop and account for it before proceeding.

## Phase B — hardening and test gaps (numbers unchanged)

3. **N-1 regression test** — two `recall_observation` calls in one turn must get distinct ids. This
   is the test whose absence let N-1 ship; the round-1 M-2 test only covered base tools.
4. **L-14 (the other half)** — a model that returns zero calls with `stopReason: "error"` must
   produce exactly one trace entry, and `max_turns exhausted` must be distinguishable from
   `incomplete`. M-7's fix currently has no test.
5. **L-19 (the other half)** — the two `ObservationPack` tests still call the pass-through
   `transformResult` and assert `archived === 0`, which is true regardless of the logic under test.
   Rewrite them against `projectObservation` + `transformContext` so they can fail.
6. **L-21 (the other half)** — drop the remaining `never[]` / `as never` casts in
   `tests/mechanisms.test.ts`.
7. **L-10** — clear `generations` in `AutoResearchLoop.run()`. Same shape as the M-5 fix that *was*
   made, and the one carried-forward item the first remediation never mentioned.

## Phase C — artifact truthfulness (only after the gate)

8. **N-2** — correct the ObservationPack pill to the measured long-horizon figure.
9. **N-3** — per the decision above: either implement the transfer run and report its real numbers,
   or remove the clause and say plainly that the prototype runs a single backend.

## Deferred again, deliberately

- **L-1** (compaction breaks role alternation) and **L-13** (one shared `ScriptedModel`) — both are
  about the contract with a real provider. Both stay latent until a non-scripted backend exists, and
  L-13's fix is a prerequisite for any parallelism. Add the code comment the first plan promised but
  did not write.
- **L-15** (empty file indistinguishable from missing), **L-17** (unsupported flags),
  **L-18** (process-wide `callSeq`) — cosmetic in a simulated shell. Note that N-4 *reduces* L-18's
  effect by removing the wasted allocation, but does not fix the cross-instance sharing.
- **L-20** — the partition assertion stays; it is a tautology by construction and rewriting it adds
  no signal.

## Publish bar

1. Two recalls in one turn get distinct ids, with a test.
2. `npm run research` figures unchanged after Phase A — verified by diff, not by eye.
3. The explainer's ObservationPack pill and transfer claim both backed by a run, or both retracted.
4. `npm test` and `npm run typecheck` clean.

## Not in scope

No mechanism behaviour changes, no corpus changes, no changes to the acceptance rule or the price
table. Anything that would move a measurement is out of bounds this round.

---

## Status after implementation (2026-10-05)

All three phases landed. `npm run typecheck` is clean, the suite went **38 → 41 tests**, all
passing, and `npm run research` is still byte-identical across runs.

### The freeze held

`research-results.json` was diffed against the pre-fix version after every phase. The diff is
**strictly additive** — the search table, the gate outcomes, the held-out verdict, and every
activation figure are unchanged. The only new entries are the ones round 2 deliberately added
(a `base` row under `activation` and a `costSaved` field per mechanism). Nothing moved, so the
README sample output and the explainer's result table needed no regeneration.

### What changed

| Finding | Fix | Effect on published numbers |
|---|---|---|
| N-1 | `resolveTool` now receives the harness-allocated `callId` and both recall branches carry it; interface comment states the invariant | None — the scripted policy never calls `recall_observation`, so the search runs never exercised this path |
| N-4 | `Environment.run` accepts a `callId`; `read_file` and `run` pass the id they were given instead of discarding it | **Verified unchanged.** This is the one fix that could have shifted the `obs:call_N` handles and with them the traffic figures; the diff proves it did not |
| N-2 | The activation block now runs a no-mechanism baseline and emits `costSaved` per mechanism, so the long-horizon delta is program-generated; the explainer pill reads −85.6% | Additive only. The −79.5% figure the pill replaced was the 6-task search aggregate mislabelled as long-horizon; the search table's own −79.5% row is untouched and correct |
| N-3 | The clause claiming the prototype reproduces the paper's Opus 5 transfer signature is removed, replaced by a callout stating plainly what the prototype does *not* show | None — a retraction, not a measurement |
| L-19 (half), L-21 (half) | The two pass-through `ObservationPack` tests now exercise `projectObservation`; all `never`/`as never` casts removed from the suite | None |
| L-14 (half) | A `StoppingModel` backend emits the stop reasons `ScriptedModel` never can, covering the single-trace-entry rule and the `max_turns exhausted` vs `incomplete` distinction | None |
| L-10 | `generations` is cleared at the top of `run()` | None |

### The test that would have caught N-1

"two recall_observation calls in one turn get distinct call ids" was verified non-vacuous the
hard way: reverting both `callId` literals to `"recall"` makes it fail with *"two recalls in one
turn must not share an id"*, and re-applying the fix makes it pass. Its first draft was vacuous —
the recalls were failing silently because `reset()` clears the archive between runs, and the
hardcoded `obs:call_1` handle is not stable since the id counter is process-global (L-18). The
final version reads the handle out of the live archive instead.

### One decision made, and why

N-3's fix was "run a second backend, or drop the clause." The retraction was chosen.
`ScriptedModel` ignores its `id` for behaviour, so a second backend with the same script and
window would have produced byte-identical results — a renamed run dressed as a transfer, which
is the same class of defect the audit exists to hunt. A defensible simulation needs a policy
that genuinely differs, and that is a modelling call rather than an engineering one. The
replacement callout says what the prototype does show — harness-layer effects with the model held
constant — and names it as a different claim from the paper's transfer result.

### Still deferred

L-1, L-13, L-15, L-17, L-18 and L-20 remain open for the reasons given above. L-18 is worth
restating: N-4 reduced its impact (the shell no longer advances the counter once per call) but
the counter is still process-global, which is what made the recall test's first draft vacuous.
It becomes load-bearing the moment two harnesses run in one process.

