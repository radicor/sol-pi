import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  CreateTerminalRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { Harness } from "../src/core/harness.js";
import { ScriptedModel } from "../src/core/model.js";
import { ClientEnv, ClientEnvDeps, TerminalHandleLike } from "../src/agent/env-client.js";
import { LocalEnv } from "../src/agent/env-local.js";
import { PermissionAsker, PermissionCancelled, PermissionGate } from "../src/agent/permissions.js";
import {
  MAX_OUTPUT_BYTES,
  absolutePath,
  capOutput,
  leadingWord,
  shellFor,
} from "../src/agent/shell.js";

// --- shell ------------------------------------------------------------------

test("capOutput keeps the tail and reports what it dropped", () => {
  // Head and tail differ, so keeping the wrong end is visible.
  const huge = "HEAD-MARKER" + "a".repeat(MAX_OUTPUT_BYTES + 1000) + "TAIL-END";
  const capped = capOutput(huge);
  const dropped = huge.length - MAX_OUTPUT_BYTES;
  assert.ok(capped.length <= MAX_OUTPUT_BYTES + 200);
  assert.match(capped, new RegExp(`truncated ${dropped} bytes`));
  assert.equal(capped.endsWith("TAIL-END"), true);
  assert.equal(capped.startsWith("HEAD-MARKER"), false);
});

test("capOutput leaves small output alone", () => {
  assert.equal(capOutput("a build log"), "a build log");
});

test("shellFor wraps a command line instead of token-splitting it", () => {
  const shell = shellFor("npm test --reporter=dot && echo done");
  assert.equal(shell.command, "sh");
  assert.deepEqual(shell.args, ["-c", "npm test --reporter=dot && echo done"]);
});

test("leadingWord is the tool the mechanisms key on", () => {
  assert.equal(leadingWord("npm test"), "npm");
  assert.equal(leadingWord("  cargo build --release"), "cargo");
});

test("absolutePath resolves against the cwd and leaves absolute paths alone", () => {
  assert.equal(absolutePath("/work", "src/index.ts"), "/work/src/index.ts");
  assert.equal(absolutePath("/work", "/etc/hosts"), "/etc/hosts");
});

// --- permissions ------------------------------------------------------------

class FakeAsker implements PermissionAsker {
  readonly calls: RequestPermissionRequest[] = [];
  constructor(private respond: (req: RequestPermissionRequest) => RequestPermissionResponse) {}
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.calls.push(params);
    return this.respond(params);
  }
}

const selected = (optionId: string): RequestPermissionResponse => ({
  outcome: { outcome: "selected", optionId },
});
const cancelled = (): RequestPermissionResponse => ({ outcome: { outcome: "cancelled" } });

function askerGate(respond: (req: RequestPermissionRequest) => RequestPermissionResponse) {
  const asker = new FakeAsker(respond);
  return { asker, gate: new PermissionGate(asker, "session-1") };
}

const ASK = {
  toolCallId: "call_1",
  kind: "execute" as const,
  name: "run",
  target: "npm test",
  title: "npm test",
};

test("allow_once permits once but asks again next time", async () => {
  const { asker, gate } = askerGate(() => selected("allow_once"));
  assert.deepEqual(await gate.ask(ASK), { outcome: "allowed" });
  assert.deepEqual(await gate.ask(ASK), { outcome: "allowed" });
  assert.equal(asker.calls.length, 2);
});

test("allow_always is remembered, so the user answers once per tool and target", async () => {
  const { asker, gate } = askerGate(() => selected("allow_always"));
  await gate.ask(ASK);
  await gate.ask(ASK);
  await gate.ask(ASK);
  assert.equal(asker.calls.length, 1);
});

test("reject_always is remembered as a denial", async () => {
  const { asker, gate } = askerGate(() => selected("reject_always"));
  const first = await gate.ask(ASK);
  const second = await gate.ask(ASK);
  assert.equal(first.outcome, "denied");
  assert.equal(second.outcome, "denied");
  assert.match((second as { reason: string }).reason, /previously rejected/);
  assert.equal(asker.calls.length, 1);
});

