# SoL-Pi — Comprehensive Audit Report

**Date:** 2026-10-04
**Scope:** `src/` (14 TS modules, ~1,500 LOC), `sol-pi-explainer.html` (468 lines), `tests/` (24 tests).
**Status of code at time of audit:** unmodified. All findings were verified with throwaway probes that were deleted afterwards; `git status` was unchanged before and after.

**Method:** full read of every file, then empirical verification of each hypothesis against the running
system (`npm run research`, `npx tsx` probes, numeric contrast math, CSS grid arithmetic). Findings below
are marked **Confirmed** only where command output backs them.

## Scope clarification (stated up front, not padding)

This is an **offline CLI research prototype plus one static HTML artifact**. It has no HTTP server, no
database, no session/cookie handling, no authN/authZ, no multi-tenancy, no CORS policy, no storage
buckets, no webhooks, and no outbound network calls. Requests to audit CSRF, SSRF, SQLi, insecure direct
object references, privilege escalation, CORS, token storage, and localStorage **have no applicable
attack surface** and none are reported speculatively.

The two real trust boundaries and surfaces that *do* exist are:

1. **Model output → harness** (`ToolCall.args`, unvalidated, crossing into `Environment`/plan state).
   This is where the genuine robustness and security findings are.
2. **The static explainer artifact** (rendered UI, accessibility, visual consistency, numeric accuracy).

`Environment.run` is a simulated command vocabulary with **no `child_process`, no `exec`, no filesystem**
— every command dispatch path was checked. There is no command injection, no path traversal, and no SSRF
surface. `cat ../../etc/passwd` returns `No such file` from an in-memory map.

---

## Verified clean (checked adversarially, no finding)

Reporting these so the list isn't read as uniformly negative:

- **No XSS sink in the explainer.** No `innerHTML`, `document.write`, `eval`, `new Function`, or
  `insertAdjacentHTML`. The only script is a four-line theme setter reading `URLSearchParams` with an
  explicit `=== "light" || === "dark"` allowlist. No template injection, no unescaped interpolation.
- **Colour contrast passes WCAG 2.2 AA (1.4.3) in both themes.** 28 token pairs computed: worst case is
  `--purple` on the light isolation background at **4.51:1** (needs 4.5); next worst are
  `--accent2` / `--warn` / `--purple` on `--bg-soft` at 4.73–4.88:1. Body text is 15.8–16.0:1.
- **Heading hierarchy is correct.** Sequence `1,2,2,2,2,3,3,3,3,2,3,3,3,2,2` — no skipped levels.
- **Viewport scaling is not disabled.** `width=device-width, initial-scale=1.0`, no `user-scalable=no`
  (WCAG 1.4.4 compliant).
- **`npm test` works as documented.** The `tests/**/*.test.ts` glob resolves under `tsx`; 24/24 pass.
- **Unknown tools are not silently dropped.** The harness returns a typed `unknown tool: X` error result.

---

# CRITICAL / HIGH

## H-1 · Model-supplied `then_run` is unvalidated and crashes the whole process

**Severity:** High · **Category:** Reliability / Security (trust boundary) · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:264-291` (`write_file`) and `:293-320` (`edit_file`), consumed from
`call.args.then_run`.

**Issue:** `const runAfter = (call.args.then_run as string[] ?? [])` is a *cast*, not a validation. A bare
`as string[]` annotation compiles but asserts nothing. If the model emits `then_run` as a string,
`runAfter.length` is truthy and `runAfter.map` throws; if entries are non-strings, `env.run(c)` calls
`command.trim()` on a number.

**Impact:** `TypeError` propagates out of `Harness.run()`. In `cli.ts` the trailing
`main().catch()` does catch it and `process.exit(1)`s, but in the `AutoResearchLoop` path it aborts the
entire search mid-run with no partial results, no trace dump, and no indication of which candidate
failed. Any real (non-scripted) backend that emits a malformed `then_run` — a schema violation, a
truncated streaming response, or a model that writes `"then_run": "npm test"` instead of `["npm test"]` —
kills the run.

**Evidence:**

```
B) then_run as bare string CRASH: TypeError: runAfter.map is not a function
C) then_run:[123] CRASH: command.trim is not a function
```

**Reproduction:** Load a `ScriptedModel` with
`[{tool:"write_file", args:{path, content, then_run:"test"}}]` and ActionFusion enabled; call
`harness.run()`.

**Recommended fix:** Validate at the boundary with a type guard before use:

```ts
const raw: unknown = call.args.then_run;
const runAfter = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
```

Apply in both `write_file` and `edit_file`. Better: validate the whole `ToolCall.args` against the JSON
Schema already declared in `baseTools()` before dispatch, so unknown tools get a typed error result
instead of a throw.

---

## H-2 · `update_plan` accepts any `steps` value and crashes on the next turn

**Severity:** High · **Category:** Reliability / Security (trust boundary) · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:335-338` (`case "update_plan"`), consumed at
`src/core/harness.ts:196-201` and `src/mechanisms/online-compact.ts:88,142`.

**Issue:** `const steps = (call.args.steps as PlanStep[]) ?? []; if (steps.length) this.plan = steps;`
assigns the model's value straight into `Harness.plan` with no shape check. `this.plan` is later assumed
to be an array of `{id,title,status}` by every mechanism.

**Impact:** A model emitting `"steps": "not-an-array"` stores a string in `Harness.plan`. Every
downstream consumer (`.filter`, `.map`, `s.status === "done"`) throws. This is a **poisoned-state** bug:
the corruption is silent at write time and detonates one turn later, far from the cause, so the traceback
points at `online-compact.ts` rather than at the malformed tool call.

**Evidence:** `3) update_plan(non-array) CRASH: TypeError: this.plan.filter is not a function`

**Recommended fix:** Narrow before assignment — `if (!Array.isArray(steps)) return errorResult(...)` —
and coerce each element to a `PlanStep` with a validated `status` in
`{"pending","in_progress","done"}`. Return a `ToolResult` with `exitCode: 1` so the model can
self-correct rather than crashing the loop.

---

## H-3 · The Evidence-Preserving Reducer never reduces anything — and the docs say it does

**Severity:** High · **Category:** Reliability / Visual Consistency (claims integrity) · **Confidence:** Confirmed

**Location:** `src/mechanisms/evidence-reducer.ts:88-91` (the `interesting` regex); failure surfaces at
`:170` (`if (receipt.quotes.length === 0) return false`).

