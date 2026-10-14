/**
 * A real ACP host against the real agent — the protocol path no test covers:
 * this is a third-party-style client speaking the SDK's `client()` app over an
 * actual stdio pipe, advertising `fs` and `terminal` so the agent chooses the
 * delegating backend. Every read, write, and run then crosses the wire back to
 * *these* handlers, so the probe is also the only place the client-side half
 * of `fs/read_text_file`, `fs/write_text_file`, and `terminal/*` is exercised
 * against a real subprocess rather than an in-memory counterpart.
 *
 * Offline by default — it drives a scripted model that deterministically reads,
 * writes, and runs, so the whole delegation path runs without a network key.
 * With `ANTHROPIC_API_KEY` set and no `SOLPI_PROVIDER`, the same client drives
 * a live model instead:
 *
 *   node probes/host.mjs                      # offline, scripted
 *   ANTHROPIC_API_KEY=... node probes/host.mjs   # live model over the same wire
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const live = !process.env.SOLPI_PROVIDER && !!process.env.ANTHROPIC_API_KEY;

/** What the host actually did — the assertion surface for delegation. */
interface HostRecord {
  permissions: RequestPermissionRequest[];
  reads: string[];
  writes: Array<{ path: string; content: string }>;
  terminals: string[];
}

function runOne(): { env: Record<string, string>; cwd: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), "solpi-host-"));
  writeFileSync(path.join(cwd, "seed.txt"), "seeded");

  if (!live) {
    // The delegation script: a read (ungated), a write, and a run — the three
    // things the client must handle, in the order a real agent would do them.
    const script = [
      { kind: "tool", calls: [{ tool: "read_file", args: { path: "seed.txt" } }] },
      { kind: "tool", calls: [{ tool: "write_file", args: { path: "new.txt", content: "new" } }] },
      { kind: "tool", calls: [{ tool: "run", args: { command: "echo via-terminal" } }] },
      { kind: "text", text: "ok" },
    ];
    const scriptPath = path.join(cwd, "script.json");
    writeFileSync(scriptPath, JSON.stringify(script));
    return {
      env: { ...process.env, SOLPI_PROVIDER: "scripted", SOLPI_SCRIPT: scriptPath },
      cwd,
    };
  }

  return { env: { ...process.env }, cwd };
}

interface FakeTerminal {
  id: string;
  exitCode: number | null;
  output: string;
  exited: Promise<void>;
}

let terminalSeq = 0;
function spawnTerminal(params: CreateTerminalRequest): FakeTerminal {
  const id = `t${terminalSeq++}`;
  let output = "";
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    const child = spawn(params.command, params.args, { cwd: params.cwd ?? undefined });
    child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.on("error", () => {
      exitCode = 1;
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code ?? 1;
      resolve();
    });
  });
  return { id, get exitCode() { return exitCode; }, get output() { return output; }, exited };
}

