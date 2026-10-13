import { ToolResult } from "../core/types.js";
import path from "node:path";

/**
 * Cap on a single command's captured output. A real build or test log can be
 * orders of magnitude larger than the context window, and one runaway command
 * would otherwise OOM the conversation. The tail is kept: errors come last.
 */
export const MAX_OUTPUT_BYTES = 1_048_576;

export function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  const dropped = text.length - MAX_OUTPUT_BYTES;
  return `... [truncated ${dropped} bytes from the start] ...\n${text.slice(dropped)}`;
}

/**
 * Wrap a command line in a shell. `terminal/create` has no shell semantics of
 * its own and the local fallback needs one for pipes, globs, and `&&`, so both
 * backends run the same shell invocation. The command is never token-split
 * into an argv: that would break quoting, redirection, and pipes.
 */
export function shellFor(command: string): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: "cmd.exe", args: ["/c", command] };
  return { command: "sh", args: ["-c", command] };
}

/** The leading word is the tool the mechanisms see (the reducer's allowlist
 *  matches it exactly), so both backends derive it the same way. */
export function leadingWord(command: string): string {
  return command.trim().split(/\s+/)[0] ?? "sh";
}

/**
 * Build a `run` result. `bytes` is the length of the output the model actually
 * sees, so ObservationPack's 10 KiB gate and the reducer's 4 KiB threshold fire
 * on real output rather than a placeholder.
 */
export function runResult(callId: string, command: string, stdout: string, stderr: string, exitCode: number): ToolResult {
  const capped = capOutput(stdout);
  return {
    callId,
    tool: leadingWord(command),
    stdout: capped,
    stderr: capOutput(stderr),
    exitCode,
    bytes: capped.length,
  };
}

/** A command that produced no output worth reporting: a denial, a missing file,
 *  a spawn failure. `bytes: 0` keeps it out of every size-gated mechanism. */
export function failResult(callId: string, tool: string, reason: string): ToolResult {
  return { callId, tool, stdout: "", stderr: reason, exitCode: 1, bytes: 0, error: reason };
}

/** `fs/*` requires absolute paths; the model speaks relative to the session cwd. */
export function absolutePath(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

/** A successful write reports the same shape the harness previously built, so
 *  the simulated and live paths produce identical observations. */
export function writeOk(path: string, callId: string): ToolResult {
  return {
    callId,
    tool: "write_file",
    stdout: `wrote ${path}`,
    stderr: "",
    exitCode: 0,
    bytes: `wrote ${path}`.length,
  };
}