**Issue:** The extractor builds `quotes` only from lines matching `interesting`. That regex has three
alternatives, and **none of them match the corpus's own build logs**:

- branch 1 requires the first non-underscore char to be `[A-Za-z]`
- branch 2 requires `E\s` or a bare exception class name at line start
- branch 3 requires `_{5,}`

Every line produced by `bigLog()` in `src/tasks/corpus.ts:17-26` starts with `[` — `[dep 000] pytest: …`,
`[warn] …`, `[summary] …`. Zero matches → `quotes = []` → `verify()` returns `false` at the empty-evidence
check → unconditional fallback to the original log. The reducer is a 100% no-op on the shipped corpus.

**Impact:** A headline mechanism in the README and the explainer contributes exactly zero savings. The
search loop is self-consistent (`+evidence-reducer` is REJECTed at 0.0%), but the narrative around it is
not:

- `sol-pi-explainer.html:349`: *"the large-object mechanisms (ObservationPack, Evidence-Preserving
  Reducer) dominate savings on log-heavy tasks"* — **false**; the reducer saves 0 bytes.
- `README.md:86-90` presents the reducer as working end-to-end.

**Evidence:**

```
EvidencePreservingReducer  turns=21 tokens=3,324,269 cost=$6.667 stats={"reduced":0,"fallbacks":15,"savedBytes":0}
```

And directly: `SimpleExtractor` at every fidelity (1.0, 0.5, 0) returns **0 quotes** for a log of
`Error: failure N` lines.

**Reproduction:** Construct `SimpleExtractor(1)` over `bigLog("pytest")` and inspect `quotes.length` —
returns `[]`.

**Recommended fix:** Two parts. (a) Make the extractor match the logs it claims to handle: anchor on
log-structured tokens rather than line-start letters, e.g. also match `\b(FAILED|Error|error|warning)\b`
anywhere in the line, plus the `\[summary\] …` and `N passed, M failed` forms the harness actually emits
(`environment.ts:118`). (b) Add a regression test that runs the reducer over `bigLog()` output and asserts
`stats.reduced > 0` — the current test only uses a hand-built log that *does* match, which is why the bug
survived. Then correct the explainer copy.

---

## H-4 · ObservationPack's on-demand recall is unreachable from the agent

**Severity:** High · **Category:** Reliability (feature/claim mismatch) · **Confidence:** Confirmed

**Location:** `src/mechanisms/observation-pack.ts:104-112` (`recall`), `:114-117` (`has`); tool schema at
`src/core/harness.ts:107-160`.

**Issue:** `recall(handle, page?)` exists and is correct, but **no tool exposes it**. `Harness.baseTools()`
returns only `read_file`, `write_file`, `edit_file`, `run`, `update_plan`. Grep across the repo confirms
`recall(` and `has(` are referenced **only in `tests/mechanisms.test.ts`**.

**Impact:** The mechanism substitutes a large observation down to `obs:call_N (archived, 75400 bytes)`
plus a 1 KiB excerpt, and tells the model *"[recall the exact original with the handle above]"* — but the
model has no way to act on that instruction. Every archived observation is **irrecoverably truncated for
the rest of the run**. This is worse than not archiving at all: the harness has discarded evidence and
told the model it can get it back.

**Evidence:** `sol-pi-explainer.html:311-312` — *"The agent recalls exact pages through the handle on
demand."* `README.md:81-83` — *"The exact original is recoverable through the handle."* Neither is true at
runtime.

**Recommended fix:** Add a `recall_observation` tool (`{handle, page?}`) to `baseTools()`, and wire
`ObservationPack` to serve it via a mechanism-provided resolver. If that is out of scope, change the
substituted text to say the content is *not* retrievable and stop archiving — do not leave the false
affordance in the prompt.

---

## H-5 · Fused mutation is not atomic — the write persists when the follow-up command fails

**Severity:** High · **Category:** Race Condition / Reliability (state integrity) · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:263-266` (`env.writeFile(path, content)`) executed unconditionally
*before* the `then_run` loop at `:268-286` and `:299-322`.

**Issue:** Action Fusion is billed as "3 calls → 2" — collapsing two calls into one. But the two calls it
replaces are not actually atomic. `writeFile` mutates `Environment.files` first; the `then_run` commands
execute after; on failure the code returns `exitCode: 1` but **never rolls the write back**.

**Impact:** The environment ends in a state where the mutation is applied but the tool reported failure.
This is exactly the "failure path that leaves data inconsistent" case: a model that trusts `exitCode: 1`
will retry the write, or a scoring run silently banks a fix whose verification failed. In the fused path
it also breaks the semantic equivalence the mechanism claims — the unfused two-call sequence would have let
the model observe the failed command *before* the write landed.

**Evidence:**

```
F) after a FAILING then_run, file content = "def add(a, b):\n    r" (rolled back? false)
   env score = 1 -> mutation persisted despite exitCode 1
```

**Reproduction:** `write_file` with `then_run: ["nonexistent-cmd"]` on `REPO_TASKS[0]`. The write
succeeds, the command fails, `exitCode` is 1, and `env.score()` is 1.

**Recommended fix:** Snapshot the prior file content (and, if `then_run` is generalised, the whole file
map) before mutating; restore on any non-zero `exitCode`. Alternatively, execute `then_run` in a scratch
copy and commit on success — which also makes the fused call genuinely atomic with respect to the model's
observation.

---

## H-6 · Capability gate passes any candidate when the baseline scores zero

**Severity:** High · **Category:** Reliability (integrity of the core claim) · **Confidence:** Confirmed

**Location:** `src/research/loop.ts:145-147`.

**Issue:** `if (b <= 0) return { pass: c >= 0, reason: "no baseline score" };`. When the baseline
capability metric is 0, **every candidate passes the capability gate**, including one that also scores 0 —
a candidate that solves nothing.

**Impact:** The README's central claim is that *"Metrics and tolerances are fixed before search and are
not under the optimizer's control"* and that this is *"what prevents search from patching task-specific
solutions into the harness."* This branch is precisely the hole that claim describes: a degenerate
baseline converts the gate into a rubber stamp, and since a broken candidate will usually use *fewer*
tokens, it then clears the efficiency gate too and is retained.

**Evidence:**

```
1) capability gate, baseline=0 candidate=0 -> {"pass":true,"reason":"no baseline score"}
   efficiency gate, baseline=0 candidate=0 -> {"pass":true,"reason":"tokenTraffic -95.0%, cost -90.0%"}
