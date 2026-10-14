import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  client,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type {
  ClientCapabilities,
  CreateTerminalRequest,
  CreateTerminalResponse,
  PromptResponse,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { ScriptedModel, ScriptStep } from "../src/core/model.js";
import { ScriptedProvider } from "../src/providers/scripted-provider.js";
import { createAgentApp } from "../src/agent/server.js";

/**
 * In-process ACP end to end: the real `agent()` app against the SDK's
 * `client()` app, with a scripted provider and a temp cwd. Everything the
 * protocol does crosses a real connection, so this is where the handler wiring
 * and the notification ordering are actually exercised.
 */

interface HostRecord {
  notifications: SessionNotification[];
  permissions: RequestPermissionRequest[];
  reads: string[];
  writes: Array<{ path: string; content: string }>;
  terminals: CreateTerminalRequest[];
}

interface DriveOptions {
  script: ScriptStep[];
  cwd: string;
  capabilities?: ClientCapabilities;
  respond?: (req: RequestPermissionRequest) => RequestPermissionResponse;
  /** Inspected after each notification; returning true sends `session/cancel`. */
  cancelWhen?: (seen: SessionNotification[]) => boolean;
  /** A second prompt, to exercise the resume path. */
  secondPrompt?: string;
}

interface DriveResult {
  record: HostRecord;
  response: PromptResponse;
  secondResponse?: PromptResponse;
  /** Everything the server logged through `console.log` during the drive. */
  logs: string[];
}

function allowOnce(req: RequestPermissionRequest): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId: "allow_once" } };
}

async function drive(opts: DriveOptions): Promise<DriveResult> {
  const provider = new ScriptedProvider(new ScriptedModel({ id: "scripted" }));
  provider.load(opts.script);

  const record: HostRecord = { notifications: [], permissions: [], reads: [], writes: [], terminals: [] };
  const terminals = new Map<string, FakeTerminal>();
  const respond = opts.respond ?? allowOnce;

  const app = createAgentApp({ provider: () => provider, maxTurns: 8 });
  const clientApp = client({ name: "test-host" })
    .onRequest("session/request_permission", ({ params }) => {
      record.permissions.push(params);
      return respond(params);
    })
    .onRequest("fs/read_text_file", ({ params }): ReadTextFileResponse => {
      record.reads.push(params.path);
      // A missing file reads as empty, matching the local backend, so the two
      // stay interchangeable for the harness's prior-content read.
      try {
        return { content: readFileSync(params.path, "utf8") };
      } catch {
        return { content: "" };
      }
    })
    .onRequest("fs/write_text_file", ({ params }): WriteTextFileResponse => {
      record.writes.push({ path: params.path, content: params.content });
      writeFileSync(params.path, params.content);
      return {};
    })
    .onRequest("terminal/create", ({ params }): CreateTerminalResponse => {
      record.terminals.push(params);
      const terminal = new FakeTerminal(params);
      terminals.set(terminal.id, terminal);
      return { terminalId: terminal.id };
    })
    .onRequest("terminal/wait_for_exit", async ({ params }): Promise<WaitForTerminalExitResponse> => {
      return await terminals.get(params.terminalId)!.waitForExit();
    })
    .onRequest("terminal/output", ({ params }): TerminalOutputResponse => {
      return terminals.get(params.terminalId)!.output();
    })
    .onRequest("terminal/release", ({ params }) => {
      terminals.delete(params.terminalId);
      return {};
    });

  // The server logs through `console.log`, which the entry point redirects to
  // stderr. Intercepting it here keeps the runner's output readable and lets a
  // test read the log itself.
  const logs: string[] = [];
  const savedLog = console.log;
  console.log = ((msg: string) => { logs.push(msg); }) as typeof console.log;

  try {
    return await clientApp.connectWith(app, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: opts.capabilities ?? {},
      });
      return await ctx.buildSession(opts.cwd).withSession(async (session) => {
        let cancelled = false;
        const prompt = async (text: string) => {
          const done = session.prompt(text);
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return await done;
            record.notifications.push(message.notification);
            if (!cancelled && opts.cancelWhen?.(record.notifications)) {
              cancelled = true;
              await ctx.notify("session/cancel", { sessionId: session.sessionId });
            }
          }
        };
        const response = await prompt("Please do the task.");
        if (!opts.secondPrompt) return { record, response, logs };
        provider.reset();
        provider.load(secondScript());
        return { record, response, logs, secondResponse: await prompt(opts.secondPrompt) };
      });
    });
  } finally {
    console.log = savedLog;
  }
}

