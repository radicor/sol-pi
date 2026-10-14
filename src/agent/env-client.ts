import type {
  CreateTerminalRequest,
  ReadTextFileResponse,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
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
 * The subset of an ACP client the environment drives. The SDK's `Client`
 * satisfies this structurally; the indirection keeps the backend testable with
 * a fake and pins down exactly which capabilities it depends on.
 */
export interface ClientEnvDeps {
  readTextFile(params: { sessionId: string; path: string }): Promise<ReadTextFileResponse>;
  writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<WriteTextFileResponse>;
  createTerminal(params: CreateTerminalRequest): Promise<TerminalHandleLike>;
}

/** The pieces of `TerminalHandle` a one-shot command needs. */
export interface TerminalHandleLike {
  waitForExit(): Promise<{ exitCode?: number | null; signal?: string | null }>;
  currentOutput(): Promise<{ output: string; truncated: boolean }>;
  release(): Promise<unknown>;
}

/**
 * Delegates everything to the client when it advertises `fs.readTextFile`,
 * `fs.writeTextFile`, and `terminal`. The client's filesystem is authoritative,
 * so this backend does no I/O of its own.
 *
 * `terminal/create` is a live-embedding subsystem, not one-shot execution: it
 * has no shell semantics, so a command arrives wrapped in `sh -c` rather than
 * token-split into an argv.
 */
export class ClientEnv implements Environment {
  private ids = new CallIdSource();
  readonly task: TaskSpec;

  constructor(
    private cwd: string,
    private client: ClientEnvDeps,
    private sessionId: string,
    private gate: PermissionGate,
  ) {
    this.task = liveTask(cwd);
  }

  reset(): void {}

  async readFile(path: string): Promise<string | undefined> {
    try {
      const res = await this.client.readTextFile({
        sessionId: this.sessionId,
        path: absolutePath(this.cwd, path),
      });
      return res.content;
    } catch {
      // A client that cannot or will not supply the file reads as missing,
      // matching the local backend; an empty file arrives as a real "".
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

    await this.client.writeTextFile({
      sessionId: this.sessionId,
      path: absolutePath(this.cwd, path),
      content,
    });
    return writeOk(path, callId);
  }

  async run(command: string, callId = this.ids.next()): Promise<ToolResult> {
    const cmd = command.trim();

    if (cmd.startsWith("cat ")) {
      const path = cmd.slice(4).trim();
      const content = await this.readFile(path);
      if (content === undefined) return failResult(callId, "cat", `cat: ${path}: No such file`);
      return { callId, tool: "cat", stdout: content, stderr: "", exitCode: 0, bytes: content.length };
    }

    const shell = shellFor(cmd);
    const decision = await this.gate.ask({
      toolCallId: callId,
      kind: "execute",
      name: "run",
      target: cmd,
      title: cmd,
    });
    if (decision.outcome === "cancelled") throw new PermissionCancelled();
    if (decision.outcome === "denied") return failResult(callId, leadingWord(cmd), decision.reason);

    let handle: TerminalHandleLike;
    try {
      handle = await this.client.createTerminal({
        sessionId: this.sessionId,
        command: shell.command,
        args: shell.args,
        cwd: this.cwd,
        outputByteLimit: MAX_OUTPUT_BYTES,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return failResult(callId, leadingWord(cmd), `terminal/create failed: ${reason}`);
    }

    const exit = await handle.waitForExit();
    const out = await handle.currentOutput();
    await handle.release();
    // A terminal merges stdout and stderr into one stream, so stderr stays empty
    // and the whole log is reported as output.
    return runResult(callId, cmd, out.output, "", exit.exitCode ?? 1);
  }

  score(): number {
    return 0;
  }
}