```

**Reproduction:** `loop.capabilityGate({aggregateScore:0,...}, {aggregateScore:0,...},
AutoResearchLoop.defaultAcceptance())`.

Latent today only because the shipped baseline scores 1.000.

**Recommended fix:** A zero baseline must be a hard abort, not a pass:
`if (b <= 0) throw new Error("capability gate: baseline metric is 0; gates are undefined")`. Add a test
asserting a zero-baseline run refuses to gate.

---

# MEDIUM

## M-1 · `Environment.files` is a plain object — prototype-chain lookup returns functions

**Severity:** Medium · **Category:** Security / Reliability · **Confidence:** Confirmed

**Location:** `src/core/environment.ts:30,40,44-46`.

**Issue:** `files` is a bare `{}` (spread of `initialFiles`), so it inherits `Object.prototype`.
`readFile` does `return this.files[path] ?? ""` — for any inherited key the `??` never fires, because the
value is neither `null` nor `undefined`.

**Impact:** `read_file` with `path: "toString"` returns a `ToolResult` whose `stdout` is a **function**,
typed as `string`. Downstream `bytes: stdout.length` yields `1`, `summarizeResult` stringifies it via
`Array.join`, and `headTailCompleteLines` / `estimateTokens` assume string semantics. It is a genuine
type-confusion primitive: agent-controlled input reaches a value that is not of the declared type, and
`Object.prototype` internals are echoed back into the model context.

**Evidence:**

```
1) readFile("toString") -> typeof=function value=function toString() { [native code] }
   cat toString -> function toString() { [native code] }
```

Note: `writeFile("__proto__", …)` with a string value is a no-op in JS, so prototype pollution was **not**
confirmed — `({}).polluted` stayed `undefined`. This is a lookup-confusion bug, not pollution.

**Recommended fix:** `readFile(path) { return Object.hasOwn(this.files, path) ? this.files[path] : ""; }`,
or back the map with `Object.create(null)` / a real `Map`. Apply to `ls` output too (`Object.keys` already
only lists own keys, so it is correct).

---

## M-2 · Hardcoded `callId` literals collide, breaking tool-call correlation

**Severity:** Medium · **Category:** Reliability · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:279` (`"call_write"`), `:310` (`"call_edit"`), `:337` (`"call_plan"`),
`:349` (`"call_unknown"`), and the fused fallback `merged[0]?.callId ?? "call_fused"` at `:281`/`:312`.

**Issue:** `ToolResult.callId` is supposed to identify the `ToolCall` that produced it — that is what lets
a consumer map results back to requests. For mutations, plans, and unknown tools it is a **constant
string**, reused for every such call in the run.

**Impact:** Two `write_file` calls in one turn produce two `tool` messages with the same `callId`. A real
provider rejects duplicate `tool_call_id`s in a request. Within this prototype, `ObservationPack` keys its
archive as `obs:${result.callId}`, so the second write's observation resolves to the first's archive entry.

**Evidence:** `2) tool message callIds: ["call_write","call_write"]  duplicates=true`

**Recommended fix:** Mint the id from the incoming call. Thread a per-call id through
`executeOne(call, callId)` (allocate in `executeCalls`, or have `nextCallId()` be called there) and return it
on every branch. Remove the string literals entirely.

---

## M-3 · `onPlanStepComplete` re-fires every turn for already-completed steps

**Severity:** Medium · **Category:** Reliability / Race Condition (state integrity) · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:262-268`.

**Issue:**

```ts
for (const m of this.mechanisms) {
  for (const step of this.plan) {
    if (step.status === "done") if (m.onPlanStepComplete) m.onPlanStepComplete(step, ctx);
  }
}
```

This runs at the end of **every turn** and iterates **all** done steps, not the step that just completed. A
step marked done on turn 2 fires again on turns 3, 4, 5…

**Impact:** `OnlineContextCompact.onPlanStepComplete` (`online-compact.ts:66-72`) uses this to build
`requestsBetweenSteps` and advance `lastStepRequest`. With a four-step plan and three already-done steps,
one turn produces three spurious samples, and because `Math.max(1, requests)` clamps the intra-turn deltas
to `1`, the running `perStep` average is dragged toward **1 request/step**. That systematically
*underestimates* remaining requests, which underestimates projected savings in the cost gate — the
mechanism's central decision variable is biased toward never compacting.

**Evidence:** `5) onPlanStepComplete fired 6x over 3 tool turns with 2 done steps`

The mechanism also keeps `stepCompletionsSeen`, incremented here and never read.

**Recommended fix:** Track the set of already-notified step ids on the harness (`notified = new Set<number>()`)
and fire only for newly-done steps; or have the loop diff `plan` against the previous turn's plan. Also
delete the unused `stepCompletionsSeen` field.

---

## M-4 · The model-side half of Action Fusion is dead code

**Severity:** Medium · **Category:** Reliability / correctness of reported results · **Confidence:** Confirmed

**Location:** `src/mechanisms/action-fusion.ts:44-49` (writes `then_run` into `parameters.properties`) vs.
`src/core/model.ts:99` and `:125-128` (reads `(t.parameters).then_run` at the **top level**).

**Issue:** The producer nests the parameter under `properties`; both consumers check the top level of
`parameters`. The lookup never matches, so `fusionTool` is `undefined` and `tryFuse` returns early.

**Impact:** `ScriptedModel.tryFuse`, `seenFusionSchema`, and `supportsFusion` are all unreachable. Every
measured Action Fusion saving comes solely from the harness-side `transformCalls`. The README's attribution
is wrong: *"If the harness exposes the fused schema, use it: this is the model-side half of Action Fusion,
and is what generates the measured saving"* (`model.ts:73-75`) — the measured saving comes from the other
mechanism. The "3 calls → 2" framing describes a harness behaviour, not a model-behaviour change, which
weakens the cross-model transfer argument in §6 of the explainer.

**Evidence:**

```
A) parameters.then_run present at top level? false
   parameters.properties.then_run present? true
   model.seenFusionSchema after notifySchema = false
   model tryFuse output = [{"tool":"write_file",...},{"tool":"run",...}]   (unchanged)
