# SoL-Pi — Remediation Plan, Round 4

**Date:** 2026-10-14
**Basis:** the deferred residuals of `AUDIT-2.md` and `AUDIT-3.md`. Eight findings: L-1, L-9
(residual), L-12 (residual), L-13, L-15, L-17, L-18, L-20.

Round 2 deferred these deliberately and round 3 did not touch them. Round 4 closes the set. None
of the eight is a user-facing claim the program contradicts — that class of defect was closed in
rounds 1–3 and stays closed — but two of them (L-1, L-13) are about the harness's contract with a
real provider, and L-13 is what makes the published cost figures honest, so both were load-bearing
the moment a non-scripted backend was attached. That moment arrived when the provider seam landed.

## What moved and why

| | Finding | Where | Moves published numbers? |
|---|---|---|---|
| **L-1** | A compaction injects `role:"user"` between the head and the tail, so the tail can start with tool results no assistant turn answers — every major provider rejects that | `online-compact.ts:185`, flattened in `live-model.ts:53` | No |
| **L-9** | Dead code the round-1 table claimed deleted and was not | `usage.ts`, `evidence-reducer.ts:1` | No |
| **L-12** | `scriptFor` declares a third `model` parameter every call site ignores, so the seam between script and model is untyped in practice | `loop.ts`, `cli.ts` | No |
| **L-13** | One `ScriptedModel` shared across every task, candidate, and the held-out run | `loop.ts` | **Yes — every cost figure, a fraction** |
| **L-15** | An empty file is indistinguishable from a missing one | `environment.ts`, all three backends | No |
| **L-17** | An unsupported flag reads as an unknown command, so the model switches tools instead of retrying without the flag | `environment.ts` | No |
| **L-18** | A module-global `callSeq` mints ids that are unique process-wide but interleaved across environments and grow forever | `environment.ts`, `harness.ts` | No |
| **L-20** | The partition assertion is a tautology: every candidate lands in `retained` or `rejected` by construction | `research.test.ts` | No |

Only L-13 moves numbers, and only a fraction, because the scripted model's prefix-cache accounting
compares each request against the previous one. One shared backend carried that state across task
boundaries, so the first request of every new conversation after the first was billed against the
tail of the one before it. A factory that builds a model per task makes each conversation start
with no prefix — which is what the harness actually does to a real provider.

L-1 has no separate source change: the fix is the provider seam's `flatten`, which reconstructs the
assistant turn a run of tool results answers from the tool messages' own `callId`/`name`/`args`.
Round 4 supplies the proof that was missing, and found it in the place the audit predicted: a real
compaction inside a real run, not a hand-built message list.

## The fixes

### L-1 — the compacted wire stays well-formed under a real run

`tests/providers.test.ts` drives a `LiveModel` over a scripted `ChatProvider` with
`OnlineContextCompact` attached and a context window tight enough to force compaction, then asserts
on the **actual requests the provider received**: every run of consecutive `tool` messages is
preceded by one assistant turn whose `toolCalls` carry exactly the run's ids, in order, in the same
count. A result dropped to `role: "user"` (the malformed-wire failure mode) breaks both the
alternation and the count, so the assertion catches it either way. The test also asserts the run
really did compact (`res.trace.some(t => t.compacted)`), so the proof cannot pass vacuously on a
run that never exercised the path. Verified non-vacuous by breaking `flatten` and watching the test
fail.

### L-13 / L-12 — the loop owns no model state

`SearchOptions.model` changed from `ModelBackend` to `() => ModelBackend`, and `evaluate()` now
calls it once per task evaluation. The held-out path takes the same factory. This is the same
narrowing as L-12's: `scriptFor` dropped its third `model` parameter — the one every call site
ignored — and `cli.ts` now passes `scriptFor` directly instead of wrapping it in a lambda that
threw the argument away. The seam between script and model is now honest in the type system.

The proof is `tests/research.test.ts`: the factory records every construction, and the test asserts
9 distinct instances for (1 baseline + 2 candidates) × 3 tasks — one fresh model per evaluation,
never a handed-back shared one. Verified non-vacuous by reverting to a single shared model and
watching the test fail.

### L-15 — missing is not empty

`Environment.readFile` now returns `string | undefined`, and every backend implements the same
contract:

- `SimulatedEnvironment` returns `undefined` when `Object.hasOwn` is false, and the real `""` for
  an existing empty file.
- `LocalEnv` and `ClientEnv` map a failed read to `undefined`; the client backend's comment states
  the wire contract explicitly — a host that cannot or will not supply the file reads as missing,
  while a file it supplies as empty arrives as a real `""`.
- `Harness.editFile` gained the missing-file branch it never had: `edit_file: no such file: <path>`
  instead of the misleading `old string not found` for a file the model never read.