test("allow_always on one command never approves a different one", async () => {
  const { asker, gate } = askerGate(() => selected("allow_always"));
  await gate.ask(ASK);
  await gate.ask({ ...ASK, target: "rm -rf build", title: "rm -rf build" });
  assert.equal(asker.calls.length, 2);
  assert.equal(asker.calls[1].toolCall.title, "rm -rf build");
});

test("a cancelled prompt aborts rather than denying", async () => {
  const { gate } = askerGate(() => cancelled());
  assert.deepEqual(await gate.ask(ASK), { outcome: "cancelled" });
});

test("a failing asker never becomes an implicit approval", async () => {
  const { gate } = askerGate(() => {
    throw new Error("client has no UI");
  });
  const decision = await gate.ask(ASK);
  assert.equal(decision.outcome, "denied");
});

test("an unknown selected option is a denial", async () => {
  const { gate } = askerGate(() => selected("allow_everything"));
  const decision = await gate.ask(ASK);
  assert.equal(decision.outcome, "denied");
});

test("the prompt carries the kind, title, and all four options", async () => {
  const { asker, gate } = askerGate(() => selected("allow_once"));
  await gate.ask(ASK);
  const params = asker.calls[0];
  assert.equal(params.sessionId, "session-1");
  assert.equal(params.toolCall.toolCallId, "call_1");
  assert.equal(params.toolCall.kind, "execute");
  assert.deepEqual(params.options.map((o) => o.kind), [
    "allow_once",
    "allow_always",
    "reject_once",
    "reject_always",
  ]);
});

// --- LocalEnv ---------------------------------------------------------------

/** A temp cwd that cleans up after the test. */
function withCwd<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> | T {
  const cwd = mkdtempSync(path.join(tmpdir(), "solpi-env-"));
  return Promise.resolve(fn(cwd)).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

const allowAll = () => askerGate(() => selected("allow_always"));
const denyAll = () => askerGate(() => selected("reject_always"));

test("LocalEnv writes and reads through the real filesystem", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    const res = await env.writeFile("src/index.ts", "export const x = 1;\n");
    assert.equal(res.exitCode, 0);
    assert.equal(await env.readFile("src/index.ts"), "export const x = 1;\n");
    // A nested write created the directory on the way.
    assert.ok(fs.existsSync(path.join(cwd, "src", "index.ts")));
  });
});

test("LocalEnv run reports the leading word as tool and the real length as bytes", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    const res = await env.run("echo hello world");
    assert.equal(res.tool, "echo");
    assert.equal(res.stdout, "hello world\n");
    assert.equal(res.bytes, "hello world\n".length);
    assert.equal(res.exitCode, 0);
  });
});

test("LocalEnv routes cat through the filesystem and reports a missing file", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    await env.writeFile("notes.txt", "some notes");
    const res = await env.run("cat notes.txt");
    assert.equal(res.tool, "cat");
    assert.equal(res.stdout, "some notes");
    const missing = await env.run("cat nope.txt");
    assert.equal(missing.exitCode, 1);
    // The shortcut's own message, not the shell's: `cat` would say
    // "No such file or directory".
    assert.equal(missing.stderr, "cat: nope.txt: No such file");
  });
});

test("LocalEnv cat handles a path with spaces without quoting", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    await env.writeFile("my notes.txt", "spaced content");
    // A shell would read this as two filenames and fail on both.
    const res = await env.run("cat my notes.txt");
    assert.equal(res.stdout, "spaced content");
    assert.equal(res.exitCode, 0);
  });
});

test("LocalEnv runs real shell syntax, not a token-split argv", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    const res = await env.run("echo a && echo b | cat");
    assert.match(res.stdout, /a/);
    assert.match(res.stdout, /b/);
  });
});

