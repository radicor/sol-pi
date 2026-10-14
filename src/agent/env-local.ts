import { spawn } from "node:child_process";
import { mkdir, readFile as fsRead, writeFile as fsWrite } from "node:fs/promises";
import { dirname } from "node:path";
import { CallIdSource, Environment, TaskSpec } from "../core/environment.js";
import { ToolResult } from "../core/types.js";
import { PermissionCancelled, PermissionGate } from "./permissions.js";
import {
  MAX_OUTPUT_BYTES,
  absolutePath,
  failResult,
  leadingWord,
  runResult,
  shellFor,
  writeOk,
} from "./shell.js";
import { liveTask } from "./task.js";

/**
 * Executes against the real filesystem in the session cwd. Used when the client
 * does not advertise `fs` and `terminal` capabilities, and as the reference for
 * what the client-delegating backend must reproduce.
 */
export class LocalEnv implements Environment {
  private ids = new CallIdSource();
  readonly task: TaskSpec;

  constructor(
    private cwd: string,
    private gate: PermissionGate,
  ) {
    this.task = liveTask(cwd);
  }

  /** Nothing to reset: the filesystem is the state, and a live session does not
   *  replay. */
  reset(): void {}

  async readFile(path: string): Promise<string | undefined> {
    // A missing file reads as `undefined`, matching `SimulatedEnvironment`, so
    // `edit_file`'s "no such file" path rather than a throw or a silent "".
    try {
      return await fsRead(absolutePath(this.cwd, path), "utf8");
    } catch {
      return undefined;
    }
  }

  async writeFile(path: string, content: string, callId = this.ids.next()): Promise<ToolResult> {
    const decision = await this.gate.ask({
      toolCallId: callId,
      kind: "edit",
      name: "write_file",
      target: path,
      title: `write ${path}`,
    });
    if (decision.outcome === "cancelled") throw new PermissionCancelled();
    if (decision.outcome === "denied") return failResult(callId, "write_file", decision.reason);

    try {
      // The model writes new directories as it goes; the simulated world was a
      // flat map and never needed this.
      await mkdir(dirname(absolutePath(this.cwd, path)), { recursive: true });
      await fsWrite(absolutePath(this.cwd, path), content, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return failResult(callId, "write_file", `write failed: ${reason}`);
    }
    return writeOk(path, callId);
  }

  async run(command: string, callId = this.ids.next()): Promise<ToolResult> {
    const cmd = command.trim();

    // Route the harness's `read_file` implementation through the filesystem
    // rather than a shell, so paths with spaces need no quoting.
    if (cmd.startsWith("cat ")) {
      const path = cmd.slice(4).trim();
      const content = await this.readFile(path);
      if (content === undefined) return failResult(callId, "cat", `cat: ${path}: No such file`);
      return { callId, tool: "cat", stdout: content, stderr: "", exitCode: 0, bytes: content.length };
    }

    const decision = await this.gate.ask({
      toolCallId: callId,
      kind: "execute",
      name: "run",
      target: cmd,
      title: cmd,
    });
    if (decision.outcome === "cancelled") throw new PermissionCancelled();
    if (decision.outcome === "denied") return failResult(callId, leadingWord(cmd), decision.reason);

    return await runLocal(callId, cmd, this.cwd);
  }

  score(): number {
    return 0;
  }
}

async function runLocal(callId: string, command: string, cwd: string): Promise<ToolResult> {
  const shell = shellFor(command);
  return await new Promise<ToolResult>((resolve) => {
    const child = spawn(shell.command, shell.args, { cwd });
    let stdout = "";
    let stderr = "";

    // Keep the most recent output, not the first: errors come last, and a
    // runaway log's head is the part worth dropping. Bounded to twice the cap
    // plus one chunk, so a GB of output never sits in memory.
    const keep = (buf: string, chunk: string): string => {
      const next = buf + chunk;
      return next.length > MAX_OUTPUT_BYTES * 2
        ? next.slice(next.length - MAX_OUTPUT_BYTES)
        : next;
    };

    child.stdout.on("data", (data: Buffer) => {
      stdout = keep(stdout, data.toString("utf8"));
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = keep(stderr, data.toString("utf8"));
    });

    child.on("error", (err) => resolve(failResult(callId, leadingWord(command), `spawn failed: ${err.message}`)));
    child.on("close", (code) => resolve(runResult(callId, command, stdout, stderr, code ?? 1)));
  });
}
