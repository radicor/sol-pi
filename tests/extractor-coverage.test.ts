import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_EVIDENCE_RULES,
  EvidencePreservingReducer,
  ExtractorModel,
  SimpleExtractor,
} from "../src/mechanisms/evidence-reducer.js";
import { SimulatedEnvironment } from "../src/core/environment.js";
import { Harness } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { ToolResult } from "../src/core/types.js";
import { VERIFIER_TASKS, rustcLog } from "../src/tasks/corpus.js";

function fakeCtx() {
  return { turn: 1 } as never;
}

function resultFor(stdout: string, tool = "build", exitCode = 0): ToolResult {
  return { callId: "call_1", tool, stdout, stderr: "", exitCode, bytes: stdout.length };
}

/** A log large enough to clear the 4 KiB threshold whose lines match no evidence rule. */
function unrecognisedLog(bytes = 20_000): string {
  const line = "  some diagnostic text that no evidence rule is written to match";
  return Array.from({ length: Math.ceil(bytes / (line.length + 1)) }, () => line).join("\n");
}

/** Real failure logs as the tools actually emit them: nothing here was written to match the rules. */
const REAL_LOGS: Record<string, string> = {
  "rustc": Array.from({ length: 900 }, (_, i) => `error[E0425]: cannot find value \`${i}\` in this scope`).join("\n"),
  "go": Array.from({ length: 600 }, (_, i) => `./src/pkg${i % 3}.go:${i + 1}:${i % 30 + 2}: undefined: someToken${i}`).join("\n"),
  "tsc": Array.from({ length: 400 }, (_, i) => `src/mod${i % 4}.ts:${i % 80 + 1}:${i % 40 + 5} - error TS2322: Type 'string' is not assignable to type 'number'.`).join("\n"),
  "maven": Array.from({ length: 200 }, () => `[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project foo: Compilation failure`).join("\n"),
  "eslint": Array.from({ length: 500 }, (_, i) => `  ${i % 60 + 1}:${i % 40 + 1}  error  Expected '===' and instead saw '=='  eqeqeq`).join("\n"),
};

const REAL_PYTEST = [
  ...Array.from({ length: 30 }, (_, i) => {
    const n = i + 1;
    return `_________________________________________________________\ntest_case_${n} _______________________________________________________\n\n        def test_case_${n}():\n>           assert user["id"] == ${n}\nE           KeyError: 'id'\n\ntests/test_unit.py:${n + 4}: AssertionError`;
  }),
  `=================================== FAILURES ===================================`,
  `========================= 31 failed, 4 passed in 2.10s ==========================`,
].join("\n");

/* --------- the new stat: coverage gap vs. verification failure --------- */

test("a log the extractor cannot parse counts as an unrecognised format, not a fallback", () => {
  const log = unrecognisedLog();
  const reducer = new EvidencePreservingReducer();
  const out = reducer.transformResult(resultFor(log), fakeCtx());

  assert.equal(out.stdout, log, "the verbatim original is returned, not a receipt");
  assert.equal(reducer.stats.unrecognisedFormatFallbacks, 1);
  assert.equal(reducer.stats.fallbacks, 0);
  assert.equal(reducer.stats.reduced, 0);
  assert.equal(reducer.stats.savedBytes, 0);
});

test("a receipt that fails verification counts as a fallback, not an unrecognised format", () => {
  // A stub extractor that produces a well-formed receipt for a log it did not
  // actually read: the verifier must reject it on the source hash.
  const log = unrecognisedLog();
  const broken: ExtractorModel = {
    id: "broken",
    extract: (_stdout, exitStatus) => ({
      marker: "[RECEIPT]",
      schemaVersion: 1,
      sourceHash: "deadbeef",
      exitStatus,
      quotes: ["a line that is not in the log"],
      summary: "exit=0; fabricated",
      bytes: 0,
    }),
  };
  const reducer = new EvidencePreservingReducer({}, broken);
  const out = reducer.transformResult(resultFor(log), fakeCtx());

  assert.equal(out.stdout, log, "an unverifiable receipt still falls back to the original");
  assert.equal(reducer.stats.fallbacks, 1);
  assert.equal(reducer.stats.unrecognisedFormatFallbacks, 0);
});

test("the zero-quote branch is only reached before verification, so verify() keeps its own empty-receipt guard", () => {
  const empty = new SimpleExtractor(0.0); // fidelity 0 drops every quote
  const log = Array.from({ length: 900 }, (_, i) => `E       AssertionError: failure ${i}`).join("\n");
  const receipt = empty.extract(log, 0);
  const reducer = new EvidencePreservingReducer({}, empty);
  const result = resultFor(log, "build", 0);

  assert.equal(receipt.quotes.length, 0);
  assert.equal(reducer.verify(receipt, reducer["renderReceipt"](receipt), result), false);
});

/* --------- the corpus task that makes the gap a measured outcome --------- */

test("verifier-003's build log matches none of the evidence rules", () => {
  const log = rustcLog();
  assert.ok(log.length > 4096, "the log clears the reducer's 4 KiB threshold");
  for (const rule of DEFAULT_EVIDENCE_RULES) {
    assert.ok(!log.split("\n").some((l) => rule.match(l)), `rule "${rule.kind}" must not match, or the task stops measuring the gap`);
  }
  assert.equal(new SimpleExtractor().extract(log, 0).quotes.length, 0);
});

test("through a harness, verifier-003 reduces nothing and saves nothing, with the gap counted separately", async () => {
  const task = VERIFIER_TASKS.find((t) => t.id === "verifier-003")!;
  const reducer = new EvidencePreservingReducer();
  const env = new SimulatedEnvironment(task);
  const model = new ScriptedModel({ id: "coverage" });
  model.load([
    { kind: "tool", calls: [{ tool: "read_file", args: { path: "client.rs" } }] },
    { kind: "tool", calls: [{ tool: "write_file", args: { path: "client.rs", content: "fn fetch() -> Result<bool, FetchError> { Ok(false) }\n" } }] },
    { kind: "tool", calls: [{ tool: "run", args: { command: "build" } }] },
    { kind: "tool", calls: [{ tool: "run", args: { command: "build" } }] },
    { kind: "done", summary: "Build is warning-free." },
  ]);
  const harness = new Harness({ id: "coverage", model, env, maxTurns: 20, mechanisms: [reducer] });
  await harness.run();

  assert.equal(reducer.stats.reduced, 0);
  assert.equal(reducer.stats.savedBytes, 0);
  assert.equal(reducer.stats.fallbacks, 0);
  assert.ok(reducer.stats.unrecognisedFormatFallbacks >= 1, "the coverage gap is counted on the task built to expose it");
});

/* --------- the rule coverage pin: what the stand-in does and does not cover --------- */

test("no evidence rule matches real rustc/go/tsc/maven/eslint failure lines", () => {
  for (const [name, log] of Object.entries(REAL_LOGS)) {
    const matched = log.split("\n").filter((l) => DEFAULT_EVIDENCE_RULES.some((r) => r.match(l))).length;
    assert.equal(matched, 0, `${name}: format pinned as uncovered must stay uncovered`);
  }
});

test("a real pytest failure log yields evidence the extractor can quote", () => {
  const receipt = new SimpleExtractor().extract(REAL_PYTEST, 1);
  assert.ok(receipt.quotes.length > 0, "pytest banners and E-lines are the covered case");
});
