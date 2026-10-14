import { ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { providerFromEnv } from "../providers/index.js";
import { createAgentApp } from "./server.js";

/**
 * The agent entry point. This is the only module that resolves a provider, so
 * the research path can never reach a network call by accident.
 *
 * stdout is the protocol: it is a newline-delimited JSON-RPC stream, so nothing
 * besides the stream may write to it. Shared code prints freely through
 * `console.log` (the research CLI depends on it), so the console is redirected
 * to stderr *before* the stream is constructed. A stray log then lands on stderr
 * where a host can ignore it, instead of corrupting the stream where a host
 * would reject the line.
 *
 * The provider is resolved lazily by the first `session/new`, so a bad
 * configuration answers that request instead of dying before the client can ask
 * anything.
 */

export async function runAgent(): Promise<void> {
  // Redirect first: constructing the stream is what makes stdout the protocol.
  console.log = console.error;

  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const app = createAgentApp({ provider: providerFromEnv });
  const connection = app.connect(stream);
  await connection.closed;
}
