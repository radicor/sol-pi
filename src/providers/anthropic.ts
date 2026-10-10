import { ToolCall, ToolDefinition } from "../core/types.js";
import { ChatProvider, ProviderMessage, ProviderRequest, ProviderResponse, ProviderStopReason, ProviderUsage } from "./types.js";

/**
 * Anthropic Messages API as a `ChatProvider`. Uses Node 22's global `fetch` —
 * no HTTP dependency to add or keep in sync with the lockfile.
 *
 * Two details are load-bearing rather than cosmetic:
 *
 * 1. `cache_control` breakpoints. Without them the API bills every request as
 *    a full input and reports `cache_read_input_tokens: 0`, which would make
 *    the cost ledger's cache columns dead on the only provider that can report
 *    them natively — the live counterpart of the round-3 bug. The system block
 *    carries one breakpoint, and the last block of the last message carries
 *    another: the conversation is append-only, so that final block is the end
 *    of the stable prefix and everything before it stays cached across turns.
 *    A mechanism that rewrites mid-context simply misses, which is correct.
 * 2. Errors never throw. `Harness` does not catch, so a network failure would
 *    kill the session instead of ending the turn. 401/429/5xx and transport
 *    errors all resolve to `{ stopReason: "error" }` carrying a summary the
 *    model and the host can both read.
 */
export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_TOKENS = 8192;

export class AnthropicProvider implements ChatProvider {
  readonly id: string;
  readonly contextWindow = 200_000;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `anthropic:${this.model}`;
  }

  async chat(req: ProviderRequest, opts?: { signal?: AbortSignal }): Promise<ProviderResponse> {
    const body = toRequestBody(req, this.model, this.maxTokens);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: opts?.signal,
      });
    } catch (err) {
      // Transport failure, DNS, TLS, or an aborted request. Report, don't throw.
      return errorResponse(`network error: ${messageOf(err)}`);
    }

    if (!res.ok) return errorResponse(await httpError(res));

    const parsed = await res.json().catch(() => undefined);
    if (!parsed || typeof parsed !== "object") return errorResponse("response was not JSON");
    return toProviderResponse(parsed as AnthropicResponse);
  }
}

function errorResponse(text: string): ProviderResponse {
  return { text, stopReason: "error", usage: { input: 0, output: 0 } };
}

async function httpError(res: Response): Promise<string> {
  const detail = await res.text().catch(() => "");
  const trimmed = detail.trim();
  const suffix = trimmed ? ` — ${trimmed.slice(0, 400)}` : "";
  return `anthropic HTTP ${res.status}${suffix}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- request ---------------------------------------------------------------

interface AnthropicContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContent[];
}

function toRequestBody(req: ProviderRequest, model: string, maxTokens: number): Record<string, unknown> {
  const messages: AnthropicMessage[] = req.messages.map((m) => toAnthropicMessage(m));
  // The final block of the final message ends the stable prefix; marking it
  // keeps every earlier turn in the cache across an append-only conversation.
  const last = messages[messages.length - 1];
  if (last) {
    const lastBlock = last.content[last.content.length - 1];
    if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
  }

  const system: AnthropicContent[] | undefined = req.systemPrompt
    ? [{ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }]
    : undefined;

  const out: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    tools: req.tools.map(toAnthropicTool),
  };
  if (system) out.system = system;
  return out;
}

function toAnthropicMessage(m: ProviderMessage): AnthropicMessage {
  if (m.role === "tool") {
    // Anthropic models a tool result as user-side content keyed by the call.
    return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length) {
    const content: AnthropicContent[] = [];
    if (m.content) content.push({ type: "text", text: m.content });
    for (const c of m.toolCalls) {
      // The id must match the `tool_use_id` on the result that answers it;
      // `LiveModel` derives both from the same callId.
      content.push({ type: "tool_use", id: c.callId, name: c.tool, input: c.args });
    }
    return { role: "assistant", content };
  }
  return { role: m.role, content: [{ type: "text", text: m.content }] };
}

function toAnthropicTool(t: ToolDefinition): Record<string, unknown> {
  return { name: t.name, description: t.description, input_schema: t.parameters };
}

// --- response ---------------------------------------------------------------

interface AnthropicResponse {
  stop_reason?: string;
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function toProviderResponse(res: AnthropicResponse): ProviderResponse {
  const blocks = res.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("");

  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ tool: b.name as string, args: (b.input ?? {}) as Record<string, unknown> }));

  return {
    text: text || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    stopReason: mapStopReason(res.stop_reason),
    usage: mapUsage(res.usage),
  };
}

function mapStopReason(reason?: string): ProviderStopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_turns";
    case "refusal":
      return "refusal";
    default:
      // `stop_sequence` and `pause_turn` end the turn without more tool work.
      return "end_turn";
  }
}

function mapUsage(u?: AnthropicResponse["usage"]): ProviderUsage {
  const usage = u ?? {};
  // `input_tokens` already excludes the cached prefix and the written delta, so
  // it maps straight onto the ledger's `input` without adjustment.
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}
