import { Mechanism, PlanStep, LoopContext } from "../core/harness.js";
import { ToolCall, ToolDefinition, ToolResult } from "../core/types.js";

/**
 * Action Fusion (paper Sec. 2.4).
 *
 * Base harness: the agent edits a file, reads the result, then issues a
 * separate command to test/build/run it. That is three API calls
 * (edit -> read result -> choose run -> receive output).
 *
 * Action Fusion adds an optional `then_run` parameter to file-mutation tools
 * and returns both outcomes in a single observation, eliminating one
 * intermediate model round trip. Commands that need to inspect the mutation
 * result stay separate.
 */
export interface ActionFusionOptions {
  /** Only fuse when the follow-up command does not depend on reading the edit. */
  allowReadDependent?: boolean;
}

export class ActionFusion implements Mechanism {
  readonly name = "ActionFusion";
  readonly description =
    "Combine a file mutation with its follow-up command into one tool request, returning both outcomes in a single observation.";
  private fused = 0;
  private options: ActionFusionOptions;

  constructor(options: ActionFusionOptions = {}) {
    this.options = options;
  }

  transformTools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.map((t) => {
      if (t.name !== "write_file" && t.name !== "edit_file") return t;
      return {
        ...t,
        description: `${t.description} Optionally pass then_run (string[]) to execute shell commands immediately after the mutation; their output is returned in the same observation.`,
        parameters: {
          ...(t.parameters as Record<string, unknown>),
          properties: {
            ...((t.parameters as Record<string, unknown>).properties as Record<string, unknown>),
            then_run: {
              type: "array",
              items: { type: "string" },
              description: "Shell commands to run after the mutation completes.",
            },
          },
        },
      };
    });
  }

  transformCalls(calls: ToolCall[], _ctx: LoopContext): ToolCall[] {
    if (calls.length < 2) return calls;
    const [a, b] = calls;
    const isMutation = a.tool === "write_file" || a.tool === "edit_file";
    const isFollowRun = b.tool === "run";
    if (!isMutation || !isFollowRun) return calls;

    const command = String(b.args.command ?? "");
    // Commands that inspect the mutation result must stay separate.
    const needsInspection = /^(cat|head|tail|grep|read)\b/.test(command);
    if (needsInspection && !this.options.allowReadDependent) return calls;

    this.fused++;
    return [{ ...a, args: { ...a.args, then_run: [command] } }];
  }

  transformResult(result: ToolResult, _ctx: LoopContext): ToolResult {
    return result;
  }

  get fusedCount(): number {
    return this.fused;
  }

  get stats() {
    return { fused: this.fused };
  }

  reset(): void {
    this.fused = 0;
  }
}

export function planStep(plan: PlanStep[], id: number): PlanStep | undefined {
  return plan.find((s) => s.id === id);
}