async function main(): Promise<void> {
  const { env, cwd } = runOne();
  const record: HostRecord = { permissions: [], reads: [], writes: [], terminals: [] };
  const terminals = new Map<string, FakeTerminal>();
  const updates: SessionNotification[] = [];

  const child = spawn("npx", ["tsx", CLI, "agent"], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"], env });
  const deadline = setTimeout(() => {
    child.kill("SIGKILL");
    throw new Error("the agent went silent; updates so far are logged above");
  }, 90_000);

  try {
    const clientApp = client({ name: "sol-pi-host-probe" })
      .onRequest("session/request_permission", ({ params }): RequestPermissionResponse => {
        record.permissions.push(params);
        return { outcome: { outcome: "selected", optionId: "allow_once" } };
      })
      .onRequest("fs/read_text_file", ({ params }) => {
        record.reads.push(params.path);
        // A missing file reads as empty, matching the local backend.
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
        record.terminals.push(params.args.join(" "));
        const terminal = spawnTerminal(params);
        terminals.set(terminal.id, terminal);
        return { terminalId: terminal.id };
      })
      .onRequest("terminal/wait_for_exit", async ({ params }): Promise<WaitForTerminalExitResponse> => {
        const terminal = terminals.get(params.terminalId)!;
        await terminal.exited;
        return { exitCode: terminal.exitCode, signal: null };
      })
      .onRequest("terminal/output", ({ params }): TerminalOutputResponse => {
        const terminal = terminals.get(params.terminalId)!;
        return { output: terminal.output, truncated: false };
      })
      .onRequest("terminal/release", ({ params }) => {
        terminals.delete(params.terminalId);
        return {};
      });

    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

    const response = await clientApp.connectWith(stream, async (ctx) => {
      const capabilities: ClientCapabilities = {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      };
      await ctx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: capabilities });
      return await ctx.buildSession(cwd).withSession(async (session) => {
        const promptText = live
          ? "Read the file seed.txt, then reply with only its exact contents."
          : "Please do the task.";
        const done = session.prompt(promptText);
        for (;;) {
          const message = await session.nextUpdate();
          if (message.kind === "stop") return await done;
          const update = message.notification;
          updates.push(update);
          if (update.update.sessionUpdate === "agent_message_chunk" && update.update.content.type === "text") {
            process.stdout.write(update.update.content.text);
          }
        }
      });
    });

    assert.equal(response.stopReason, "end_turn", `unexpected stopReason`);
    assert.ok(updates.length > 0, "the host received no session updates at all");

    if (!live) {
      // The whole point: the agent did none of it locally — every tool landed
      // on this side of the wire, in order, and permission was asked first.
      assert.equal(record.reads.length, 2, `expected the read plus the write's prior-content read, got ${JSON.stringify(record.reads)}`);
      assert.equal(record.writes.length, 1);
      assert.equal(record.writes[0].path, path.resolve(cwd, "new.txt"));
      assert.equal(record.writes[0].content, "new");
      assert.deepEqual(record.terminals, ["-c echo via-terminal"], `terminal created: ${JSON.stringify(record.terminals)}`);

      // The run's completed update carries the terminal output this host
      // produced — nothing was invented locally.
      const runUpdate = updates.find((u) => u.update.sessionUpdate === "tool_call" && (u.update as { title: string }).title.startsWith("run:"));
      assert.ok(runUpdate, "no run tool call was announced");
      const runId = (runUpdate!.update as { toolCallId: string }).toolCallId;
      const completed = updates.find(
        (u) =>
          u.update.sessionUpdate === "tool_call_update" &&
          (u.update as { toolCallId: string }).toolCallId === runId &&
          (u.update as { status: string }).status === "completed",
      ) as { content?: Array<{ content: { text: string } }> } | undefined;
      assert.ok(completed, "the run never reported completion");
      const runOutput = (completed!.update as { content?: Array<{ content: { text: string } }> }).content;
      assert.ok(runOutput, "the run completed without content");
      assert.match(runOutput![0].content.text, /via-terminal/);

      // Reads are never gated; the write and the run must both be asked for.
      assert.ok(
        record.permissions.length >= 2,
        `expected permission requests for the write and the run, got ${JSON.stringify(record.permissions.map((p) => p.toolCall.title))}`,
      );
    }

    // No update may reference a tool call the host never saw announced.
    const announced = new Set(
      updates.filter((u) => u.update.sessionUpdate === "tool_call").map((u) => (u.update as { toolCallId: string }).toolCallId),
    );
    for (const u of updates) {
      if (u.update.sessionUpdate !== "tool_call_update") continue;
      assert.ok(
        announced.has((u.update as { toolCallId: string }).toolCallId),
        `update for an unannounced tool call: ${JSON.stringify(u)}`,
      );
    }

    const kinds = updates.map((u) => u.update.sessionUpdate).join(" ");
    console.log(`\nhost probe (${live ? "live model" : "scripted"}): stopReason=${response.stopReason}, ${updates.length} updates`);
    console.log(`kinds: ${kinds}`);
    if (live) console.log(`delegated over the wire: ${record.reads.length} reads, ${record.writes.length} writes, ${record.terminals.length} runs, ${record.permissions.length} permission prompts`);
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    child.kill();
    rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`host probe FAILED: ${err.message ?? err}`);
  process.exit(1);
});
