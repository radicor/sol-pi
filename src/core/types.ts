import { estimateTokens } from "./tokens.js";
import { Usage } from "./usage.js";
export { Usage };

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  tool: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  bytes: number;
  error?: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  callId?: string;
}

export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
}

export interface ModelResponse {
  text?: string;
  toolCalls?: ToolCall[];
  usage: Usage;
  stopReason: "tool_use" | "end_turn" | "max_turns" | "error";
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RunResult {
  success: boolean;
  score: number;
  turns: number;
  usage: Usage;
  cost: number;
  trace: TraceEntry[];
  failureReason?: string;
}

export interface TraceEntry {
  turn: number;
  requestTokens: number;
  toolCalls: ToolCall[];
  results: ToolResult[];
  compacted: boolean;
  note?: string;
}
