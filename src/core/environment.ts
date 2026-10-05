import { ToolCall, ToolResult } from "./types.js";

let callSeq = 0;
export function nextCallId(): string {
  return `call_${++callSeq}`;
}

export interface TestSpec {
  name: string;
  fn: (files: Record<string, string>) => { passed: boolean; detail: string };
}

export interface TaskSpec {
  id: string;
  language: "python" | "typescript" | "go" | "rust" | "cpp" | "java";
  category: "data-science" | "web-app" | "ml-pipeline" | "cli-tool" | "infra" | "docs";
  description: string;
  initialFiles: Record<string, string>;
  tests: TestSpec[];
  /** Large-output generator: produces a big build/test log for stress mechanisms. */
  bigLog?: (files: Record<string, string>) => string;
}

/**
 * A minimal but real agent environment: an in-process virtual repo with a
 * filesystem, a shell, and a test runner. Agents mutate it through tools;
 * the harness measures the token traffic those interactions generate.
 */
export class Environment {
  private files: Record<string, string> = {};
  readonly task: TaskSpec;

  constructor(task: TaskSpec) {
    this.task = task;
    this.reset();
  }

  reset(): void {
    this.files = { ...this.task.initialFiles };
  }

  readFile(path: string): string {
    // Guard against prototype-chain lookups: `files` is a plain object, so an
    // inherited key such as "toString" would otherwise return a function
    // typed as string and confuse every downstream consumer.
    return Object.hasOwn(this.files, path) ? this.files[path] : "";
  }

  writeFile(path: string, content: string): void {
    this.files[path] = content;
  }

  applyEdits(edits: Record<string, string>): void {
    for (const [path, content] of Object.entries(edits)) {
      this.files[path] = content;
    }
  }

  /** Simulated shell. Recognizes a small command vocabulary. */
  run(command: string, callId = nextCallId()): ToolResult {
    const id = callId;
    const cmd = command.trim();

    if (cmd === "ls") {
      return this.ok(id, "ls", Object.keys(this.files).sort().join("\n"));
    }
    if (cmd.startsWith("cat ")) {
      const path = cmd.slice(4).trim();
      const content = this.readFile(path);
      if (!content) return this.fail(id, "cat", `cat: ${path}: No such file`);
      return this.ok(id, "cat", content);
    }
    if (cmd.startsWith("grep ")) {
      const rest = cmd.slice(5);
      const m = rest.match(/^"([^"]+)"\s+(.+)$/);
      const pattern = m ? m[1] : rest.split(/\s+/)[0];
      const target = m ? m[2] : rest.split(/\s+/)[1];
      if (!target) return this.fail(id, "grep", `grep: missing target file`);
      const content = this.readFile(target);
      if (!content) return this.fail(id, "grep", `grep: ${target}: No such file`);
      const lines = content.split("\n").filter((l) => l.includes(pattern ?? ""));
      return this.ok(id, "grep", lines.join("\n") || "(no matches)");
    }
    if (cmd === "test" || cmd.startsWith("pytest") || cmd.startsWith("npm test")) {
      return this.runTests(id, cmd);
    }
    if (cmd === "build" || cmd.startsWith("npm run build") || cmd.startsWith("cargo build")) {
      return this.runBuild(id, cmd);
    }
    if (cmd.startsWith("echo ")) {
      return this.ok(id, "echo", cmd.slice(5));
    }
    // Unknown commands report the leading word, not the full argument string,
    // so an unsupported flag reads as an unknown command rather than noise.
    return this.fail(id, "shell", `command not found: ${cmd.split(/\s+/)[0]}`);
  }

  private runTests(callId: string, cmd: string): ToolResult {
    const results = this.task.tests.map((t) => t.fn(this.files));
    const passed = results.filter((r) => r.passed).length;
    const lines: string[] = [
      `============================= test session starts =============================`,
      `platform linux -- Python 3.13.0, pytest-8.4.2, pluggy-1.6.0`,
      `rootdir: /repo`,
      `collected ${results.length} items`,
      ``,
    ];
    for (const r of results) {
      lines.push(r.passed ? "." : "F");
    }
    lines.push("");
    let n = 1;
    for (const r of results) {
      if (!r.passed) {
        lines.push(`_______________________________ test_${n} _______________________________`);
        lines.push(r.detail);
        lines.push("");
      }
      n++;
    }
    lines.push(`=========== ${passed} passed, ${results.length - passed} failed in 0.${passed}s ===========`);
    if (this.task.bigLog) {
      lines.push(this.task.bigLog(this.files));
    }
    const stdout = lines.join("\n");
    return {
      callId,
      tool: cmd.split(/\s+/)[0],
      stdout,
      stderr: passed === results.length ? "" : "some tests failed",
      exitCode: passed === results.length ? 0 : 1,
      bytes: stdout.length,
    };
  }

  private runBuild(callId: string, cmd: string): ToolResult {
    const stdout = [
      `> task build`,
      `> tsc --noEmit`,
      `Compiling...`,
      this.task.bigLog ? this.task.bigLog(this.files) : `Emitted 14 chunks.`,
      `Done in 2.41s.`,
    ].join("\n");
    return {
      callId,
      tool: cmd.split(/\s+/)[0],
      stdout,
      stderr: "",
      exitCode: 0,
      bytes: stdout.length,
    };
  }

  private ok(callId: string, tool: string, stdout: string): ToolResult {
    return { callId, tool, stdout, stderr: "", exitCode: 0, bytes: stdout.length };
  }

  private fail(callId: string, tool: string, stderr: string): ToolResult {
    return { callId, tool, stdout: "", stderr, exitCode: 1, bytes: stderr.length, error: stderr };
  }

  score(): number {
    const results = this.task.tests.map((t) => t.fn(this.files));
    const passed = results.filter((r) => r.passed).length;
    return results.length === 0 ? 0 : passed / results.length;
  }
}

export function summarizeResult(r: ToolResult): string {
  const parts = [`[exit ${r.exitCode}]`];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(`STDERR:\n${r.stderr}`);
  return parts.join("\n");
}

export function toolCallTokens(call: ToolCall): number {
  return JSON.stringify({ tool: call.tool, args: call.args }).length / 4;
}