test("a denied LocalEnv write reports the rejection and never touches the file", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, denyAll().gate);
    const res = await env.writeFile("src/index.ts", "malicious");
    assert.equal(res.exitCode, 1);
    assert.match(res.stderr, /rejected/);
    assert.equal(fs.existsSync(path.join(cwd, "src", "index.ts")), false);
  });
});

test("a denied LocalEnv run never spawns", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, denyAll().gate);
    // A command whose only effect is on disk: if the gate is consulted after
    // spawning, the denial still reports failure but the file exists.
    const res = await env.run(`touch ${path.join(cwd, "marker.txt")}`);
    assert.equal(res.exitCode, 1);
    assert.equal(res.stdout, "");
    assert.equal(fs.existsSync(path.join(cwd, "marker.txt")), false);
  });
});

test("a cancelled permission aborts the LocalEnv turn", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, askerGate(() => cancelled()).gate);
    await assert.rejects(() => env.run("echo hi"), PermissionCancelled);
  });
});

test("LocalEnv keeps the tail of a runaway command's output", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    const res = await env.run(
      `node -e "process.stdout.write('HEAD-MARKER' + 'y'.repeat(${MAX_OUTPUT_BYTES * 2}) + 'TAIL-END')"`,
    );
    assert.ok(res.stdout.length <= MAX_OUTPUT_BYTES + 200, `stdout was ${res.stdout.length}`);
    // The last thing the command printed survives; the head is what got dropped.
    assert.equal(res.stdout.endsWith("TAIL-END"), true);
    assert.equal(res.stdout.startsWith("HEAD-MARKER"), false);
  });
});

test("LocalEnv reports a failed spawn rather than hanging", async () => {
  // A cwd that does not exist makes `spawn` itself fail with ENOENT, which
  // arrives as an `error` event instead of an exit code.
  const env = new LocalEnv(path.join(tmpdir(), "solpi-nonexistent-cwd"), allowAll().gate);
  const res = await env.run("echo hi");
  assert.notEqual(res.exitCode, 0);
  assert.match(res.stderr, /spawn failed/);
});

test("LocalEnv exposes an empty test suite, so score is 0", async () => {
  await withCwd((cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    assert.equal(env.task.tests.length, 0);
    assert.equal(env.score(), 0);
  });
});

test("LocalEnv reads a missing file as undefined and an existing empty file as empty", async () => {
  await withCwd(async (cwd) => {
    const env = new LocalEnv(cwd, allowAll().gate);
    assert.equal(await env.readFile("no_such_file.ts"), undefined, "missing is undefined, not an empty string");
    await env.writeFile("empty.ts", "");
    assert.equal(await env.readFile("empty.ts"), "", "an existing empty file reads as a real empty string");

    const cat = await env.run("cat empty.ts");
    assert.equal(cat.exitCode, 0, "cat of an existing empty file succeeds");
    assert.equal(cat.stdout, "");
    const missing = await env.run("cat no_such_file.ts");
    assert.equal(missing.exitCode, 1, "cat of a missing file fails");
    assert.match(missing.stderr, /No such file/);
  });
});

test("each LocalEnv mints its own call ids starting at call_1", async () => {
  await withCwd(async (cwd) => {
    const a = new LocalEnv(cwd, allowAll().gate);
    const b = new LocalEnv(cwd, allowAll().gate);
    const ra = await a.writeFile("a.txt", "a");
    const rb = await b.writeFile("b.txt", "b");
    assert.equal(ra.callId, "call_1");
    assert.equal(rb.callId, "call_1", "two LocalEnvs in one process each start at call_1");

    const next = await a.writeFile("a.txt", "a2");
    assert.equal(next.callId, "call_2", "an environment's ids advance across calls");
  });
});

// --- ClientEnv --------------------------------------------------------------

class FakeTerminal implements TerminalHandleLike {
  released = false;
  constructor(
    private output: string,
    private exitCode: number,
  ) {}
  waitForExit() {
    return Promise.resolve({ exitCode: this.exitCode });
  }
  currentOutput() {
    return Promise.resolve({ output: this.output, truncated: false });
  }
  release() {
    this.released = true;
    return Promise.resolve({});
  }
}