/** The resume script is separate so the first run consumes exactly its own. */
function secondScript(): ScriptStep[] {
  return [{ kind: "text", text: "second turn done" }];
}

/** Runs one `terminal/create` command to completion, accumulating its output. */
class FakeTerminal {
  static next = 0;
  readonly id: string;
  private outputText = "";
  private exitCode: number | null = null;
  private readonly exited: Promise<void>;

  constructor(params: CreateTerminalRequest) {
    this.id = `t${FakeTerminal.next++}`;
    this.exited = new Promise((resolve) => {
      const child = spawn(params.command, params.args, { cwd: params.cwd ?? opts_cwd(params) });
      child.stdout.on("data", (d: Buffer) => (this.outputText += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (this.outputText += d.toString("utf8")));
      child.on("error", () => {
        this.exitCode = 1;
        resolve();
      });
      child.on("close", (code) => {
        this.exitCode = code ?? 1;
        resolve();
      });
    });
  }

  async waitForExit(): Promise<WaitForTerminalExitResponse> {
    await this.exited;
    return { exitCode: this.exitCode, signal: null };
  }

  output(): TerminalOutputResponse {
    return { output: this.outputText, truncated: false };
  }
}

function opts_cwd(params: CreateTerminalRequest): string {
  return params.cwd ?? process.cwd();
}

/** A temp directory plus a seeded file, cleaned up afterwards. */
async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(path.join(tmpdir(), "solpi-agent-"));
  try {
    await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const kinds = (record: HostRecord) => record.notifications.map((n) => n.update.sessionUpdate);

/** The last update that marked a call complete or failed. */
function settled(record: HostRecord): Record<string, unknown> {
  const updates = record.notifications.filter((n) => n.update.sessionUpdate === "tool_call_update");
  return (updates[updates.length - 1]!.update as Record<string, unknown>);
}

function updateAt(record: HostRecord, index: number): Record<string, unknown> {
  return record.notifications[index].update as Record<string, unknown>;
}

/** Every `tool_call_update` must answer a `tool_call` the client already saw. */
function assertAllUpdatesAnnounced(record: HostRecord): void {
  const announced = new Set(
    record.notifications.filter((n) => n.update.sessionUpdate === "tool_call").map((n) => (n.update as { toolCallId: string }).toolCallId),
  );
  for (const n of record.notifications) {
    if (n.update.sessionUpdate !== "tool_call_update") continue;
    assert.ok(announced.has((n.update as { toolCallId: string }).toolCallId), "update for an unannounced tool call");
  }
}

test("a turn announces pending, in_progress, then completed", async () => {
  await withCwd(async (cwd) => {
    const { record, response } = await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "run", args: { command: "echo hello" } }] },
        { kind: "text", text: "all done" },
      ],
    });
    assert.deepEqual(kinds(record), [
      "usage_update",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "agent_message_chunk",
      "usage_update",
    ]);
    assert.equal(updateAt(record, 1).status, "pending");
    assert.equal(updateAt(record, 2).status, "in_progress");
    assert.equal(updateAt(record, 3).status, "completed");
    assertAllUpdatesAnnounced(record);
    assert.equal(response.stopReason, "end_turn");
  });
});

test("the tool's output reaches the client in the completed update", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      script: [{ kind: "tool", calls: [{ tool: "run", args: { command: "echo hello" } }] }, { kind: "text", text: "ok" }],
    });
    const content = settled(record).content as Array<{ content: { text: string } }>;
    assert.match(content[0].content.text.trim(), /hello/);
  });
});

