import { Environment } from "../src/core/environment.js";
import { Harness } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { ObservationPack } from "../src/mechanisms/observation-pack.js";
import { OnlineContextCompact } from "../src/mechanisms/online-compact.js";
import { EvidencePreservingReducer } from "../src/mechanisms/evidence-reducer.js";
import { LONG_HORIZON_TASK } from "../src/tasks/corpus.js";
import { estimateTokens } from "../src/core/tokens.js";
import type { ModelRequest, ModelResponse } from "../src/core/types.js";

// True LCP in tokens between consecutive requests, so compaction (which rewrites
// the middle) is charged for the prefix it actually invalidates.
async function profile(label: string, mechs: unknown[]) {
  const env = new Environment(LONG_HORIZON_TASK);
  const inner = new ScriptedModel({ id: "m", contextWindow: 60_000 });
  inner.load(buildScript());
  const reqs: string[][] = [];
  const wrapper = {
    id: inner.id,
    contextWindow: inner.contextWindow,
    async chat(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req.messages.map((m) => m.content));
      return inner.chat(req);
    },
  };
  const h = new Harness({ id: "m", model: wrapper as never, env, mechanisms: mechs as never, maxTurns: 40 });
  await h.run();

  let lcpTotal = 0, grandTotal = 0, deltaTotal = 0;
  for (let i = 1; i < reqs.length; i++) {
    const a = reqs[i - 1], b = reqs[i];
    let j = 0;
    while (j < a.length && j < b.length && a[j] === b[j]) j++;
    const lcpTokens = a.slice(0, j).reduce((n, s) => n + estimateTokens(s) + 4, 0);
    const bTokens = b.reduce((n, s) => n + estimateTokens(s) + 4, 0);
    lcpTotal += lcpTokens;
    grandTotal += bTokens;
    deltaTotal += Math.max(0, bTokens - lcpTokens);
  }
  console.log(`${label.padEnd(22)} reqs=${reqs.length} total=${grandTotal.toLocaleString()} lcp=${lcpTotal.toLocaleString()} (${grandTotal ? ((lcpTotal/grandTotal)*100).toFixed(1) : 0}%) delta=${deltaTotal.toLocaleString()}`);
  return { grandTotal, lcpTotal, deltaTotal };
}

function buildScript() {
  const fix = { path: "server.py", content: "def health():\n    return 'ok'\n" };
  const steps: { kind: "tool"; calls: { tool: string; args: Record<string, unknown> }[] }[] = [
    { kind: "tool", calls: [{ tool: "read_file", args: { path: fix.path } }] },
    { kind: "tool", calls: [{ tool: "write_file", args: { path: fix.path, content: fix.content } }] },
    { kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] },
  ];
  for (let i = 0; i < 8; i++) {
    steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "build" } }] });
    steps.push({ kind: "tool", calls: [{ tool: "run", args: { command: "test" } }] });
  }
  return steps;
}

async function main() {
  await profile("baseline", []);
  await profile("+observation-pack", [new ObservationPack({ thresholdBytes: 10240, excerptBytes: 1024 })]);
  await profile("+online-compact", [new OnlineContextCompact({ contextWindow: 60_000 })]);
  await profile("+evidence-reducer", [new EvidencePreservingReducer({ thresholdBytes: 4096 })]);
}
main();