```

**Recommended fix:** Either read `((t.parameters as {properties?: Record<string, unknown>}).properties)?.then_run`
in both `model.ts` sites (restoring the intended code path), or delete
`tryFuse`/`seenFusionSchema`/`supportsFusion` and correct the README. Note `tryFuse` also only matches
`write_file`, while `transformCalls` handles `edit_file` too — fix both sides or the asymmetry persists.

---

## M-5 · Mechanism state is never reset between `Harness.run()` calls

**Severity:** Medium · **Category:** Performance / Reliability (memory leak) · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:166-180` resets `env`, `messages`, `plan`, `meter`, and `trace` — but
**not** `this.mechanisms`.

**Issue:** Every mechanism exposes a `reset()` method, and **none of them is ever called from anywhere in
`src/`** (grep confirms `reset()` appears only as a definition). `ObservationPack.archive`,
`EvidencePreservingReducer.originalArchive`, `OnlineContextCompact` counters, and `ActionFusion.fused` all
persist across runs on a reused harness.

**Impact:** Unbounded memory growth across runs, plus **wrong reported statistics** — the second run's
`archived`/`bytesArchived` include the first run's. `nextCallId` is a module-global counter that also never
resets (`call_10` … `call_16` in one process), so ids stay unique, which masks the leak rather than
preventing it.

**Evidence:**

```
7) mechanism stats after run1 = {"archived":1,...,"bytesArchived":75400}
   after run2 (same harness)  = {"archived":2,...,"bytesArchived":150800}
```

**Recommended fix:** In `Harness.run()`, right after resetting the other fields:
`for (const m of this.mechanisms) m.reset?.();`. Add `reset?(): void` to the `Mechanism` interface so it's
part of the contract rather than an ad-hoc convention.

---

## M-6 · `tools()` mutates model state, and a measurement function calls it

**Severity:** Medium · **Category:** Reliability (side effect in a getter path) · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:161-167` (`tools()` calls `notifySchema`), `:389-391`
(`toolSchemaTokens()` calls `this.tools()`).

**Issue:** `tools()` looks like a pure accessor but has the side effect of flipping
`ScriptedModel.seenFusionSchema`. `toolSchemaTokens()` — a measurement — therefore changes subsequent agent
*behaviour*.

**Impact:** Any diagnostic, assertion, or profiler that reads `toolSchemaTokens()` mid-run silently
alters the trajectory under measurement. This is a latent nondeterminism source and a debugging trap: the
measurement is not observationally neutral.

**Evidence:** `6) toolSchemaTokens() called from a measurement fn; returns 781.0 (and flips model.seenFusionSchema)`

**Recommended fix:** Make the schema notification explicit — a `notifyTools(tools)` call at the top of
`run()` — and strip the side effect out of `tools()`.

---

## M-7 · Trace records duplicate entries per turn; `failureReason` conflates two distinct outcomes

**Severity:** Medium · **Category:** Reliability · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:186-197` and `:270-273`.

**Issue:** When `rawCalls.length === 0` the code pushes a trace entry, and only breaks out **if**
`stopReason === "end_turn"`. For any other declared `stopReason` (`"error"`, `"max_turns"` — both in the
`ModelResponse` union) execution falls through to `executeCalls([])` and pushes a **second** entry for the
same turn.

**Impact:** The trace — the artifact the whole research loop is built on — contains duplicate turn records,
so `TraceEntry.turn` is no longer a unique key and any per-turn analysis double-counts. Separately,
`failureReason` is always `"score X after N turns"`, which cannot distinguish "ran out of turns" (a budget
failure) from "produced the wrong answer" (a capability failure). Those demand different remediation.

**Evidence:**

```
2) trace entries = 10, distinct turns = 1,2,3,4,5, RunResult.turns = 5
   -> failureReason = "score 0 after 5 turns"
```

10 entries for 5 turns — exactly one duplicate per turn.

**Recommended fix:** `break` on any zero-call response regardless of `stopReason` (recording the reason in
`note`), and set `failureReason` to `"max_turns exhausted (score X)"` vs `"incomplete (score X)"`.

---

## M-8 · The held-out validation gate described in the docs is not implemented

**Severity:** Medium · **Category:** Reliability · **Confidence:** Confirmed

**Location:** `src/cli.ts:196-206` (freeze + held-out), `src/research/loop.ts:281-330`
(`heldOutEvaluation`), doc comments at `src/research/loop.ts:24-26` and `README.md:101-103`.

**Issue:** Both the module doc and the README state that a failed validation *"rejects the candidate
outright."* `heldOutEvaluation` only builds and returns an `EvalResult`; it applies **no** acceptance
check. `cli.ts` prints the number and moves on, unconditionally.

**Compounding:** the "freeze" ignores the search result entirely —
`CANDIDATES.find((c) => c.id === "sol-pi[efficiency]")!` hardcodes the candidate, while `summary.best` is
computed and printed (`best=+observation-pack`, a *different* candidate) and then discarded.

**Impact:** The claimed "held-out results never feed back, and a failed validation rejects the candidate"
property is not enforced anywhere in code. The held-out numbers are reported but never gated on, so a
regression on held-out data would still be presented as a pass.

**Recommended fix:** Give `heldOutEvaluation` an `acceptance` parameter and return a pass/fail verdict;
have `cli.ts` freeze `summary.best` (falling back to baseline) and exit non-zero on validation failure.

---

## M-9 · Reducer command matching is a loose prefix match

**Severity:** Medium · **Category:** Reliability · **Confidence:** Confirmed

**Location:** `src/mechanisms/evidence-reducer.ts:130`.

**Issue:** `this.options.eligibleCommands.some((c) => result.tool.startsWith(c.split(/\s+/)[0]))`.
Splitting each entry on whitespace collapses
`["test","pytest","npm test","build","npm run build","cargo build"]` to
`["test","pytest","npm","build","cargo"]` — so `npm` and `cargo` match *any* tool whose name starts with
those letters — and `startsWith` then matches any prefix.

**Impact:** Anything named `testing*`, `build*`, `npm*`, or `cargo*` gets fed to a model intended for
build/test logs. Since the reducer is supposed to preserve *evidence*, misrouting a file read through it is
a correctness problem, not just a tidiness one. The README's claim *"File reads and search results bypass
the reducer"* holds today only because `read_file` maps to the tool name `cat` and `grep` — an accident of
naming, not a guard.

**Evidence:**

```
E) tool="testing"  reduced=true      <- should not be eligible
   tool="npm"      reduced=true
   tool="cargo"    reduced=true
   tool="cat"      reduced=false
   tool="grep"     reduced=false
```

