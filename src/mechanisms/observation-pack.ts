import { headTailCompleteLines } from "../core/tokens.js";
import { LoopContext, Mechanism } from "../core/harness.js";
import { Message, ToolResult } from "../core/types.js";

/**
 * ObservationPack (paper Sec. 2.4).
 *
 * Large tool outputs recur in later requests even when little of their
 * content remains relevant. ObservationPack archives results above a
 * threshold locally and:
 *   - sends them in FULL for the next two provider requests,
 *   - from the third request on substitutes a stable handle, the original
 *     size, and a short excerpt of complete head and tail lines,
 *   - lets the agent recall exact pages through the handle on demand.
 *
 * Smaller results are unchanged.
 */

export interface ObservationPackOptions {
  /** Archive results larger than this many bytes. Paper: 10 KiB. */
  thresholdBytes?: number;
  /** Excerpt budget for the substituted view. Paper figure: ~1 KB. */
  excerptBytes?: number;
  /** Number of leading requests that still receive the full result. */
  fullForRequests?: number;
  /** Marker the Evidence-Preserving Reducer uses to skip already-verified output. */
  receiptMarker?: string;
}

interface ArchiveEntry {
  handle: string;
  original: string;
  bytes: number;
  birthsAtRequest: number;
}

export class ObservationPack implements Mechanism {
  readonly name = "ObservationPack";
  readonly description =
    "Archive large tool outputs locally; send full for the first two requests, then substitute a stable handle plus a head/tail excerpt, with on-demand recall.";

  private archive = new Map<string, ArchiveEntry>();
  private options: Required<ObservationPackOptions>;
  private recalls = 0;
  private substitutions = 0;

  constructor(options: ObservationPackOptions = {}) {
    this.options = {
      thresholdBytes: options.thresholdBytes ?? 10 * 1024,
      excerptBytes: options.excerptBytes ?? 1024,
      fullForRequests: options.fullForRequests ?? 2,
      receiptMarker: options.receiptMarker ?? "[RECEIPT]",
    };
  }

  transformResult(result: ToolResult, _ctx: LoopContext): ToolResult {
    // Nothing to change about the result itself; large outputs are archived
    // at projection time so the archive holds exactly what the context holds.
    return result;
  }

  projectObservation(text: string, result: ToolResult, ctx: LoopContext): string {
    if (result.bytes < this.options.thresholdBytes) return text;
    // Skip results already reduced to a verified receipt: those preserve
    // evidence and must not be excerpted.
    if (result.stdout.startsWith(this.options.receiptMarker)) return text;

    const handle = `obs:${result.callId}`;
    if (!this.archive.has(handle)) {
      this.archive.set(handle, {
        handle,
        original: text,
        bytes: result.bytes,
        birthsAtRequest: ctx.requestsSoFar,
      });
    }
    return text;
  }

  transformContext(messages: Message[], ctx: LoopContext): Message[] {
    if (this.archive.size === 0) return messages;
    let changed = false;
    const out = messages.map((m) => {
      if (m.role !== "tool" || !m.callId) return m;
      const entry = this.archive.get(`obs:${m.callId}`);
      if (!entry) return m;
      if (m.content !== entry.original) return m; // already substituted or reduced
      const age = ctx.requestsSoFar - entry.birthsAtRequest;
      if (age < this.options.fullForRequests) return m;

      changed = true;
      this.substitutions++;
      const excerpt = headTailCompleteLines(entry.original, this.options.excerptBytes);
      return {
        ...m,
        content:
          `${entry.handle} (archived, ${entry.bytes} bytes)\n${excerpt}\n` +
          `[recall the exact original with the handle above]`,
      };
    });
    return changed ? out : messages;
  }

  /** On-demand recall: returns the exact original chunk for a handle. */
  recall(handle: string, page?: number): string | undefined {
    const entry = this.archive.get(handle);
    if (!entry) return undefined;
    this.recalls++;
    if (page === undefined) return entry.original;
    const pageSize = 4096;
    const start = page * pageSize;
    return entry.original.slice(start, start + pageSize);
  }

  has(handle: string): boolean {
    return this.archive.has(handle);
  }

  get stats() {
    return {
      archived: this.archive.size,
      substituted: this.substitutions,
      recalled: this.recalls,
      bytesArchived: [...this.archive.values()].reduce((n, e) => n + e.bytes, 0),
    };
  }

  reset(): void {
    this.archive.clear();
    this.recalls = 0;
    this.substitutions = 0;
  }
}

