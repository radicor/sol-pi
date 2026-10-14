import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";

/**
 * Gates the tools that touch the user's machine. ACP's permission is scoped to
 * `tool + ":" + target`, not to the tool name, so approving `run: npm test`
 * never silently approves `run: rm -rf build`; the target for `run` is the whole
 * command and for a write is the path. `allow_always` / `reject_always` are
 * remembered per session, so the user answers once per tool and target.
 *
 * Reads never ask.
 */

/** What the gate can ask through. The SDK's `Client` satisfies this
 *  structurally; tests pass a fake. */
export interface PermissionAsker {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

export interface AskPermission {
  toolCallId: string;
  /** ACP tool kind, purely for the client's icon and UI treatment. */
  kind: ToolKind;
  /** Programmatic tool name, e.g. `run` or `write_file`. */
  name: string;
  /** What the tool acts on: the command, or the file path. */
  target: string;
  /** Human-readable summary shown in the prompt. */
  title: string;
}

export type PermissionDecision =
  | { outcome: "allowed" }
  | { outcome: "denied"; reason: string }
  | { outcome: "cancelled" };

const OPTIONS: PermissionOption[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny once", kind: "reject_once" },
  { optionId: "reject_always", name: "Always deny", kind: "reject_always" },
];

export class PermissionGate {
  private remembered = new Map<string, "allow_always" | "reject_always">();

  constructor(
    private asker: PermissionAsker,
    private sessionId: string,
    /** Called after a decision to allow, so a observer can report the tool
     *  starting real work. Never called for a denial or cancellation. */
    private onApproved?: (req: AskPermission) => void,
  ) {}

  async ask(req: AskPermission): Promise<PermissionDecision> {
    const key = `${req.name}:${req.target}`;
    const remembered = this.remembered.get(key);
    if (remembered === "allow_always") return { outcome: "allowed" };
    if (remembered === "reject_always") {
      return { outcome: "denied", reason: `previously rejected: ${key}` };
    }

    let response: RequestPermissionResponse;
    try {
      response = await this.asker.requestPermission({
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: req.toolCallId,
          kind: req.kind,
          title: req.title,
          name: req.name,
        },
        options: OPTIONS,
      });
    } catch (err) {
      // A client that cannot ask (no UI, unsupported method) must not become an
      // implicit approval; treat the failure as a rejection the model can see.
      return { outcome: "denied", reason: `permission request failed: ${messageOf(err)}` };
    }

    if (response.outcome.outcome === "cancelled") return { outcome: "cancelled" };
    if (response.outcome.outcome !== "selected") {
      return { outcome: "denied", reason: "the client returned an unknown permission outcome" };
    }

    const selected = response.outcome.optionId;
    const option = OPTIONS.find((o) => o.optionId === selected);
    if (!option) {
      return { outcome: "denied", reason: `the client selected an unknown permission option` };
    }
    if (option.kind === "allow_always" || option.kind === "reject_always") {
      this.remembered.set(key, option.kind);
    }
    if (option.kind.startsWith("allow")) {
      this.onApproved?.(req);
      return { outcome: "allowed" };
    }
    return { outcome: "denied", reason: `rejected: ${key}` };
  }
}

/**
 * Thrown when the user cancels the permission prompt. Cancelling the turn is a
 * control-flow decision, not a tool result, so it does not resolve to a
 * `ToolResult`; the session layer catches this and ends the turn with
 * `stopReason: "cancelled"`.
 */
export class PermissionCancelled extends Error {
  constructor() {
    super("the user cancelled the permission prompt");
    this.name = "PermissionCancelled";
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
