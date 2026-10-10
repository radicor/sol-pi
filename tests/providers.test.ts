import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ScriptedModel } from "../src/core/model.js";
import { Message, ModelRequest, ModelResponse } from "../src/core/types.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { LiveModel } from "../src/providers/live-model.js";
import { providerFromEnv } from "../src/providers/index.js";
import { ScriptedProvider } from "../src/providers/scripted-provider.js";
import { ChatProvider, ProviderRequest } from "../src/providers/types.js";

/** A fetch that records the request body and returns a canned API response. */
function stub(body: unknown, status = 200): { fetchImpl: typeof fetch; lastBody: () => Record<string, unknown> } {
  let captured: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, lastBody: () => captured as Record<string, unknown> };
}

const OK_USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 200,
  cache_creation_input_tokens: 30,
};
const OK = { stop_reason: "end_turn", content: [{ type: "text", text: "hello" }], usage: OK_USAGE };

const REQ = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

test("anthropic usage maps 1:1 onto the ledger fields", async () => {
  const { fetchImpl } = stub(OK);
  const res = await new AnthropicProvider({ apiKey: "k", model: "m", fetchImpl }).chat(REQ);
  assert.deepEqual(res.usage, { input: 100, output: 50, cacheRead: 200, cacheWrite: 30 });
});

test("anthropic marks cache breakpoints on the system block and the stable prefix tail", async () => {
  const { fetchImpl, lastBody } = stub(OK);
  await new AnthropicProvider({ apiKey: "k", model: "m", fetchImpl }).chat({
    systemPrompt: "be helpful",
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ],
    tools: [],
  });
  const body = lastBody();
  const system = body.system as { cache_control?: { type: string } }[];
  assert.equal(system[0].cache_control?.type, "ephemeral");
  const messages = body.messages as { content: { cache_control?: { type: string } }[] }[];
  const last = messages[messages.length - 1];
  assert.equal(last.content[last.content.length - 1].cache_control?.type, "ephemeral");
  // Earlier blocks carry no breakpoint: the cache ends where the prefix does.
  assert.equal(messages[0].content[0].cache_control, undefined);
});

test("anthropic maps max_tokens to max_turns", async () => {
  const { fetchImpl } = stub({ ...OK, stop_reason: "max_tokens" });
  const res = await new AnthropicProvider({ apiKey: "k", model: "m", fetchImpl }).chat(REQ);
  assert.equal(res.stopReason, "max_turns");
});

test("anthropic restates an assistant turn with ids matching its results", async () => {
  const { fetchImpl, lastBody } = stub(OK);
  await new AnthropicProvider({ apiKey: "k", model: "m", fetchImpl }).chat({
    messages: [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "on it",
        toolCalls: [{ callId: "call_1", tool: "run", args: { command: "npm test" } }],
      },
      { role: "tool", content: "passing", toolCallId: "call_1" },
    ],
    tools: [],
  });
  const messages = lastBody().messages as Record<string, unknown>[];
  const asst = messages[1] as { role: string; content: Record<string, unknown>[] };
  assert.equal(asst.role, "assistant");
  assert.equal(asst.content[0].type, "text");
  const use = asst.content[1];
  assert.equal(use.type, "tool_use");
  assert.equal(use.id, "call_1");
  assert.equal(use.name, "run");
  assert.deepEqual(use.input, { command: "npm test" });
  const result = messages[2] as { role: string; content: Record<string, unknown>[] };
  assert.equal(result.role, "user");
  assert.equal(result.content[0].type, "tool_result");
  assert.equal(result.content[0].tool_use_id, "call_1");
});

test("a 401 resolves to an error response instead of throwing", async () => {
  const { fetchImpl } = stub({ error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
  const res = await new AnthropicProvider({ apiKey: "bad", model: "m", fetchImpl }).chat(REQ);
  assert.equal(res.stopReason, "error");
  assert.match(res.text ?? "", /HTTP 401/);
});

test("a malformed response body resolves to an error response", async () => {
  const fetchImpl = (async () => new Response("not json at all", { status: 200 })) as typeof fetch;
  const res = await new AnthropicProvider({ apiKey: "k", model: "m", fetchImpl }).chat(REQ);
  assert.equal(res.stopReason, "error");
});

test("a transport failure resolves to an error response", async () => {
  const fetchImpl = (async () => {
    throw new Error("ENOTFOUND example.com");
  }) as typeof fetch;
  const res = await new AnthropicProvider({ apiKey: "k", model: "m", fetchImpl }).chat(REQ);
  assert.equal(res.stopReason, "error");
  assert.match(res.text ?? "", /ENOTFOUND/);
});

/** A provider that records every request `LiveModel` sends it. */
function capture(): { provider: ChatProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const provider: ChatProvider = {
    id: "capture",
    contextWindow: 200_000,
    async chat(req: ProviderRequest): Promise<{ text?: string; stopReason: "end_turn"; usage: { input: number; output: number } }> {
      requests.push(req);
      return { stopReason: "end_turn", usage: { input: 1, output: 1 } };
    },
  };
  return { provider, requests };
}

test("LiveModel hoists the system prompt out of the conversation", async () => {
  const { provider, requests } = capture();
  await new LiveModel(provider).chat({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    tools: [],
  });
  assert.equal(requests[0].systemPrompt, "sys");
  assert.deepEqual(requests[0].messages.map((m) => m.role), ["user"]);
});

test("LiveModel folds a turn's results back into the assistant message that produced them", async () => {
  const { provider, requests } = capture();
  await new LiveModel(provider).chat({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: "running" },
      { role: "tool", content: "ok", name: "run", callId: "call_1", args: { command: "npm test" } },
    ],
    tools: [],
  });
  const msgs = requests[0].messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, "assistant");
  assert.deepEqual(msgs[1].toolCalls, [{ callId: "call_1", tool: "run", args: { command: "npm test" } }]);
  assert.equal(msgs[2].role, "tool");
  assert.equal(msgs[2].toolCallId, "call_1");
});

