import { ToolCall, ToolDefinition } from "../core/types.js";

/**
 * A model provider, below `ModelBackend`. Where `ModelBackend` is the shape the
 * harness speaks (its `Usage` feeds the cost ledger and the compaction gate),
 * this is the shape a provider wire protocol speaks. `LiveModel` is the only
 * bridge between them, so the research path never sees a provider.
 */
export interface ChatProvider {
  readonly id: string;
  readonly contextWindow: number;
  chat(req: ProviderRequest, opts?: { signal?: AbortSignal }): Promise<ProviderResponse>;
}

export interface ProviderRequest {
  systemPrompt?: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
}

export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  /** Absent for an assistant turn that carried only tool calls. */
  content?: string;
  /** Set when this message carries a tool result, to correlate with its call. */
  toolCallId?: string;
  /** Set when an assistant message carried tool calls. The ids match the
   *  `toolCallId` of the tool messages that answer them, so a provider that
   *  requires each call to be restated before its result can pair them. */
  toolCalls?: ProviderToolUse[];
}

/** A restated call: `ToolCall` plus the id that correlates it with its result. */
export interface ProviderToolUse extends ToolCall {
  callId: string;
}

export interface ProviderResponse {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason: ProviderStopReason;
  usage: ProviderUsage;
}

export type ProviderStopReason = "end_turn" | "tool_use" | "max_turns" | "refusal" | "error";

export interface ProviderUsage {
  /**
   * Input tokens billed at the full input price.
   *
   * **Contract: this MUST exclude the cached prefix and the written delta.**
   * A provider that reports a whole-prompt `input_tokens` must subtract them
   * before returning. `ScriptedModel` already honours this (it bills the
   * cached prefix at the read price and the appended tail at the write price),
   * and the ledger depends on the same convention from every real provider:
   * double-counting inflates cost and silently breaks OnlineContextCompact's
   * gate, which would undo the accounting AUDIT-3 fixed.
   */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** When the provider reports its own cost, prefer it over the price table. */
  cost?: number;
}
