import {
  agent,
  AgentApp,
  AgentContext,
  CreateTerminalRequest,
  PROTOCOL_VERSION,
  ReadTextFileResponse,
  RequestError,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type {
  ClientCapabilities,
  CreateTerminalResponse,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { ChatProvider } from "../providers/types.js";
import { ClientEnvDeps, TerminalHandleLike } from "./env-client.js";
import { PermissionAsker } from "./permissions.js";
import { AgentSession, SessionDeps } from "./session.js";

/**
 * The ACP handlers. `initialize` captures the client's capabilities on
 * connection-scoped state; `session/new` reads them to pick a backend, so the
 * client is preferred when it advertises `fs` and `terminal`, and the safe
 * local fallback is used otherwise. State is per connection: one process may
 * serve several hosts.
 */

export interface ServerOptions {
  /** Resolved on the first `session/new`, so a model that cannot be reached
   *  answers that request with an error instead of taking the whole connection
   *  down with it. */
  provider: () => ChatProvider;
  /** Overridable in tests; the real entry point resolves it from the env. */
  maxTurns?: number;
}

export function createAgentApp(opts: ServerOptions): AgentApp {
  const state = new ConnectionState(opts);
  return agent({ name: "sol-pi" })
    .onRequest("initialize", ({ params }) => {
      state.capabilities = params.clientCapabilities ?? {};
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
          mcpCapabilities: {},
          sessionCapabilities: {},
        },
        agentInfo: { name: "sol-pi", version: "0.1.0" },
      };
    })
    .onRequest("session/new", ({ params, client }) => {
      const session = state.openSession({
        cwd: params.cwd,
        client,
        capabilities: state.capabilities,
      });
      return { sessionId: session.sessionId };
    })
    .onRequest("session/prompt", async ({ params }) => {
      const session = state.sessions.get(params.sessionId);
      // A plain throw would surface as a generic "Internal error"; the host
      // gets an actionable code and message instead.
      if (!session) throw new RequestError(-32001, `unknown session ${params.sessionId}`, { sessionId: params.sessionId });
      return await session.prompt(params.prompt);
    })
    .onNotification("session/cancel", ({ params }) => {
      state.sessions.get(params.sessionId)?.cancel();
    })
    .onRequest("authenticate", async () => undefined)
    .onRequest("session/set_mode", async () => undefined);
}

/** Connection-scoped state: capabilities from `initialize`, sessions from
 *  `session/new`. `session/prompt` and `session/cancel` only read it. */
class ConnectionState {
  capabilities: ClientCapabilities = {};
  readonly sessions = new Map<string, AgentSession>();
  private provider?: ChatProvider;

  constructor(private opts: ServerOptions) {}

  /** Resolve the model once, and only when a session actually needs it. */
  resolveProvider(): ChatProvider {
    if (this.provider) return this.provider;
    try {
      this.provider = this.opts.provider();
      return this.provider;
    } catch (err) {
      // The message says what to fix (e.g. "ANTHROPIC_API_KEY is not set"),
      // which is what a host needs to tell its user.
      throw new RequestError(-32001, messageOf(err), {});
    }
  }

  openSession({ cwd, client, capabilities }: { cwd: string; client: AgentContext; capabilities: ClientCapabilities }): AgentSession {
    const id = randomUUID();
    // `console.log`, not `console.error`: the entry point points it at stderr,
    // so this reaches a host's logs without touching the protocol stream.
    console.log(`sol-pi: session ${id} in ${cwd} via ${clientBackend(capabilities) ? "client" : "local"} backend`);
    const bridge = new ClientBridge(client, id);
    const deps: SessionDeps = {
      notify: (notification) => client.notify("session/update", notification),
      asker: bridge,
      // The delegating backend is used only when the client actually offers it.
      clientDeps: clientBackend(capabilities) ? bridge : undefined,
    };
    const session = new AgentSession({
      id,
      cwd,
      provider: this.resolveProvider(),
      deps,
      capabilities,
      maxTurns: this.opts.maxTurns,
    });
    this.sessions.set(id, session);
    return session;
  }
}

/**
 * Bridges the ACP client context onto the structural interfaces the env
 * backends and the gate already depend on, so nothing in `src/agent` knows it
 * is talking to JSON-RPC. `terminal/create` returns an id, not a handle, so a
 * created terminal is wrapped to look like the one-shot handle `ClientEnv` uses.
 *
 * One bridge per session: the session id rides along on every request.
 */
export class ClientBridge implements ClientEnvDeps, PermissionAsker {
  constructor(private client: AgentContext, private sessionId: string) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.client.request("session/request_permission", params);
  }

  async readTextFile(params: { path: string }): Promise<ReadTextFileResponse> {
    return this.client.request("fs/read_text_file", { sessionId: this.sessionId, path: params.path });
  }

  async writeTextFile(params: { path: string; content: string }): Promise<WriteTextFileResponse> {
    return this.client.request("fs/write_text_file", {
      sessionId: this.sessionId,
      path: params.path,
      content: params.content,
    });
  }

  async createTerminal(params: CreateTerminalRequest): Promise<TerminalHandleLike> {
    const res: CreateTerminalResponse = await this.client.request("terminal/create", params);
    return new ClientTerminalHandle(this.client, this.sessionId, res.terminalId);
  }
}

class ClientTerminalHandle implements TerminalHandleLike {
  constructor(
    private client: AgentContext,
    private sessionId: string,
    private terminalId: string,
  ) {}

  async waitForExit(): Promise<{ exitCode?: number | null; signal?: string | null }> {
    const res: WaitForTerminalExitResponse = await this.client.request("terminal/wait_for_exit", {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
    });
    return { exitCode: res.exitCode, signal: res.signal };
  }

  async currentOutput(): Promise<{ output: string; truncated: boolean }> {
    const res: TerminalOutputResponse = await this.client.request("terminal/output", {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
    });
    return { output: res.output, truncated: res.truncated };
  }

  async release(): Promise<unknown> {
    return this.client.request("terminal/release", {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
    });
  }
}

/** Prefer the client when it offers both filesystem methods and a terminal. */
function clientBackend(capabilities: ClientCapabilities): boolean {
  return Boolean(
    capabilities.fs?.readTextFile && capabilities.fs?.writeTextFile && capabilities.terminal,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}