test("LiveModel synthesizes an assistant turn for a turn that produced no text", async () => {
  const { provider, requests } = capture();
  await new LiveModel(provider).chat({
    messages: [
      { role: "user", content: "go" },
      { role: "tool", content: "ok", name: "run", callId: "call_2", args: { command: "npm test" } },
    ],
    tools: [],
  });
  const msgs = requests[0].messages;
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].content, undefined);
  assert.deepEqual(msgs[1].toolCalls, [{ callId: "call_2", tool: "run", args: { command: "npm test" } }]);
  assert.equal(msgs[2].toolCallId, "call_2");
});

test("LiveModel leaves an assistant turn standing alone when compaction took its results", async () => {
  const { provider, requests } = capture();
  await new LiveModel(provider).chat({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "running" },
    ],
    tools: [],
  });
  const msgs = requests[0].messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].toolCalls, undefined);
});

test("a refusal from the provider becomes an error for the harness", async () => {
  const provider: ChatProvider = {
    id: "refuser",
    contextWindow: 200_000,
    async chat() {
      return { stopReason: "refusal", usage: { input: 1, output: 1 } };
    },
  };
  const res = await new LiveModel(provider).chat({ messages: [{ role: "user", content: "go" }], tools: [] });
  assert.equal(res.stopReason, "error");
  // The ledger still gets a well-formed record, never a hole.
  assert.deepEqual(res.usage, { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
});

/** A scripted model that records the request it was given, for round-trip checks. */
class RecordingScripted extends ScriptedModel {
  readonly seen: ModelRequest[] = [];
  override async chat(req: ModelRequest): Promise<ModelResponse> {
    this.seen.push(req);
    return super.chat(req);
  }
}

test("the scripted provider round-trips the harness's messages losslessly", async () => {
  const scripted = new RecordingScripted({ id: "s" });
  scripted.load([{ kind: "done", summary: "ok" }]);
  const messages: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "running" },
    { role: "tool", content: "ok", name: "run", callId: "call_1", args: { command: "npm test" } },
    { role: "user", content: "again" },
  ];
  await new LiveModel(new ScriptedProvider(scripted)).chat({ messages, tools: [] });
  assert.deepEqual(scripted.seen[0].messages, messages);
});

test("providerFromEnv rejects an unknown provider name", () => {
  assert.throws(() => providerFromEnv({ SOLPI_PROVIDER: "nope" }), /unknown/);
});

test("providerFromEnv requires ANTHROPIC_API_KEY for the default provider", () => {
  assert.throws(() => providerFromEnv({}), /ANTHROPIC_API_KEY/);
});

test("providerFromEnv requires SOLPI_SCRIPT for the scripted provider", () => {
  assert.throws(() => providerFromEnv({ SOLPI_PROVIDER: "scripted" }), /SOLPI_SCRIPT/);
});

test("providerFromEnv rejects a script file that is not a valid script", () => {
  const tmp = path.join(tmpdir(), `solpi-bad-script-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify([{ kind: "nope" }]));
  try {
    assert.throws(() => providerFromEnv({ SOLPI_PROVIDER: "scripted", SOLPI_SCRIPT: tmp }), /not a valid ScriptStep/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("providerFromEnv configures the anthropic provider from the environment", () => {
  const p = providerFromEnv({
    ANTHROPIC_API_KEY: "k",
    SOLPI_MODEL: "claude-opus-5-5",
    ANTHROPIC_BASE_URL: "https://example.test",
  }) as AnthropicProvider;
  assert.equal(p.id, "anthropic:claude-opus-5-5");
});

test("providerFromEnv loads a script from disk for the scripted provider", () => {
  const tmp = path.join(tmpdir(), `solpi-script-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify([{ kind: "done", summary: "ok" }]));
  try {
    const p = providerFromEnv({ SOLPI_PROVIDER: "scripted", SOLPI_SCRIPT: tmp, SOLPI_MODEL: "scripted-test" });
    assert.equal(p.id, "scripted-test");
  } finally {
    fs.unlinkSync(tmp);
  }
});
