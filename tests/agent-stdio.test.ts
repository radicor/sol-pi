import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

/** The child's cwd is a scratch dir, so the entry point is absolute. */
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/**
 * stdout *is* the protocol: it carries a newline-delimited JSON-RPC stream, so
 * a single stray byte on it makes the connection unparseable. This drives the
 * real child process through a full turn — initialize, session, a prompted run
 * with permission prompts — and asserts every line it ever prints is a
 * JSON-RPC message. stderr is where anything else belongs.
 */

interface WireMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

async function driveChild(cwd: string, scriptPath: string): Promise<{ messages: WireMessage[]; stderr: string }> {
  const child = spawn("npx", ["tsx", CLI, "agent"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SOLPI_PROVIDER: "scripted", SOLPI_SCRIPT: scriptPath },
  });
  const messages: WireMessage[] = [];
  const unparseable: string[] = [];
  let stderr = "";
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (msg: WireMessage) => void>();

  // A silent child must fail the test rather than hang it: nothing after this
  // point may outlive the exchange.
  const deadline = setTimeout(() => {
    child.kill("SIGKILL");
    throw new Error(`the agent went silent; messages so far:\n${JSON.stringify(messages, null, 2)}`);
  }, 20_000);

  try {
    const send = (message: WireMessage) => child.stdin.write(JSON.stringify(message) + "\n");

    const request = (method: string, params: unknown): Promise<WireMessage> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, (msg) => (msg.error !== undefined ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg)));
        send({ jsonrpc: "2.0", id, method, params });
      });
    };

    const handleLine = (line: string) => {
      if (line === "") return;
      let parsed: WireMessage;
      try {
        parsed = JSON.parse(line) as WireMessage;
      } catch {
        unparseable.push(line);
        return;
      }
      if (parsed.jsonrpc !== "2.0") unparseable.push(line);
      messages.push(parsed);
      // Answer the agent's own requests so the turn can proceed.
      if (parsed.method !== undefined && parsed.id !== undefined) {
        send({ jsonrpc: "2.0", id: parsed.id, result: permissionReply(parsed) });
      }
      if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
        pending.get(parsed.id)?.(parsed);
        pending.delete(parsed.id);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

    const initialized = await request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(initialized.error, undefined, "initialize failed");
    const session = await request("session/new", { cwd, mcpServers: [] });
    assert.equal(session.error, undefined, "session/new failed");
    const sessionId = (session.result as { sessionId: string }).sessionId;
    await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "do the task" }] });
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    child.kill();
  }

  assert.deepEqual(unparseable, [], "stdout printed something that is not JSON-RPC");
  return { messages, stderr };
}

function permissionReply(message: WireMessage): unknown {
  if (message.method === "session/request_permission") {
    return { outcome: { outcome: "selected", optionId: "allow_once" } };
  }
  // No fs or terminal capabilities were advertised, so these are not reached.
  return {};
}

test("every byte the agent prints to stdout is JSON-RPC across a full turn", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "solpi-stdio-"));
  const scriptPath = path.join(cwd, "script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify([
      { kind: "tool", calls: [{ tool: "write_file", args: { path: "out.txt", content: "written" } }] },
      { kind: "tool", calls: [{ tool: "run", args: { command: "echo hello" } }] },
      { kind: "text", text: "done" },
    ]),
  );
  try {
    const { messages, stderr } = await driveChild(cwd, scriptPath);
    const methods = messages.filter((m) => m.method !== undefined).map((m) => m.method);
    assert.ok(methods.includes("session/update"), "no session updates");
    assert.ok(methods.includes("session/request_permission"), "no permission prompt");
    // The prompted turn answered, and every request the test sent got a result
    // rather than an error.
    assert.equal(messages.filter((m) => m.error !== undefined).length, 0);
    // The agent's own activity log landed on stderr, where it belongs.
    assert.match(stderr, /sol-pi: session .* via local backend/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a malformed line on stdin does not corrupt the stream on stdout", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "solpi-stdio-"));
  const scriptPath = path.join(cwd, "script.json");
  writeFileSync(scriptPath, JSON.stringify([{ kind: "text", text: "ok" }]));
  try {
    const child = spawn("npx", ["tsx", CLI, "agent"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SOLPI_PROVIDER: "scripted", SOLPI_SCRIPT: scriptPath },
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    // Neither of these belongs on the protocol: the first is not JSON, the
    // second is JSON but not a message.
    child.stdin.write("this is not json-rpc\n");
    child.stdin.write(JSON.stringify({ neither: "method nor id" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} } }) + "\n");
    const initialized = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`no initialize response; stdout:\n${stdout}`));
      }, 20_000);
      child.stdout.on("data", () => {
        if (stdout.includes('"id":1')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    try {
      await initialized;
    } finally {
      child.stdin.end();
      child.kill();
    }
    for (const line of stdout.split("\n")) {
      if (line === "") continue;
      const parsed = JSON.parse(line) as WireMessage;
      assert.equal(parsed.jsonrpc, "2.0", "stdout line is not JSON-RPC");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