test("a permission prompt round trips: allow runs the command", async () => {
  await withCwd(async (cwd) => {
    let asked = 0;
    const { record } = await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "run", args: { command: "echo yes" } }] },
        { kind: "text", text: "ok" },
      ],
      respond: (req) => {
        asked++;
        assert.equal(req.toolCall.name, "run");
        assert.equal(req.toolCall.title, "run: echo yes");
        assert.equal(req.toolCall.kind, "execute");
        return allowOnce(req);
      },
    });
    assert.equal(asked, 1);
    assert.equal(record.permissions.length, 1);
    assert.equal(kinds(record).includes("tool_call_update"), true);
  });
});

test("a denied permission reports a failed call and runs nothing", async () => {
  await withCwd(async (cwd) => {
    const { record, response } = await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "write_file", args: { path: "kept.txt", content: "kept" } }] },
        { kind: "tool", calls: [{ tool: "run", args: { command: "touch denied.txt" } }] },
        { kind: "text", text: "ok" },
      ],
      respond: (req) =>
        req.toolCall.name === "run"
          ? { outcome: { outcome: "selected", optionId: "reject_once" } }
          : allowOnce(req),
    });
    const statuses = record.notifications
      .filter((n) => n.update.sessionUpdate === "tool_call_update")
      .map((n) => (n.update as { status: string }).status);
    assert.deepEqual(statuses, ["in_progress", "completed", "failed"]);
    const failed = record.notifications.find(
      (n) => n.update.sessionUpdate === "tool_call_update" && (n.update as { status: string }).status === "failed",
    );
    const content = (failed!.update as { content?: Array<{ content: { text: string } }> }).content;
    assert.match(content![0].content.text, /rejected: run:touch denied.txt/);
    assert.equal(readFileSync(path.join(cwd, "kept.txt"), "utf8"), "kept");
    assert.equal(existsSync(path.join(cwd, "denied.txt")), false);
    assert.equal(response.stopReason, "end_turn");
  });
});

test("a permission granted to a fused follow-up does not invent a tool call", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      script: [
        {
          kind: "tool",
          calls: [
            { tool: "write_file", args: { path: "fused.txt", content: "fused" } },
            { tool: "run", args: { command: "echo fused" } },
          ],
        },
        { kind: "text", text: "ok" },
      ],
    });
    // Both tools ran and both were allowed, but only the fused batch was
    // announced, so only it may be updated.
    assert.equal(readFileSync(path.join(cwd, "fused.txt"), "utf8"), "fused");
    const announced = record.notifications.filter((n) => n.update.sessionUpdate === "tool_call");
    assert.equal(announced.length, 1);
    assertAllUpdatesAnnounced(record);
  });
});

test("allow_always is remembered, so the client is asked once per tool and target", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "run", args: { command: "ls" } }] },
        { kind: "tool", calls: [{ tool: "run", args: { command: "ls" } }] },
        { kind: "tool", calls: [{ tool: "run", args: { command: "ls" } }] },
        { kind: "text", text: "ok" },
      ],
      respond: () => ({ outcome: { outcome: "selected", optionId: "allow_always" } }),
    });
    assert.equal(record.permissions.length, 1);
    // Three completed calls, each still announced.
    const completed = record.notifications.filter(
      (n) => n.update.sessionUpdate === "tool_call_update" && (n.update as { status: string }).status === "completed",
    );
    assert.equal(completed.length, 3);
  });
});

test("reject_always is remembered too, and never asks again", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "run", args: { command: "ls" } }] },
        { kind: "tool", calls: [{ tool: "run", args: { command: "ls" } }] },
        { kind: "text", text: "ok" },
      ],
      respond: () => ({ outcome: { outcome: "selected", optionId: "reject_always" } }),
    });
    assert.equal(record.permissions.length, 1);
    const failed = record.notifications.filter(
      (n) => n.update.sessionUpdate === "tool_call_update" && (n.update as { status: string }).status === "failed",
    );
    assert.equal(failed.length, 2);
  });
});

