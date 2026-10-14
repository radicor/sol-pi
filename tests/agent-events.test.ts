import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { HarnessEvent, PlanStep } from "../src/core/harness.js";
import { ToolCall, ToolResult } from "../src/core/types.js";
import { Usage } from "../src/core/usage.js";
import {
  NotificationContext,
  notificationsFor,
  permissionGrantedNotification,
} from "../src/agent/events.js";

const CTX: NotificationContext = {
  sessionId: "s1",
  contextWindow: 1000,
  usedTokens: 42,
  compactionAdvertised: false,
  compactionId: "compaction-0",
};

function updates(events: HarnessEvent[], ctx: NotificationContext = CTX): SessionUpdate[] {
  return events.flatMap((event) => notificationsFor(event, ctx).map((n) => n.update));
}

const USAGE: Usage = { input: 10, cacheRead: 5, cacheWrite: 2, output: 3 };

test("a model response with text sends the chunk and then the usage", () => {
  const [first, second] = updates([
    { type: "model_response", turn: 1, response: { text: "hello", usage: USAGE, stopReason: "tool_use" }, usage: USAGE },
  ]);
  assert.equal(first.sessionUpdate, "agent_message_chunk");
  assert.equal((first as { content: { text: string } }).content.text, "hello");
  assert.equal(second.sessionUpdate, "usage_update");
});

test("a model response without text sends only the usage", () => {
  const got = updates([
    { type: "model_response", turn: 1, response: { usage: USAGE, stopReason: "tool_use" }, usage: USAGE },
  ]);
  assert.equal(got.length, 1);
  assert.equal(got[0].sessionUpdate, "usage_update");
});

test("usage reports the context used and the window, not the response's own tokens", () => {
  const [update] = updates([
    { type: "model_response", turn: 1, response: { usage: USAGE, stopReason: "end_turn" }, usage: USAGE },
  ]);
  assert.equal((update as { used: number }).used, 42);
  assert.equal((update as { size: number }).size, 1000);
  assert.deepEqual((update as { cost: { currency: string } }).cost, { amount: 0.000068, currency: "USD" });
});

test("every notification carries the session it belongs to", () => {
  const got = notificationsFor(
    { type: "model_response", turn: 1, response: { usage: USAGE, stopReason: "end_turn" }, usage: USAGE },
    CTX,
  );
  assert.equal(got.every((n) => n.sessionId === "s1"), true);
});

test("a tool starting is pending, with the tool name and a one-line title", () => {
  const call: ToolCall = { tool: "run", args: { command: "npm test" } };
  const [update] = updates([{ type: "tool_started", turn: 1, callId: "c1", call }]);
  assert.equal(update.sessionUpdate, "tool_call");
  assert.equal((update as { status: string }).status, "pending");
  assert.equal((update as { name: string }).name, "run");
  assert.equal((update as { title: string }).title, "run: npm test");
  assert.equal((update as { toolCallId: string }).toolCallId, "c1");
});

test("tool kinds map onto ACP's vocabulary", () => {
  const kindOf = (tool: string) =>
    (updates([{ type: "tool_started", turn: 1, callId: "c1", call: { tool, args: {} } }])[0] as { kind: string }).kind;
  assert.equal(kindOf("run"), "execute");
  assert.equal(kindOf("write_file"), "edit");
  assert.equal(kindOf("edit_file"), "edit");
  assert.equal(kindOf("read_file"), "read");
  assert.equal(kindOf("cat"), "read");
  assert.equal(kindOf("update_plan"), "think");
  assert.equal(kindOf("something_new"), "other");
});

test("a tool's title falls back to its name when there is no command or path", () => {
  const [update] = updates([
    { type: "tool_started", turn: 1, callId: "c1", call: { tool: "update_plan", args: { steps: [] } } },
  ]);
  assert.equal((update as { title: string }).title, "update_plan");
});

test("a tool that succeeded is completed and carries its output", () => {
  const call: ToolCall = { tool: "run", args: { command: "npm test" } };
  const result: ToolResult = { callId: "c1", tool: "run", stdout: "ok", stderr: "", exitCode: 0, bytes: 2 };
  const [update] = updates([{ type: "tool_finished", turn: 1, callId: "c1", call, result }]);
  assert.equal(update.sessionUpdate, "tool_call_update");
  assert.equal((update as { status: string }).status, "completed");
  assert.deepEqual((update as { content: unknown[] }).content[0], {
    type: "content",
    content: { type: "text", text: "ok" },
  });
});

