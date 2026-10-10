import { readFileSync } from "node:fs";
import { ScriptedModel, ScriptStep } from "../core/model.js";
import { z } from "zod";
import { AnthropicProvider } from "./anthropic.js";
import { ScriptedProvider } from "./scripted-provider.js";
import { ChatProvider } from "./types.js";

/**
 * The one place provider configuration is resolved. Only the agent entry point
 * imports this — the research path builds its `ScriptedModel` directly and must
 * never reach a provider, so a misconfiguration fails here rather than silently
 * changing what a research run talks to.
 */
export function providerFromEnv(env: Record<string, string | undefined> = process.env): ChatProvider {
  const kind = env.SOLPI_PROVIDER ?? "anthropic";
  switch (kind) {
    case "anthropic":
      return anthropicFromEnv(env);
    case "scripted":
      return scriptedFromEnv(env);
    default:
      throw new Error(
        `SOLPI_PROVIDER=${kind} is unknown; use "anthropic" (default) or "scripted" (offline, needs SOLPI_SCRIPT).`,
      );
  }
}

function anthropicFromEnv(env: Record<string, string | undefined>): ChatProvider {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set, so the agent has no model to call. " +
        'Set it, or use SOLPI_PROVIDER=scripted with SOLPI_SCRIPT for an offline run.',
    );
  }
  return new AnthropicProvider({
    apiKey,
    model: env.SOLPI_MODEL ?? "claude-sonnet-5-5",
    baseUrl: env.ANTHROPIC_BASE_URL,
  });
}

function scriptedFromEnv(env: Record<string, string | undefined>): ChatProvider {
  const path = env.SOLPI_SCRIPT;
  if (!path) {
    throw new Error(
      "SOLPI_PROVIDER=scripted needs SOLPI_SCRIPT=<path>, pointing at a JSON file holding a " +
        "ScriptStep[] script (kinds: tool | text | done).",
    );
  }
  const steps = parseScript(path, readFileSync(path, "utf8"));
  const model = new ScriptedModel({ id: env.SOLPI_MODEL ?? "scripted" });
  model.load(steps);
  return new ScriptedProvider(model);
}

const callSchema = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) });
const stepSchema = z.union([
  z.object({ kind: z.literal("tool"), calls: z.array(callSchema) }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("done"), summary: z.string() }),
]);

function parseScript(path: string, contents: string): ScriptStep[] {
  const json = JSON.parse(contents);
  const parsed = z.array(stepSchema).safeParse(json);
  if (!parsed.success) {
    throw new Error(`SOLPI_SCRIPT at ${path} is not a valid ScriptStep[] script: ${parsed.error.message}`);
  }
  return parsed.data;
}