test("a cancelled permission ends the turn as cancelled and runs nothing", async () => {
  await withCwd(async (cwd) => {
    const { record, response } = await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "run", args: { command: "echo never" } }] },
        { kind: "text", text: "unreachable" },
      ],
      respond: () => ({ outcome: { outcome: "cancelled" } }),
    });
    assert.equal(response.stopReason, "cancelled");
    assert.deepEqual(kinds(record), ["usage_update", "tool_call"]);
    // Nothing past the pending announcement, and no permission approval.
    assert.equal(record.notifications.some((n) => n.update.sessionUpdate === "agent_message_chunk"), false);
  });
});

test("session/cancel aborts the turn in flight", async () => {
  await withCwd(async (cwd) => {
    const { record, response } = await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "run", args: { command: "sleep 1" } }] },
        { kind: "tool", calls: [{ tool: "run", args: { command: "echo unreachable" } }] },
      ],
      cancelWhen: (seen) => seen.some((n) => n.update.sessionUpdate === "tool_call"),
    });
    assert.equal(response.stopReason, "cancelled");
    // The cancelled turn's call is still finished — a client must keep accepting
    // updates after cancelling — but the second turn never starts.
    assert.equal(record.notifications.some((n) => n.update.sessionUpdate === "agent_message_chunk"), false);
  });
});

test("plan updates speak `completed`, never `done`", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      script: [
        {
          kind: "tool",
          calls: [
            {
              tool: "update_plan",
              args: {
                steps: [
                  { id: 1, title: "Read", status: "done" },
                  { id: 2, title: "Run", status: "in_progress" },
                ],
              },
            },
          ],
        },
        { kind: "text", text: "ok" },
      ],
    });
    const plan = record.notifications.find((n) => n.update.sessionUpdate === "plan");
    const entries = (plan!.update as { entries: Array<{ status: string }> }).entries;
    assert.deepEqual(entries.map((e) => e.status), ["completed", "in_progress"]);
  });
});

test("reads are never gated, writes and runs always are", async () => {
  await withCwd(async (cwd) => {
    writeFileSync(path.join(cwd, "seed.txt"), "seeded");
    await drive({
      cwd,
      script: [
        { kind: "tool", calls: [{ tool: "read_file", args: { path: "seed.txt" } }] },
        { kind: "text", text: "ok" },
      ],
      respond: () => ({ outcome: { outcome: "selected", optionId: "reject_once" } }),
    });
    // The read happened even though every permission was denied.
    assert.equal(readFileSync(path.join(cwd, "seed.txt"), "utf8"), "seeded");
  });
});

test("a client advertising fs and terminal has every tool delegated to it", async () => {
  await withCwd(async (cwd) => {
    writeFileSync(path.join(cwd, "seed.txt"), "seeded");
    const { record } = await drive({
      cwd,
      capabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      script: [
        { kind: "tool", calls: [{ tool: "read_file", args: { path: "seed.txt" } }] },
        { kind: "tool", calls: [{ tool: "write_file", args: { path: "new.txt", content: "new" } }] },
        { kind: "tool", calls: [{ tool: "run", args: { command: "echo via-terminal" } }] },
        { kind: "text", text: "ok" },
      ],
    });
    // The write also reads the file's prior content, so it can roll back.
    assert.deepEqual(record.reads, [path.resolve(cwd, "seed.txt"), path.resolve(cwd, "new.txt")]);
    assert.deepEqual(record.writes.map((w) => w.path), [path.resolve(cwd, "new.txt")]);
    assert.equal(record.terminals.length, 1);
    assert.equal(record.terminals[0].command, "sh");
    assert.deepEqual(record.terminals[0].args, ["-c", "echo via-terminal"]);
    assert.equal(readFileSync(path.join(cwd, "new.txt"), "utf8"), "new");
    const runId = (record.notifications.find((n) => (n.update as { title?: string }).title === "run: echo via-terminal")!.update as {
      toolCallId: string;
    }).toolCallId;
    const ran = record.notifications.find(
      (n) =>
        n.update.sessionUpdate === "tool_call_update" &&
        (n.update as { toolCallId: string }).toolCallId === runId &&
        (n.update as { status: string }).status === "completed",
    )!.update as { content?: Array<{ content: { text: string } }> };
    assert.match(ran.content![0].content.text.trim(), /via-terminal/);
    assertAllUpdatesAnnounced(record);
  });
});