class FakeClient implements ClientEnvDeps {
  readonly files = new Map<string, string>();
  readonly terminals: CreateTerminalRequest[] = [];
  nextTerminal = new FakeTerminal("default output", 0);

  async readTextFile(params: { path: string }): Promise<ReadTextFileResponse> {
    this.readPaths = [...this.readPaths, params.path];
    // A real host errors on a missing file rather than answering with "", and
    // the contract turns that error into an undefined read; answering "" here
    // would make the fake unable to distinguish missing from existing-empty.
    if (!this.files.has(params.path)) throw new Error("fs/read_text_file: not found");
    return { content: this.files.get(params.path)! };
  }
  readPaths: string[] = [];

  async writeTextFile(params: { path: string; content: string }): Promise<WriteTextFileResponse> {
    this.writePaths = [...this.writePaths, params.path];
    this.files.set(params.path, params.content);
    return {};
  }
  writePaths: string[] = [];

  async createTerminal(params: CreateTerminalRequest): Promise<FakeTerminal> {
    this.terminals.push(params);
    return this.nextTerminal;
  }
}

function clientEnv(cwd: string, respond: (req: RequestPermissionRequest) => RequestPermissionResponse) {
  const asker = new FakeAsker(respond);
  const client = new FakeClient();
  return { asker, client, env: new ClientEnv(cwd, client, "session-1", new PermissionGate(asker, "session-1")) };
}

test("ClientEnv reads and writes through the client with absolute paths", async () => {
  const { env, client } = clientEnv("/work", () => selected("allow_always"));
  await env.writeFile("src/index.ts", "content");
  const content = await env.readFile("src/index.ts");
  assert.equal(content, "content");
  assert.deepEqual(client.writePaths, ["/work/src/index.ts"]);
  assert.deepEqual(client.readPaths, ["/work/src/index.ts"]);
});

test("ClientEnv runs through a terminal wrapped in sh -c, then releases it", async () => {
  const { env, client } = clientEnv("/work", () => selected("allow_always"));
  client.nextTerminal = new FakeTerminal("test output\n", 0);
  const res = await env.run("npm test");

  assert.equal(client.terminals.length, 1);
  const term = client.terminals[0];
  assert.equal(term.command, "sh");
  assert.deepEqual(term.args, ["-c", "npm test"]);
  assert.equal(term.cwd, "/work");
  assert.equal(term.outputByteLimit, MAX_OUTPUT_BYTES);
  assert.equal(client.nextTerminal.released, true);

  assert.equal(res.tool, "npm");
  assert.equal(res.stdout, "test output\n");
  assert.equal(res.exitCode, 0);
});

test("ClientEnv cat reads through the client, not a terminal", async () => {
  const { env, client } = clientEnv("/work", () => selected("allow_always"));
  client.files.set("/work/notes.txt", "notes");
  const res = await env.run("cat notes.txt");
  assert.equal(res.stdout, "notes");
  assert.equal(client.terminals.length, 0);
});

test("a denied ClientEnv run creates no terminal", async () => {
  const { env, client } = clientEnv("/work", () => selected("reject_once"));
  const res = await env.run("npm test");
  assert.equal(res.exitCode, 1);
  assert.equal(client.terminals.length, 0);
});

test("a ClientEnv permission cancellation aborts", async () => {
  const { env } = clientEnv("/work", () => cancelled());
  await assert.rejects(() => env.run("npm test"), PermissionCancelled);
});

test("a terminal failure reports rather than hanging", async () => {
  const { env, client } = clientEnv("/work", () => selected("allow_once"));
  client.createTerminal = async () => {
    throw new Error("client cannot spawn");
  };
  const res = await env.run("npm test");
  assert.equal(res.exitCode, 1);
  assert.match(res.stderr, /terminal\/create failed/);
});