**Recommended fix:** Match against an explicit allowlist of tool *names*
(`{"test","pytest","build","npm","cargo"}`) with exact equality, or better, tag the `ToolResult` at
dispatch time (`{kind: "build-log" | "file-read" | "search"}`) and gate on that. The latter removes the
string-sniffing entirely.

---

## M-10 · `extractorFidelity` makes research runs non-reproducible

**Severity:** Medium · **Category:** Reliability · **Confidence:** Confirmed

**Location:** `src/mechanisms/evidence-reducer.ts:92`.

**Issue:** `if (Math.random() < this.fidelity) quotes.push(line.trim())`. The knob is documented as
*"parameterised by a fidelity knob so the verifier's pass and fallback paths both get exercised"* — a
deterministic simulation knob, but implemented with a PRNG.

**Impact:** Any candidate configured with `extractorFidelity < 1` produces a different number of
retained/fallback receipts on every run. Gate outcomes, token traffic, and therefore **which candidates
are retained** become irreproducible. For a harness whose entire thesis is "measure token cost
reproducibly and attribute it to the harness", an unreproducible measurement path is a serious defect. It
also means `tests/mechanisms.test.ts` would be flaky if it ever exercised a sub-1 fidelity with a mixed log
(it currently uses `0`, which is degenerate and always fails).

**Evidence:** `SimpleExtractor(0.5)` over an identical log produced identical quote counts across 20 calls
— but all were `0` because of H-3, so the nondeterminism is currently masked. With H-3 fixed this becomes
immediately visible.

**Recommended fix:** Seed a deterministic PRNG (or make the extractor drop quotes by a stable rule, e.g.
every Nth matching line) so fidelity is reproducible. Document the seeding.

---

## M-11 · Every test function is re-evaluated 4× per run

**Severity:** Medium · **Category:** Performance · **Confidence:** Confirmed

**Location:** `src/core/harness.ts:277-284` (`allTestsPassed()` → `score()`), plus `:283`
(`score: this.env.score()`) and `:284` (`failureReason: ... this.env.score()`);
`src/core/environment.ts:159-167`.

**Issue:** `score()` maps over `task.tests` and runs each `fn`. It is called by `allTestsPassed()`, then
again for the `score` field, then a third time for the `failureReason` string. `runTests` evaluates them
again per `test` command.

**Impact:** Four invocations of the full test suite for a single-test task where the suite ran once.
`TaskSpec.tests[].fn` is user-supplied and typed as arbitrary code, so this is an unbounded-cost multiplier
on any non-trivial suite. It also makes the tests non-idempotent if any `fn` ever acquires side effects.

**Evidence:** `8) test-function invocations for a 1-run, 1-test task: 4 (the test ran once)`

**Recommended fix:** Compute `const score = this.env.score()` once after the loop and derive all three
outputs from it.

---

## M-12 · Explainer: bar chart collapses below ~360px viewport

**Severity:** Medium · **Category:** Visual Consistency / Responsive · **Confidence:** Confirmed

**Location:** `sol-pi-explainer.html` — `.bar-row { grid-template-columns: 170px 1fr 78px; gap: 10px; }` and
`.wrap { padding: 40px 24px 80px; }` (`* { box-sizing: border-box }` is set, so no surprise there).

**Issue:** The grid declares 248px of fixed columns plus 20px of gaps = 268px before the `1fr` track gets
anything. At a 320px viewport the content box is `320 − 48 = 272px`, leaving the bar track **4px**. Below
316px the fixed columns alone exceed the content box and the page scrolls horizontally.

**Evidence:**

```
320px -> content 272px, fixed 268px, 1fr = 4px  <-- TRACK COLLAPSES
360px -> content 312px, fixed 268px, 1fr = 44px
414px -> content 366px, fixed 268px, 1fr = 98px
```

The `.grid2` blocks have a breakpoint at 860px, so the chart is the only responsive failure in the
document.

**Impact:** The "Cost saved vs. baseline" section — the visual payoff of §5 — renders as an unreadable
sliver on narrow phones and produces horizontal page scroll at very narrow widths or high zoom. WCAG 1.4.10
(Reflow) is at risk; 1.4.4 (Resize Text) at 200% zoom on a 640px viewport yields a 320px effective width,
i.e. the same 4px track.

**Recommended fix:** Add a media query stacking the bar row, e.g.
`@media (max-width: 480px) { .bar-row { grid-template-columns: 1fr auto; } .bar-row .lbl { grid-column: 1 / -1; } }`,
or switch to `grid-template-columns: minmax(0, 1fr) 78px` with the label allowed to wrap.

---

## M-13 · Explainer: no landmarks, no ARIA, and unsemantic structure for the diagram and charts

**Severity:** Medium · **Category:** Accessibility · **Confidence:** Confirmed

**Location:** `sol-pi-explainer.html` — whole document; specifically the `.flow`/`.fnode` diagram
(`:206-224`), the `.bar-track`/`.bar-fill` chart (`:412-441`), and both `<table>` elements (`:349-375`,
`:379-400`).

**Evidence:** Zero `<main>`, `<header>`, `<footer>`, `<nav>`, `<section>`, or `<article>` elements. Zero
`role=` attributes. Zero `aria-*` attributes. Zero `<ul>/<ol>/<li>`. The diagram is
10 `<div class="fnode">` + 8 `<div class="arrow">`; the chart is 5 `<div class="bar-track">` +
5 `<div class="bar-fill">`. Both tables have 5 `<th>` each with **no `scope=`** and **no `<caption>`**.

**Impact:**

- **Landmarks:** a screen-reader user cannot jump to the main content or the footer; they must traverse 15
  headings linearly. The footer is `<div class="footer">`, so it is not exposed as a `contentinfo` landmark.
- **Diagram:** the arrow glyphs are announced as bare "→" characters, and the ten-node flow reads as an
  undifferentiated run of text with no indication that it is an ordered pipeline. The step ordering — the
  entire point of the diagram — is conveyed visually only.
- **Chart:** bar magnitude is conveyed by an empty `<div>`'s inline `width` percentage. There is no
  `role="img"`/`meter`, no `aria-label`, no textual percentage inside the bar. A screen-reader user gets the
  adjacent `.val` text, so the *value* survives — but the *relative comparison* that is the chart's purpose
  does not.
- **Tables:** with no `scope`, header association falls back to positional heuristics in most screen
  readers; with no `<caption>`, both tables are unnameable in a table-navigation rotor. (The preceding
  `<h3>` mitigates but does not replace this.)