test("a client without the capabilities runs everything locally", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      capabilities: {},
      script: [
        { kind: "tool", calls: [{ tool: "run", args: { command: "echo local" } }] },
        { kind: "text", text: "ok" },
      ],
    });
    assert.deepEqual(record.terminals, []);
    assert.deepEqual(record.reads, []);
    const content = settled(record).content as Array<{ content: { text: string } }>;
    assert.match(content[0].content.text.trim(), /local/);
    assertAllUpdatesAnnounced(record);
  });
});

test("the session log names the backend the capabilities selected", async () => {
  await withCwd(async (cwd) => {
    const local = await drive({
      cwd,
      capabilities: {},
      script: [{ kind: "text", text: "ok" }],
    });
    assert.match(local.logs[0], /via local backend/);

    const delegated = await drive({
      cwd,
      capabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      script: [{ kind: "text", text: "ok" }],
    });
    assert.match(delegated.logs[0], /via client backend/);
  });
});

test("a second prompt continues the session rather than restarting it", async () => {
  await withCwd(async (cwd) => {
    const { record, response, secondResponse } = await drive({
      cwd,
      script: [{ kind: "tool", calls: [{ tool: "run", args: { command: "echo first" } }] }, { kind: "text", text: "first" }],
      secondPrompt: "again",
    });

    assert.equal(response.stopReason, "end_turn");
    assert.equal(secondResponse?.stopReason, "end_turn");
    // The second turn still carries the first turn's context; a `begin` would
    // have wiped it and the reported usage would drop back down.
    const usage = record.notifications.filter((n) => n.update.sessionUpdate === "usage_update");
    const first = (usage[0].update as { used: number }).used;
    const last = (usage[usage.length - 1].update as { used: number }).used;
    assert.ok(last > first, `context shrank across prompts: ${first} -> ${last}`);
  });
});

test("a client with a terminal but no filesystem still runs locally", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      capabilities: { terminal: true },
      script: [
        { kind: "tool", calls: [{ tool: "write_file", args: { path: "local.txt", content: "local" } }] },
        { kind: "tool", calls: [{ tool: "run", args: { command: "echo local" } }] },
        { kind: "text", text: "ok" },
      ],
    });
    assert.deepEqual(record.terminals, []);
    assert.deepEqual(record.writes, []);
    assert.equal(readFileSync(path.join(cwd, "local.txt"), "utf8"), "local");
    assertAllUpdatesAnnounced(record);
  });
});

test("a client with a filesystem but no terminal still runs locally", async () => {
  await withCwd(async (cwd) => {
    const { record } = await drive({
      cwd,
      capabilities: { fs: { readTextFile: true, writeTextFile: true } },
      script: [{ kind: "tool", calls: [{ tool: "run", args: { command: "echo local" } }] }, { kind: "text", text: "ok" }],
    });
    assert.deepEqual(record.terminals, []);
    const content = settled(record).content as Array<{ content: { text: string } }>;
    assert.match(content[0].content.text.trim(), /local/);
  });
});

test("prompting an unknown session is an error, not a crash", async () => {
  const provider = new ScriptedProvider(new ScriptedModel({ id: "scripted" }));
  const app = createAgentApp({ provider: () => provider });
  await client({ name: "test-host" }).connectWith(app, async (ctx) => {
    await ctx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await assert.rejects(
      () => ctx.request("session/prompt", { sessionId: "no-such-session", prompt: [{ type: "text", text: "hi" }] }),
      /unknown session no-such-session/,
    );
  });
});

test("a model that cannot be reached answers session/new with the reason", async () => {
  const app = createAgentApp({
    provider: () => {
      throw new Error("ANTHROPIC_API_KEY is not set, so the agent has no model to call.");
    },
  });
  await client({ name: "test-host" }).connectWith(app, async (ctx) => {
    await ctx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await assert.rejects(
      () => ctx.buildSession("/tmp").start(),
      /ANTHROPIC_API_KEY is not set/,
    );
  });
});