- The fakes and the real host had to be corrected too, because a fake that answers `""` for a
  missing file cannot be distinguished from an honest one: `tests/env.test.ts`'s `FakeClient` now
  throws on a missing file, and both `tests/agent.test.ts`'s fake host and `probes/host.ts`'s real
  host now let `readFileSync` fail rather than catching it into a lie. The probe is the only place
  the client-side half of the contract runs against a real subprocess, so it carries the contract
  too.

Proved in all three backends by the same pair of assertions: `readFile` on a missing path is
`undefined`, on an existing empty file is `""`, and `cat` of each behaves accordingly. The inherited
-key test was retargeted from "returns empty" to "reads as missing", since `toString` is not a file.

### L-17 / L-18 — ids and flags are scoped, and the tool name is shared

The module-global `callSeq` is gone. In its place, `CallIdSource` — one per `Environment` instance,
reset in `reset()` — mints the ids for calls nobody dispatches an id into, and `Harness` holds its
own counter restarted in `begin()`, because two harnesses sharing one counter would interleave
their ids and a handle like `obs:call_7` is only meaningful inside the run that minted it. Ids are
now per-run and per-environment: the second run of the same harness restarts at `call_1`, and two
environments in one process each start at `call_1`.

The flag fix is one branch in the simulated shell: a command whose leading word the vocabulary
recognizes but which carries a flag now reports `unsupported flag: --verbose (the simulated shell
has no flag handling)` instead of `command not found`, so the model can retry without the flag
rather than switching tools. `leadingWord` moved from `agent/shell.ts` into `core/environment.ts`
(with the shell re-exporting it) so the simulated world and the live backends derive the tool name
the same way — the reducer's allowlist matches this word exactly, and the two worlds cannot be
allowed to drift apart.

Both are proved by the ids test above (per-run, per-environment, restart on `reset`) and a flag test
that asserts the tool attribution is the tool that was asked for.

### L-9 / L-20 — the residuals the previous plans claimed were already closed

- **L-9.** `UsageMeter.perRequestUsage` and the unused `rates` parameter on `UsageMeter.tokens()`
  are deleted (the getter exposed internal state nothing read; the method was a second spelling of
  `cost`), and the unused `excerpt`/`estimateTokens` import in `evidence-reducer.ts` is gone — the
  small irony the audit noted, where the round-1 fix turned a re-export into an unused import.
- **L-20.** The summary's retained/rejected partition is now proved against the acceptance gates
  **recomputed from the recorded results**: the test reads `loop.getResults()`, runs
  `capabilityGate`/`efficiencyGate` on each candidate against the baseline, and asserts the summary's
  `rejected` list is exactly the candidates the recomputed gates fail and the `retained` list is
  exactly `loop.nondominated(...)` of the gate-passing ones. Verified non-vacuous by inverting the
  filing branch in `run()` and watching the test fail — the old identity survived that mutation
  untouched.

## The published numbers, re-frozen and re-diffed

L-13 moved every figure a fraction, because a per-task model bills the first request of each
conversation with no inherited prefix. The direction is not uniformly favourable: baseline traffic
and every candidate's traffic rose slightly, so most savings *shrank* by 0.0–0.2 points.

| id | cost (was) | cost (now) | saving vs. baseline (was) | (now) |
|---|---|---|---|---|
| pi-baseline | $8.1040 | $8.1102 | — | — |
| +action-fusion | $8.1103 | $8.1200 | −0.1% | −0.1% |
| +online-compact | $7.1102 | $7.1176 | 12.3% | 12.2% |
| +evidence-reducer | $0.2601 | $0.2676 | 96.8% | 96.7% |
| +observation-pack | $3.8728 | $3.8827 | 52.2% | 52.1% |
| sol-pi[efficiency] | $1.5496 | $1.5617 | 80.9% | 80.7% |
| sol-pi[performance] | $4.8914 | $4.9012 | 39.6% | 39.6% |
| +online-compact-tight | $5.0303 | $5.0378 | 37.9% | 37.9% |

The reducer's own cost rose 2.9% relative (0.2601 → 0.2676) on the smallest base in the table, which
is what turns its 96.8% into 96.7%. The long-horizon activation block is essentially unchanged —
the reducer still saves 97.7% on the long-horizon task, ObservationPack 69.5%, OnlineContextCompact
22.4% — and **the ordering, the retained set, the held-out inputs, and the acceptance rule did not
move at all.** The held-out saving moved 95.7% → 95.5% on the same shift.

As in round 3, the numbers moved deliberately, and the regeneration went through the guard that
round added: `npm run check` re-runs the pipeline and compares against the committed file, and
`npm run check-artifacts` cross-checks the README and the explainer against it — all 8 table rows
in both artifacts, the headline stat, the long-horizon pill, and all 7 bars. Both pass against the
new JSON.

## Publish bar

1. All eight findings closed, each with a test that fails when the fix is reverted. ✅
2. `npm run check` passes against the regenerated JSON. ✅
3. `npm run check-artifacts` passes — every published figure matches the JSON. ✅
4. `npm test` and `npm run typecheck` clean — 150/150, no errors. ✅