**Recommended fix:** Wrap the body content in `<main>`; make the footer `<footer>`; add
`<section aria-labelledby>` around each numbered section; give the diagram list semantics or — better —
express it as an ordered list with the arrows as decorative `aria-hidden` glyphs; give the chart
`role="img"` with an `aria-label` summarising the comparison, or add `aria-hidden="true"` to the decorative
tracks and rely on the visible value text; add `<caption>` (visually hidden if needed) and `scope="col"` to
both tables.

---

## M-14 · Explainer: theme is snapshotted once; no `color-scheme` declaration

**Severity:** Medium · **Category:** Accessibility / Reliability · **Confidence:** Confirmed

**Location:** `sol-pi-explainer.html` — `<script>` in `<body>`, and `<head>`.

**Issue:** The theme IIFE reads `prefers-color-scheme` **once** at parse time. There is no
`matchMedia(...).addEventListener("change", ...)` (zero `addEventListener` calls in the document).
Separately, no `color-scheme` CSS property is declared (the only `color-scheme` occurrence in the file is
inside the `matchMedia` query string).

**Impact:** (a) A user whose OS switches appearance at sunset — or who changes it while the tab is open —
sees a stale theme with no update and no way to correct it; the `?theme=` query param is the only escape
and it is undocumented in the UI. (b) Without `color-scheme`, the browser renders scrollbars, form controls,
and the canvas background using the *light* default even in the dark theme, producing a bright scrollbar
against a `#0d1117` page.

**Recommended fix:**

```css
html[data-theme="dark"]  { color-scheme: dark; }
html[data-theme="light"] { color-scheme: light; }
```

and register the media query change listener:

```js
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", e => {
  if (!new URLSearchParams(location.search).get("theme")) {
    document.documentElement.dataset.theme = e.matches ? "light" : "dark";
  }
});
```

Consider also a visible theme toggle, since the README describes theme behaviour the page gives the reader
no control over.

---

## M-15 · Explainer and README contain numbers that contradict actual output

**Severity:** Medium · **Category:** Visual Consistency (copy / terminology / data drift) · **Confidence:** Confirmed

**Location:** `sol-pi-explainer.html:312,349`, `README.md:121-131`, vs. real `npm run research` output.

**Issue:** The static artifacts are hand-maintained and have drifted from the program.

**Evidence:**

| Claim | Artifact says | Actual output |
|---|---|---|
| ObservationPack substitutions | `sol-pi-explainer.html:312` — "15 archived, **109** substitutions" | `stats={"archived":15,"substituted":**14**}` |
| Candidate rows in prototype table | `sol-pi-explainer.html:381-390` — **7 rows** | CLI table — **8 rows** (`+online-compact-tight` missing) |
| `[gate]` line format | `README.md:124-126` — `[gate] +observation-pack score=1.000 traffic=0.0009B cost=$1.91 -> RETAIN \| -80.4% traffic, -79.8% cost` | `traffic=0.9225M ... -> RETAIN \| aggregateScore within tolerance \| tokenTraffic -80.4%, cost -79.8%` — wrong unit **and** wrong reason text |
| Reducer contribution | `sol-pi-explainer.html:349` — "Evidence-Preserving Reducer … dominate savings" | `reduced:0, fallbacks:15, savedBytes:0` |

**Impact:** This is a research artifact whose entire value is the credibility of its numbers. A reader
cross-checking the explainer against `npm run research` finds contradictions in the mechanism that is
supposed to be the headline result (see H-3), and the README's sample output does not correspond to any
runnable invocation.

**Recommended fix:** Generate the results section from `npm run research` output rather than hand-maintaining
it (the CLI already emits a table — capture it into the artifact at build time). At minimum, correct the
substitution count, add the missing row, and regenerate the README sample from a real run.

---

# LOW

| # | Finding | Location | Evidence / Confidence |
|---|---|---|---|
| L-1 | Compacted context injects a `role:"user"` message into the middle of a tool-call run, breaking the assistant→tool alternation every real provider validates | `online-compact.ts:206-211` | Code read; Confirmed |
| L-2 | Gate metrics read via `as unknown as Record<string, number>` with no key validation — a typo in `rule.capabilityMetric` yields `undefined`, and `undefined <= 0` is false so `rel` becomes `NaN` and the gate silently passes | `loop.ts:146-147, 165-166` | Code read; High Confidence |
| L-3 | CLI column header `traffic(B)` but the value is `tokenTraffic / 1e6` (millions); the same program prints `/1e9` labelled `B` elsewhere | `cli.ts:151` vs `cli.ts:186,205` | Run output `traffic=0.0047` under a `(B)` header; Confirmed |
| L-4 | Table rule `"-".repeat(110)` is a magic constant; the actual header is 108 chars | `cli.ts:151` | 24+10+14+12+10+12+14 + 12 gaps = 108; Confirmed |
| L-5 | `row()` uses `padEnd` without truncation — long candidate ids shift every column right | `cli.ts:98-100` | Code read; Confirmed |
| L-6 | `.val good` is a dead class: the CSS rule is `td.good`, so colour applies only via the inline `style` on the same element. Inconsistent with the sibling bars | `sol-pi-explainer.html` `.good` rule vs `:414` | Regex check; Confirmed |
| L-7 | `cli.ts` uses inline `import("./research/loop.js").EvalResult` annotations, violating the project's own `ts-import-type` rule | `cli.ts:158, 179` | Rule fired on audit tooling; Confirmed |
| L-8 | No `<meta name="description">`; no theme toggle despite the README describing theme behaviour the page exposes no control over | `sol-pi-explainer.html` `<head>` | Regex check; Confirmed |
| L-9 | Dead code: `planFor` (cli.ts:29, never called), `ActionFusion.planStep` (action-fusion.ts:86, exported, zero references), `Environment.outputLog` (written, never read), `OnlineContextCompact.stepCompletionsSeen` (incremented, never read), `UsageMeter.perRequestUsage` (unused getter), `UsageMeter.tokens(rates)` (unused param), and `evidence-reducer.ts:203` re-exporting `estimateTokens`/`excerpt` unused | see locations | Grep across repo; Confirmed |
| L-10 | `AutoResearchLoop.generations` is instance state never cleared in `run()`, so a second call accumulates rounds | `loop.ts:100, 240` | Code read; Confirmed |
| L-11 | `CANDIDATES.find((c) => c.id === "sol-pi[efficiency]")!` — non-null assertion; renaming the candidate yields `TypeError` at runtime | `cli.ts:197` | Code read; Confirmed |
| L-12 | `scriptFor` ignores its third `model` parameter; `FIXTURES[task.id]` is dereferenced unguarded | `cli.ts:49, 57` | Code read; Confirmed |
| L-13 | A single `ScriptedModel` instance is shared across every task, candidate, and the held-out run; correctness depends entirely on sequential execution | `loop.ts:110-112, 282` | Code read; Needs Verification (no parallel path exists today) |
| L-14 | `capabilityGate`'s `b <= 0` branch and the `"error"`/`"max_turns"` stop-reason path have no test coverage | `loop.ts:146`; `harness.ts:191` | Test read; Confirmed |
| L-15 | Empty file indistinguishable from missing: `writeFile("empty.py","")` then `cat empty.py` → exit 1, `"No such file"` | `environment.ts:44-46, 66-69` | Probe: `cat empty.py -> exit=1`; Confirmed |
| L-16 | `grep` with a missing target leaks the literal `undefined` into a model-facing error: `run('grep "add"')` → `grep: undefined: No such file` | `environment.ts:75-79` | Probe; Confirmed |
| L-17 | `run("test --verbose")` → `"command not found: test --verbose"` even though `test` is supported; flags are silently unsupported | `environment.ts:81-83` | Probe; Confirmed |
| L-18 | Module-global `callSeq` in `environment.ts:3-6` never resets; ids grow process-wide and interleave across `Environment` instances | `environment.ts:3` | Probe: `call_10` → `call_16`; Confirmed |
| L-19 | Test doubles down a no-op: `ObservationPack.transformResult` is a pure pass-through, so "leaves small results untouched" and "skips verified receipts" **cannot fail** regardless of the threshold or marker logic under test | `tests/mechanisms.test.ts:105-119`; `observation-pack.ts:57-63` | Code read; Confirmed |
| L-20 | Tautological assertion `summary.retained.length + summary.rejected.length === 2` — true for any partition | `tests/research.test.ts:101` | Code read; Confirmed |
| L-21 | Tests bypass type checking with `as never[]` / `as never` on the mechanism configs they exercise | `tests/research.test.ts:26, 50-53, 74-77` | Code read; Confirmed |

