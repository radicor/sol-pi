/**
 * The one probe that talks to a real model. Everything else in the suite drives
 * a scripted provider, so this is the only place the Anthropic seam is actually
 * exercised against the network — which makes it the only place a bad request
 * shape, a missing header, or a broken stop-condition surfaces.
 *
 * It is deliberately cheap and side-effect-free: one prompt, no tools, so the
 * model ends the turn without touching the filesystem or asking for permission.
 * CI runs it only when a key is configured, so an offline fork still passes.
 *
 *   node probes/live-agent.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

const PROMPT = [
  {
    type: "text",
    text: "Reply with the single word `ok` and nothing else. Do not call any tools.",
  },
];

const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  throw new Error("the agent went silent; see the messages logged above");
}, 90_000);

const child = spawn("npx", ["tsx", CLI, "agent"], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 1;
const pending = new Map();
const seen = [];

const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    assert.equal(
      message.jsonrpc,
      "2.0",
      `the agent printed something that is not JSON-RPC to stdout: ${line}`,
    );
    seen.push(message);
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      message.error !== undefined ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message);
    }
  }
});

try {
  const initialized = await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  assert.ok(initialized.result.agentInfo, "initialize did not report agent info");

  const session = await request("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const sessionId = session.result.sessionId;

  // A real model may still emit updates before it stops; collect them so the
  // failure message shows what actually happened.
  let watchdog;
  const timeout = new Promise((_, reject) => {
    watchdog = setTimeout(
      () => reject(new Error(`prompt never answered; messages so far:\n${JSON.stringify(seen, null, 2)}`)),
      80_000,
    );
  });
  // The race resolves with the prompt; the watchdog's rejection must not become
  // an unhandled rejection after the test has already passed.
  timeout.catch(() => {});
  const result = await Promise.race([request("session/prompt", { sessionId, prompt: PROMPT }), timeout]);
  clearTimeout(watchdog);

  const response = result.result;
  assert.ok(
    response.stopReason === "end_turn" || response.stopReason === "max_turn_requests",
    `unexpected stopReason: ${response.stopReason}`,
  );
  console.log(`live agent: ok (stopReason=${response.stopReason}, ${seen.length} wire messages)`);
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  child.kill();
}