test("a tool that failed is failed and joins stdout with stderr", () => {
  const call: ToolCall = { tool: "run", args: { command: "npm test" } };
  const result: ToolResult = { callId: "c1", tool: "run", stdout: "out", stderr: "err", exitCode: 1, bytes: 6 };
  const [update] = updates([{ type: "tool_finished", turn: 1, callId: "c1", call, result }]);
  assert.equal((update as { status: string }).status, "failed");
  assert.equal((update as { content: { content: { text: string } }[] }).content[0].content.text, "out\nerr");
});

test("a tool with no output sends no content at all", () => {
  const call: ToolCall = { tool: "run", args: { command: "true" } };
  const result: ToolResult = { callId: "c1", tool: "run", stdout: "", stderr: "", exitCode: 0, bytes: 0 };
  const [update] = updates([{ type: "tool_finished", turn: 1, callId: "c1", call, result }]);
  assert.equal((update as { content?: unknown[] }).content, undefined);
});
test("a plan maps `done` to `completed` and ranks the work in progress highest", () => {
  const plan: PlanStep[] = [
    { id: 1, title: "Read", status: "done" },
    { id: 2, title: "Edit", status: "in_progress" },
    { id: 3, title: "Run", status: "pending" },
  ];
  const [update] = updates([{ type: "plan_updated", turn: 1, plan }]);
  const entries = (update as { entries: Array<{ content: string; status: string; priority: string }> }).entries;
  assert.deepEqual(
    entries.map((e) => [e.content, e.status, e.priority]),
    [
      ["Read", "completed", "low"],
      ["Edit", "in_progress", "high"],
      ["Run", "pending", "medium"],
    ],
  );
});

test("compaction is reported only to clients that asked for it", () => {
  const event: HarnessEvent = { type: "context_rewritten", turn: 1, before: 900, after: 100 };
  assert.deepEqual(updates([event]), []);
  const advertised: NotificationContext = { ...CTX, compactionAdvertised: true };
  const got = updates([event], advertised);
  assert.equal(got.map((u) => u.sessionUpdate).join(","), "compaction_update,compaction_summary_chunk,compaction_update");
});

test("a compaction opens with a summary and closes with the same id", () => {
  const event: HarnessEvent = { type: "context_rewritten", turn: 1, before: 900, after: 100, summary: "kept the plan" };
  const got = updates([event], { ...CTX, compactionAdvertised: true, compactionId: "compaction-7" }) as Array<{
    compactionId?: string;
    status?: string;
    content?: { text: string };
  }>;
  assert.equal(got.every((u) => u.compactionId === "compaction-7"), true);
  assert.equal(got[0].status, "in_progress");
  assert.equal(got[1].content?.text, "kept the plan");
  assert.equal(got[2].status, "completed");
});

test("a compaction without a summary still says what changed", () => {
  const got = updates(
    [{ type: "context_rewritten", turn: 1, before: 900, after: 100 }],
    { ...CTX, compactionAdvertised: true },
  ) as Array<{ content?: { text: string } }>;
  assert.equal(got[1].content?.text, "context rewritten: 900 -> 100 tokens");
});

test("a granted permission moves the tool to in_progress", () => {
  const got = permissionGrantedNotification(
    { toolCallId: "c1", kind: "execute", name: "run", target: "npm test", title: "run: npm test" },
    CTX,
  );
  assert.equal(got.sessionId, "s1");
  assert.equal(got.update.sessionUpdate, "tool_call_update");
  assert.equal((got.update as { status: string }).status, "in_progress");
  assert.equal((got.update as { toolCallId: string }).toolCallId, "c1");
});

test("events with no protocol translation produce nothing", () => {
  const silent: HarnessEvent[] = [
    { type: "run_started", plan: [] },
    { type: "model_request", turn: 1, request: { messages: [], tools: [] } },
    { type: "calls_prepared", turn: 1, calls: [] },
    { type: "observation_appended", turn: 1, callId: "c1", message: { role: "tool", content: "" } },
    { type: "plan_step_done", turn: 1, step: { id: 1, title: "Read", status: "done" } },
    { type: "turn_ended", turn: 1, entry: { turn: 1, requestTokens: 0, toolCalls: [], results: [], compacted: false } },
    { type: "run_finished", turns: 1, result: { success: false, score: 0, turns: 1, usage: USAGE, cost: 0, trace: [] } },
  ];
  assert.deepEqual(updates(silent), []);
});
