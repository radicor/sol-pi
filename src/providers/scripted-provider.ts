import { ScriptedModel, ScriptStep } from "../core/model.js";
import { Message, ModelRequest, ModelResponse } from "../core/types.js";
import { ChatProvider, ProviderRequest, ProviderResponse, ProviderToolUse } from "./types.js";

/**
 * `ChatProvider` over `ScriptedModel`, so the agent path can be exercised
 * end-to-end with no network (`SOLPI_PROVIDER=scripted`). `LiveModel` flattens
 * the harness's messages into the provider shape; this adapter flattens them
 * back, and the scripted model's usage and prefix-cache accounting then run
 * exactly as they do in a research run. The round trip is lossless, so a script
 * behaves the same on either side of the seam.
 */
export class ScriptedProvider implements ChatProvider {
  readonly id: string;
  readonly contextWindow: number;
  private readonly model: ScriptedModel;

  constructor(model: ScriptedModel) {
    this.model = model;
    this.id = model.id;
    this.contextWindow = model.contextWindow;
  }

  load(steps: ScriptStep[]): void {
    this.model.load(steps);
  }

  reset(): void {
    this.model.reset();
  }

  async chat(req: ProviderRequest): Promise<ProviderResponse> {
    const res = await this.model.chat(toModelRequest(req));
    return toProviderResponse(res);
  }
}

/**
 * Invert `LiveModel`'s flattening. The provider shape restates each assistant
 * turn together with the calls its results answer, so the harness's messages
 * come back byte-for-byte: a turn that carried no text contributes no assistant
 * message, and the tool names and arguments are recovered by matching each
 * result against the call it answers.
 */
function toModelRequest(req: ProviderRequest): ModelRequest {
  const messages: Message[] = [];
  if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
  let calls: ProviderToolUse[] | undefined;
  for (const m of req.messages) {
    if (m.role === "assistant") {
      if (m.content) messages.push({ role: "assistant", content: m.content });
      calls = m.toolCalls;
      continue;
    }
    if (m.role === "tool") {
      const call = calls?.find((c) => c.callId === m.toolCallId);
      messages.push({
        role: "tool",
        content: m.content ?? "",
        callId: m.toolCallId,
        name: call?.tool,
        args: call?.args,
      });
      continue;
    }
    messages.push({ role: "user", content: m.content ?? "" });
  }
  return { messages, tools: req.tools };
}

function toProviderResponse(res: ModelResponse): ProviderResponse {
  return { text: res.text, toolCalls: res.toolCalls, stopReason: res.stopReason, usage: res.usage };
}
