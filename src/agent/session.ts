import type { ContentBlock, PromptResponse, SessionNotification, StopReason } from "@agentclientprotocol/sdk";
import { ClientCapabilities } from "@agentclientprotocol/sdk";
import { HarnessEvent } from "../core/harness.js";
import { SolPiHarness } from "../mechanisms/stack.js";
import { ChatProvider } from "../providers/types.js";
import { LiveModel } from "../providers/live-model.js";
import { ClientEnv, ClientEnvDeps } from "./env-client.js";
import { LocalEnv } from "./env-local.js";
import { PermissionAsker, PermissionCancelled, PermissionGate } from "./permissions.js";
import { NotificationContext, notificationsFor, permissionGrantedNotification } from "./events.js";

/**
 * One ACP session: a harness with the full mechanism stack, the permission gate
 * its tools ask through, and a per-session abort controller. Conversation state
 * persists across prompts (`resume`), which is how a host actually uses an
 * agent; each `session/prompt` is one turn.
 */

export interface SessionDeps {
  /** Where notifications go: the client's `session/update` endpoint. */
  notify(notification: SessionNotification): Promise<void> | void;
  /** The client's `session/request_permission` endpoint, or a test fake. */
  asker: PermissionAsker;
  /** The client's `fs` and `terminal` endpoints. Present only when the client
   *  advertised them, which is what selects the delegating backend. */
  clientDeps?: ClientEnvDeps;
}

export interface SessionOptions {
  id: string;
  cwd: string;
  provider: ChatProvider;
  deps: SessionDeps;
  /** The capabilities the client advertised at initialize. */
  capabilities: ClientCapabilities;
  maxTurns?: number;
}

export class AgentSession {
  readonly sessionId: string;
  private readonly harness: SolPiHarness;
  private readonly gate: PermissionGate;
  private readonly compactionAdvertised: boolean;
  private readonly notify: SessionDeps["notify"];
  private readonly controller = new AbortController();
  private compactions = 0;
  private prompts = 0;
  /** Call ids the client has seen a `tool_call` for. */
  private readonly announced = new Set<string>();

  constructor(opts: SessionOptions) {
    this.sessionId = opts.id;
    this.notify = opts.deps.notify;

    // A granted permission means real work is starting, so the client's tool
    // call moves to `in_progress` before the harness reports it finished.
    this.gate = new PermissionGate(opts.deps.asker, opts.id, (req) => {
      // A fused follow-up (ActionFusion's `then_run`) asks under its own id,
      // which the harness never announced as a `tool_call`; an update for it
      // would reference a tool call the client cannot know about.
      if (!this.announced.has(req.toolCallId)) return;
      this.send(permissionGrantedNotification(req, this.notificationContext()));
    });

    this.compactionAdvertised = Boolean(opts.capabilities.session?.compaction);
    // The gate is built before the harness because its callback only fires
    // during a prompt, by which point the harness exists.
    this.harness = new SolPiHarness({
      id: opts.id,
      model: new LiveModel(opts.provider),
      env: opts.deps.clientDeps
        ? new ClientEnv(opts.cwd, opts.deps.clientDeps, opts.id, this.gate)
        : new LocalEnv(opts.cwd, this.gate),
      maxTurns: opts.maxTurns ?? 40,
      onEvent: (event) => this.onHarnessEvent(event),
    });
  }

  /** The client's prompt is one turn: `begin` on the first, `resume` after. */
  async prompt(blocks: ContentBlock[]): Promise<PromptResponse> {
    if (this.prompts === 0) this.harness.begin([{ role: "user", content: promptText(blocks) }]);
    else this.harness.resume(promptText(blocks));
    this.prompts++;

    try {
      while (!(await this.harness.step({ signal: this.controller.signal })).stopped) {
        // each step is one model turn plus its tool calls
      }
    } catch (err) {
      // A permission cancellation is a control-flow decision, not a tool
      // failure: the turn ends as cancelled rather than as an error.
      if (err instanceof PermissionCancelled) return { stopReason: "cancelled" };
      throw err;
    }
    return { stopReason: this.stopReason() };
  }

  /** `session/cancel`: the current turn stops after the step in flight. */
  cancel(): void {
    this.controller.abort();
  }

  private stopReason(): StopReason {
    return this.harness.stopReason;
  }

  private onHarnessEvent(event: HarnessEvent): void {
    if (event.type === "tool_started") this.announced.add(event.callId);
    if (event.type === "context_rewritten") this.compactions++;
    for (const notification of notificationsFor(event, this.notificationContext())) {
      this.send(notification);
    }
  }

  private send(notification: SessionNotification): void {
    // Fire and forget: a notification is progress, and a slow client must not
    // stall the loop. A rejection here is a dropped update, not a failed turn.
    void Promise.resolve(this.notify(notification)).catch(() => {});
  }

  private notificationContext(): NotificationContext {
    return {
      sessionId: this.sessionId,
      contextWindow: this.harness.model.contextWindow,
      usedTokens: this.harness.contextTokens(),
      compactionAdvertised: this.compactionAdvertised,
      compactionId: `compaction-${this.compactions}`,
    };
  }
}

/** Flatten a prompt's blocks to the text the harness speaks; non-text becomes
 *  its link so nothing is silently dropped. */
function promptText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : b.type === "resource_link" ? b.uri : ""))
    .filter(Boolean)
    .join("\n\n");
}
