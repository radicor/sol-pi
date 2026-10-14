// Measurement probe for the stand-in extractor's coverage (round 5).
//
// `probes/measure-cache-prefix.ts` measures the cache effect the remediation
// rounds discovered rather than asserting it; this probe does the same for the
// extractor's evidence rules. It prints, per real-world tool log, how many
// bytes the log is, how many lines an evidence rule matches, what the
// extractor quotes, and whether the reducer therefore reduces — with no
// assertions, so the table is a measurement the README can quote rather than a
// test that silently passes.
//
// Run: npx tsx probes/measure-extractor-coverage.ts

import { DEFAULT_EVIDENCE_RULES, EvidencePreservingReducer, SimpleExtractor } from "../src/mechanisms/evidence-reducer.js";
import { bigLog, rustcLog } from "../src/tasks/corpus.js";
import { ToolResult } from "../src/core/types.js";

function repeat<T>(n: number, f: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => f(i));
}

const LOGS: Record<string, string> = {
  "rustc (warnings)": repeat(300, (i) => [
    `warning: unused variable: \`token\``,
    `  --> src/net/client.rs:${17 + (i % 200)}:${7 + (i % 30)}`,
    `   |`,
    `   = help: maybe it is worth using this value`,
  ].join("\n")).join("\n"),
  "rustc (errors)": repeat(900, (i) => `error[E0425]: cannot find value \`${i}\` in this scope`).join("\n"),
  "go build": repeat(600, (i) => `./src/pkg${i % 3}.go:${i + 1}:${i % 30 + 2}: undefined: someToken${i}`).join("\n"),
  "tsc": repeat(400, (i) => `src/mod${i % 4}.ts:${i % 80 + 1}:${i % 40 + 5} - error TS2322: Type 'string' is not assignable to type 'number'.`).join("\n"),
  "maven": repeat(200, () => `[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project foo: Compilation failure`).join("\n"),
  "eslint": repeat(500, (i) => `  ${i % 60 + 1}:${i % 40 + 1}  error  Expected '===' and instead saw '=='  eqeqeq`).join("\n"),
  "pytest (real)": [
    ...repeat(30, (i) => {
      const n = i + 1;
      return `_________________________________________________________\ntest_case_${n} _______________________________________________________\n\n        def test_case_${n}():\n>           assert user["id"] == ${n}\nE           KeyError: 'id'\n\ntests/test_unit.py:${n + 4}: AssertionError`;
    }),
    `=================================== FAILURES ===================================`,
    `========================= 31 failed, 4 passed in 2.10s ==========================`,
  ].join("\n"),
  "pytest (fixture)": bigLog("pytest"),
  "corpus task verifier-003": rustcLog(),
};

const extractor = new SimpleExtractor(1.0);
const reducer = new EvidencePreservingReducer();

console.log("extractor coverage over real tool log formats");
console.log();
for (const [name, log] of Object.entries(LOGS)) {
  const ruleHits = log.split("\n").filter((l) => DEFAULT_EVIDENCE_RULES.some((r) => r.match(l))).length;
  const quotes = extractor.extract(log, 1).quotes.length;
  const result: ToolResult = { callId: "call_1", tool: "build", stdout: log, stderr: "", exitCode: 1, bytes: log.length };
  const out = reducer.transformResult(result, { turn: 1 } as never);
  const status = out.stdout === log ? "unrecognised format" : "reduced";

  console.log(
    `${name.padEnd(26)} bytes=${String(log.length).padStart(7)} ` +
    `rule_matches=${String(ruleHits).padStart(5)} ` +
    `quotes=${String(quotes).padStart(2)} ` +
    `${status}`,
  );
}

console.log();
console.log("an unrecognised format is a coverage gap in the rule-based stand-in, not a");
console.log("verification failure: the reducer returns the verbatim log and counts the");
console.log("case separately in stats.unrecognisedFormatFallbacks.");