---

# INFORMATIONAL

- **I-1 · Light-theme contrast has minimal headroom.** `--purple` on the isolation background is **4.51:1**
  against a 4.5 requirement; `--accent2`/`--warn`/`--purple`/`--accent` on `--bg-soft` sit at
  4.73–4.88:1. Any future darkening of `--bg-soft` flips four pairs to failing. Consider building in
  ≥0.3:1 of margin.
- **I-2 · No type or spacing scale.** Font sizes in use: 11, 11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 19, 24,
  30px — six near-duplicates below 14px. Card padding: `.card` 20px, `.mech` 18px, `.loop` 22px. Inline
  `style` attributes (`margin-top:12px;color:var(--text-dim);font-size:13.5px`) duplicate the same literals
  throughout, defeating the token block.
- **I-3 · Smallest text is 11px** (`.lane-label`, uppercase, `letter-spacing: 0.08em`). Not a WCAG failure
  (2.2 sets no minimum size) but below comfortable reading thresholds on high-density displays.
- **I-4 · No `prefers-reduced-motion` block.** No animations or transitions exist today, so there is nothing
  to suppress — but there is also no safety net if motion is added later.
- **I-5 · Diagrams use `<br>` for line breaks** inside `.fnode .t`; these are announced inconsistently across
  screen readers depending on verbosity settings. Prefer separate elements or a single string.
- **I-6 · `README.md:16` claims "24 tests across all mechanisms and both gates"** — accurate, verified.
- **I-7 · `src/core/environment.ts` `TestSpec.fn` and `TaskSpec.bigLog` are arbitrary code**, trusted by
  construction. Fine for an in-repo corpus, but they are the seam where a future externally-sourced
  environment would need validation.

---

## What was *not* found, and why

No findings are reported for CSRF, SSRF, SQL injection, XSS, insecure deserialization, CORS misconfiguration,
storage-bucket exposure, webhook forgery, authentication/authorization bypass, IDOR, cross-tenant leakage,
session fixation, token storage, source-map exposure, or log/analytics secret leakage. These categories have
**no corresponding code path**: there is no server, no network client, no database, no credential store, no
auth layer, and no logging of sensitive data. The only file reading in the codebase is an in-memory
`Record<string, string>`.

A search for secrets, tokens, and API keys across `src/`, `tests/`, and the artifact returned nothing; the
only identifiers are the fictional backend names `gpt-5.6-sol`, `Opus 5`, and `GPT-5.6 Luna`, which are
documentation strings.

---

# Prioritised remediation plan

## Phase 1 — correctness (before any further results are published)

1. **H-3** — make the extractor match the logs it is fed; add a `bigLog()`-shaped regression test asserting
   `reduced > 0`. *Nothing else in this plan matters while the headline mechanism reports `reduced:0`.*
2. **H-1, H-2** — validate `then_run` and `update_plan.steps` at the dispatch boundary with type guards;
   return typed error results instead of throwing.
3. **H-5** — snapshot-and-restore so a fused mutation is atomic.
4. **M-2** — mint real `callId`s per call; delete the string literals.
5. **H-6** — turn a zero baseline into a hard error.

## Phase 2 — mechanism integrity (these change the reported numbers)

6. **M-3** — fire `onPlanStepComplete` only for newly-completed steps; this re-tunes the compaction gate and
   will move every `+online-compact*` figure.
7. **M-4** — fix or delete the model-side fusion path; correct the README's attribution.
8. **M-10** — make `extractorFidelity` deterministic.
9. **M-9** — tag tool results by kind at dispatch instead of string-prefix matching.
10. **M-11** — compute `score()` once.

## Phase 3 — artifact truthfulness

11. **H-4** — expose recall as a tool, or stop promising it in the prompt and the docs.
12. **M-8** — actually gate on held-out results and freeze `summary.best`.
13. **M-15** — regenerate the explainer's numbers and the README sample from real output.
14. **M-7** — fix the trace duplication and the `failureReason` taxonomy.

## Phase 4 — UI and accessibility

15. **M-13** — landmarks, table captions/`scope`, diagram and chart semantics.
16. **M-12** — bar-chart breakpoint.
17. **M-14** — `color-scheme` + `prefers-color-scheme` listener.
18. **L-3, L-4, L-5, L-6, L-8, I-2** — table units, separator width, truncation, dead class, meta
    description, spacing/type scale.

