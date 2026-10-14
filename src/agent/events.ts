import type {
  ContentBlock,
  PlanEntry,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { HarnessEvent, PlanStep } from "../core/harness.js";
import type { ToolCall, ToolResult } from "../core/types.js";
import { DEFAULT_RATES, usageCost, type Usage } from "../core/usage.js";
import type { AskPermission } from "./permissions.js";

/**
 * Pure mappers from the harness's passive events to ACP `session/update`
 * notifications. Nothing here touches a stream, so every mapping is unit-tested
 * by calling it directly; the session layer only decides *whether* a
 * notification is sent (the compaction capability) and supplies the ids.
 */

export interface NotificationContext {
  sessionId: string;
  /** Context window of the resolved provider: the `size` in `usage_update`. */
  contextWindow: number;
  /** Tokens currently in context, read off the harness when the event fires. */
  usedTokens: number;
  /** Whether the client advertised `session.compaction` at initialize. */
  compactionAdvertised: boolean;
  /** Unique id for the compaction a `context_rewritten` event describes. The
   *  caller assigns it, so the mapper stays pure. */
  compactionId: string;
}

function notify(sessionId: string, update: SessionUpdate): SessionNotification {
  return { sessionId, update };
}

/**
 * Map one harness event to zero or more notifications. `usage_update` rides
 * along on every model response, so a turn that produced text sends both a
 * message chunk and the usage the client bills against.
 */
export function notificationsFor(event: HarnessEvent, ctx: NotificationContext): SessionNotification[] {
  switch (event.type) {
    case "model_response": {
      const out: SessionNotification[] = [];
      if (event.response.text) {
        out.push(
          notify(ctx.sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.response.text },
          }),
        );
      }
      out.push(usageUpdate(event.usage, ctx));
      return out;
    }
    case "tool_started":
      return [
        notify(ctx.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId: event.callId,
          title: callTitle(event.call),
          name: event.call.tool,
          kind: toolKind(event.call.tool),
          status: "pending",
        }),
      ];
    case "tool_finished":
      return [
        notify(ctx.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.callId,
          status: event.result.exitCode === 0 ? "completed" : "failed",
          // An empty array would still be a replacement, so a call with no
          // output leaves the content field out entirely.
          ...(event.result.stdout || event.result.stderr
            ? { content: toolContent(event.result) }
            : {}),
        }),
      ];
    case "plan_updated":
      return [
        notify(ctx.sessionId, {
          sessionUpdate: "plan",
          entries: event.plan.map(planEntry),
        }),
      ];
    case "context_rewritten":
      return ctx.compactionAdvertised ? compactionNotifications(event, ctx) : [];
    default:
      return [];
  }
}

/** A permission was granted, so the tool is about to start real work. */
export function permissionGrantedNotification(req: AskPermission, ctx: NotificationContext): SessionNotification {
  return notify(ctx.sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: req.toolCallId,
    status: "in_progress",
  });
}

function usageUpdate(usage: Usage, ctx: NotificationContext): SessionNotification {
  return notify(ctx.sessionId, {
    sessionUpdate: "usage_update",
    used: ctx.usedTokens,
    size: ctx.contextWindow,
    cost: { amount: usageCost(usage, DEFAULT_RATES), currency: "USD" },
  });
}

/**
 * The rewrite already happened, so report it as a completed compaction: the
 * summary chunk first (a first-seen id opens the compaction), then the
 * lifecycle close. A client that did not advertise compaction sees nothing,
 * per the schema's MUST.
 */
function compactionNotifications(
  event: Extract<HarnessEvent, { type: "context_rewritten" }>,
  ctx: NotificationContext,
): SessionNotification[] {
  const summary: ContentBlock = {
    type: "text",
    text: event.summary ?? `context rewritten: ${event.before} -> ${event.after} tokens`,
  };
  return [
    notify(ctx.sessionId, {
      sessionUpdate: "compaction_update",
      compactionId: ctx.compactionId,
      status: "in_progress",
    }),
    notify(ctx.sessionId, {
      sessionUpdate: "compaction_summary_chunk",
      compactionId: ctx.compactionId,
      content: summary,
    }),
    notify(ctx.sessionId, {
      sessionUpdate: "compaction_update",
      compactionId: ctx.compactionId,
      status: "completed",
    }),
  ];
}

/**
 * The repo's `PlanStep` has no priority and uses `done` for completion; ACP
 * requires `priority` and uses `completed`, so this is a mapping rather than a
 * pass-through. Priority is a UI hint only: the work in progress is what the
 * user is waiting on, so it ranks highest.
 */
function planEntry(step: PlanStep): PlanEntry {
  return {
    content: step.title,
    priority: step.status === "in_progress" ? "high" : step.status === "pending" ? "medium" : "low",
    status: step.status === "done" ? "completed" : step.status,
  };
}

function toolContent(result: ToolResult): ToolCallContent[] {
  if (!result.stdout && !result.stderr) return [];
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return [{ type: "content", content: { type: "text", text } }];
}

/** A one-line summary the client shows while the call is still pending. */
function callTitle(call: ToolCall): string {
  const arg = primaryArg(call);
  return arg === "" ? call.tool : `${call.tool}: ${arg}`;
}

function primaryArg(call: ToolCall): string {
  const args = call.args ?? {};
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  return "";
}

function toolKind(tool: string): ToolKind {
  switch (tool) {
    case "run":
      return "execute";
    case "write_file":
    case "edit_file":
      return "edit";
    case "read_file":
    case "cat":
      return "read";
    case "update_plan":
      return "think";
    default:
      return "other";
  }
}