test("ClientEnv reads a client error as missing and a supplied empty file as empty", async () => {
  const { env, client } = clientEnv("/work", () => selected("allow_always"));
  assert.equal(await env.readFile("no_such_file.ts"), undefined, "a client that cannot supply the file reads as missing");
  client.files.set("/work/empty.ts", "");
  assert.equal(await env.readFile("empty.ts"), "", "an empty the client does supply arrives as a real empty string");

  const cat = await env.run("cat empty.ts");
  assert.equal(cat.exitCode, 0, "cat of an existing empty file succeeds");
  const missing = await env.run("cat no_such_file.ts");
  assert.equal(missing.exitCode, 1, "cat of a file the client cannot supply fails");
});

test("each ClientEnv mints its own call ids starting at call_1", async () => {
  const x = clientEnv("/work", () => selected("allow_always"));
  const y = clientEnv("/work", () => selected("allow_always"));
  const rx = await x.env.writeFile("x.txt", "x");
  const ry = await y.env.writeFile("y.txt", "y");
  assert.equal(rx.callId, "call_1");
  assert.equal(ry.callId, "call_1", "two ClientEnvs in one process each start at call_1");

  const next = await x.env.writeFile("x.txt", "x2");
  assert.equal(next.callId, "call_2", "an environment's ids advance across calls");
});

// --- through the harness ----------------------------------------------------

test("a denied write surfaces through the harness and leaves the file untouched", async () => {
  await withCwd(async (cwd) => {
    const model = new ScriptedModel({ id: "t" });
    model.load([
      { kind: "tool", calls: [{ tool: "write_file", args: { path: "src/index.ts", content: "x" } }] },
      { kind: "done", summary: "stopped" },
    ]);
    const env = new LocalEnv(cwd, denyAll().gate);
    const harness = new Harness({ id: "t", model, env, maxTurns: 5 });
    harness.begin([{ role: "user", content: "write the file" }]);
    await harness.step();

    assert.equal(harness.finish().trace[0].results[0].stderr, "rejected: write_file:src/index.ts");
    assert.equal(fs.existsSync(path.join(cwd, "src", "index.ts")), false);
  });
});

test("a denied write does not run its fused follow-ups", async () => {
  await withCwd(async (cwd) => {
    const marker = path.join(cwd, "marker.txt");
    const model = new ScriptedModel({ id: "t" });
    model.load([
      {
        kind: "tool",
        calls: [
          {
            tool: "write_file",
            args: { path: "src/index.ts", content: "x", then_run: [`touch ${marker}`] },
          },
        ],
      },
      { kind: "done", summary: "stopped" },
    ]);
    const env = new LocalEnv(cwd, denyAll().gate);
    const harness = new Harness({ id: "t", model, env, maxTurns: 5 });
    harness.begin([{ role: "user", content: "write the file" }]);
    await harness.step();

    const result = harness.finish().trace[0].results[0];
    assert.equal(result.stderr, "rejected: write_file:src/index.ts");
    // Neither the write nor the command it was fused with happened.
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(cwd, "src", "index.ts")), false);
  });
});

test("a fused write whose follow-up fails rolls back on the real filesystem", async () => {
  await withCwd(async (cwd) => {
    writeFileSync(path.join(cwd, "existing.txt"), "original");
    const model = new ScriptedModel({ id: "t" });
    model.load([
      {
        kind: "tool",
        calls: [
          {
            tool: "write_file",
            args: { path: "existing.txt", content: "changed", then_run: ["exit 3"] },
          },
        ],
      },
      { kind: "done", summary: "stopped" },
    ]);
    const env = new LocalEnv(cwd, allowAll().gate);
    const harness = new Harness({ id: "t", model, env, maxTurns: 5 });
    harness.begin([{ role: "user", content: "write and run" }]);
    await harness.step();

    // The follow-up failed, so the file went back to its original contents.
    assert.equal(fs.readFileSync(path.join(cwd, "existing.txt"), "utf8"), "original");
    assert.equal(harness.finish().trace[0].results[0].exitCode, 1);
  });
});
