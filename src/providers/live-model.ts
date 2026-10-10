import { ModelBackend } from "../core/model.js";
import { Message, ModelRequest, ModelResponse } from "../core/types.js";
import { Usage } from "../core/usage.js";
import { ChatProvider, ProviderMessage, ProviderRequest, ProviderResponse, ProviderToolUse } from "./types.js";

/**
 * The only bridge from the harness's message shape to a provider's. The harness
 * keeps its own `Message[]` (tool results carry `callId` and `name`, which a
 * provider wire does not express the same way); this flattens that into the
 * provider's roles and hoists the system prompt out of the conversation.
 */
export class LiveModel implements ModelBackend {
  readonly id: string;
  readonly contextWindow: number;
  private readonly provider: ChatProvider;

  constructor(provider: ChatProvider) {
    this.provider = provider;
    this.id = provider.id;
    this.contextWindow = provider.contextWindow;
  }

  async chat(req: ModelRequest): Promise<ModelResponse> {
    const providerReq: ProviderRequest = {
      systemPrompt: systemPromptOf(req.messages),
      messages: flatten(req.messages),
      tools: req.tools,
    };
    const res = await this.provider.chat(providerReq);
    return toModelResponse(res);
  }
}

/** Extract the system prompt; the harness keeps it as the first message. */
function systemPromptOf(messages: Message[]): string | undefined {
  const first = messages[0];
  return first && first.role === "system" ? first.content : undefined;
}

/**
 * Convert the harness's messages into the provider's roles. The harness stores
 * an assistant turn as its text followed by one `tool` message per result —
 * the calls themselves are never restated, and a turn that produced no text
 * leaves no assistant message at all. A provider expects the calls and their
 * results as one assistant turn plus a user turn carrying the results, so each
 * run of tool messages is folded back into the assistant turn it answers.
 *
 * Compaction keeps a token-budgeted tail without regard for that pairing, so
 * either half can survive alone: an assistant turn whose results were
 * summarized away still stands on its own, and a result whose turn was
 * summarized away gets a synthesized assistant turn to reply to.
 */
function flatten(messages: Message[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "system") {
      i++;
      continue;
    }
    if (m.role === "assistant") {
      const from = i + 1;
      let j = from;
      while (j < messages.length && messages[j].role === "tool") j++;
      emitAssistantTurn(out, m.content, messages, from, j);
      i = j;
      continue;
    }
    if (m.role === "tool") {
      // No assistant message precedes this turn, so synthesize one; without it
      // the results would have nothing to answer and the request is malformed.
      let j = i;
      while (j < messages.length && messages[j].role === "tool") j++;
      emitAssistantTurn(out, undefined, messages, i, j);
      i = j;
      continue;
    }
    out.push({ role: "user", content: m.content });
    i++;
  }
  return out;
}

/** Emit one assistant turn followed by the tool results that answer it. */
function emitAssistantTurn(
  out: ProviderMessage[],
  text: string | undefined,
  messages: Message[],
  from: number,
  to: number,
): void {
  const results = messages.slice(from, to);
  out.push({
    role: "assistant",
    content: text,
    toolCalls: results.length
      ? results.map((t, k) => ({
          callId: t.callId ?? `call_msg_${from + k}`,
          tool: t.name ?? "tool",
          args: t.args ?? {},
        }))
      : undefined,
  });
  for (let k = 0; k < results.length; k++) {
    const t = results[k];
    out.push({ role: "tool", content: t.content, toolCallId: t.callId ?? `call_msg_${from + k}` });
  }
}

function toModelResponse(res: ProviderResponse): ModelResponse {
  const usage: Usage = {
    input: res.usage.input,
    cacheRead: res.usage.cacheRead ?? 0,
    cacheWrite: res.usage.cacheWrite ?? 0,
    output: res.usage.output,
  };
  // `usage` stays required: a zero ledger would silently break the cost model
  // and the compaction gate, so a provider that reports nothing still gets a
  // well-formed (if empty) record rather than a hole.
  const calls = res.toolCalls ?? [];
  return {
    text: res.text,
    toolCalls: calls.length ? calls : undefined,
    usage,
    stopReason: res.stopReason === "refusal" ? "error" : res.stopReason,
  };
}