---

## Quick wins (low regression risk, self-contained)

| Fix | Why it's safe |
|---|---|
| **L-3/L-4** — fix `traffic(B)` → `traffic(M)` (or switch the divisor); replace `110` with the computed header length | Pure presentation; no logic touched |
| **L-6** — delete the redundant `good` class from the one `.val` element | Dead selector, zero behaviour change |
| **M-14** — add `color-scheme: dark/light` CSS | Two declarations, no JS |
| **L-8** — add `<meta name="description">` | Additive |
| **I-2** — extract the repeated `13.5px`/`font-size`/`color` inline styles into utility classes | CSS-only, visually identical |
| **L-9** — delete `planFor`, `ActionFusion.planStep`, `Environment.outputLog`, `stepCompletionsSeen`, `UsageMeter.perRequestUsage`, the `evidence-reducer` re-exports, and the unused `rates` param on `tokens()` | Verified zero references; `tsc --noEmit` proves it |
| **M-11** — hoist `const score = this.env.score()` | Pure memoisation; same value, 3 fewer suite runs |
| **L-7** — hoist the two inline `import("./research/loop.js").EvalResult` annotations into top-level `import type` | Type-only; also satisfies the project rule |
| **L-21** — replace `as never[]` in `tests/research.test.ts` with the real `MechanismName[]` type | Type-only, and it will surface genuine mismatches |
| **L-15/L-16** — `Object.hasOwn` in `readFile`; guard the `grep` target | Two small guards, both strictly more correct |
| **I-1** — nudge `--bg-soft` lighter in the light theme | Restores contrast headroom; visual delta is negligible |

Each of these is independently revertable and none touches the agent loop's control flow.

---

## Requires architectural change or deeper investigation

1. **The result pipeline is hand-copied (M-15).** The explainer and README duplicate numbers a human
   transcribed from CLI output, which is *why* they drifted. Fix: make `npm run research` emit the artifact's
   tables/figures (Markdown or JSON) and inject them at build time. Until then, correctness of published
   numbers depends on discipline.

2. **Mechanisms are stateful but have no lifecycle contract (M-5, M-6).** `Harness.run()` resets the
   environment but not the mechanisms, and `tools()` double-duties as a notification channel. This is the
   same class of defect as H-5: a transformation layer with no defined transaction boundary. Fix: declare
   `reset?()` and `prepare(tools)` on the `Mechanism` interface, and give `Harness.run()` a single explicit
   setup/teardown.

3. **The harness's tool-result contract is weaker than a real provider's (M-2, H-5, L-1).** Non-unique
   `callId`s, non-atomic fusion, and a compacted context that breaks role alternation would each be rejected
   outright by a real API. These are cheap individually but they mean `Harness` has never been exercised
   against a provider that actually validates. Fix: define and enforce the message/call-id invariants in one
   place, then add a validator test that asserts them.

4. **The acceptance gates need a threat model (H-6, L-2).** The README's strongest claim is that fixed
   metrics prevent the optimiser from gaming acceptance. There is exactly one hole (`b <= 0`) and no test
   pins it. Fix: property-based tests over the gate functions (random baseline/candidate pairs asserting the
   documented invariant) rather than three hand-picked examples.

5. **The extractor's evidence model (H-3, M-9, M-10).** Making the regex match real logs is a one-line fix,
   but the deeper issue is that "what counts as evidence" is encoded in a single hand-written regex with three
   near-duplicate branches. Fix: define evidence as a typed predicate over log lines, cover the formats
   `Environment` actually emits (`environment.ts:104-120`), and seed the fidelity knob.

6. **Theme management in the explainer (M-14).** Snapshot-on-load with no toggle and no `color-scheme` is a
   one-line fix, but if this artifact is ever embedded or extended, it needs a real theme module (query param
   + OS preference + persisted user override + live listener).

7. **Concurrency posture (L-13).** A single `ScriptedModel` is shared across all tasks and candidates; the
   research loop is correct only because it is strictly sequential. Before any parallelism is introduced
   (for speed, or for a larger corpus), the model must become per-run state. Worth a comment at minimum.

---

## Release recommendation

### 🟢 Ship with known risks — for internal use, demos, and further research

**Justification.** There is no exploitable attack surface: no server, no network, no database, no auth, no
credential handling, and no filesystem or process execution. The XSS sink is absent, the palette passes
WCAG 2.2 AA in both themes with a 4.51:1 worst case, the heading hierarchy is clean, and the full test suite
passes. Every High finding confirmed requires a *malformed model emission* (`then_run` as a string, `steps`
as a string) that the scripted backend never produces — so the shipped `npm run research` and `npm run demo`
paths are unaffected. H-3 is the exception: it is **already active** on every run.

### 🟠 Do not ship externally — do not publish the explainer or README as-is

**Justification.** This is not a robustness problem; it is a **truthfulness** problem, and for a research
artifact it is disqualifying. Three published claims are contradicted by the program's own output:

- the explainer states the Evidence-Preserving Reducer "dominates savings on log-heavy tasks" while it runs
  with `reduced:0, savedBytes:0`;
- it states the agent "recalls exact pages through the handle on demand" when no such tool exists, so
  archived evidence is unrecoverable and the model is actively misinformed;
- it cites "109 substitutions" where the run reports 14, omits a candidate row entirely, and the README's
  `[gate]` sample lines do not correspond to any real invocation (wrong units, wrong reason text).

Publishing these alongside a plausible-looking results table would misrepresent the prototype's findings.
**Minimum bar to publish externally:** fix H-3 and H-4 (or retract both claims), regenerate every number in
the explainer and README from real output, and land Phase 1. That is roughly a day of work and clears the
blocker.

**Sequence recommendation:** land Phase 1 and Phase 3 fixes before any external presentation; Phase 2 will
move the published efficiency figures, so re-generate the artifacts *after* it lands rather than before.

---

## Re-running this audit

Findings were produced with throwaway probe scripts (since deleted). To reproduce the key evidence:

```bash
npm test                 # 24/24 pass
npm run research         # compare against M-15, H-3, L-3
npx tsx --typecheck      # or: npm run typecheck
```

The probes used for H-1, H-2, M-1, M-2, M-3, M-5, M-9, M-11 and the contrast/grid arithmetic can be
recreated from the reproduction steps given in each finding.