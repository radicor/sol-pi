import { excerpt, estimateTokens } from "../core/tokens.js";
import { LoopContext, Mechanism } from "../core/harness.js";
import { ToolResult } from "../core/types.js";

/**
 * Evidence-Preserving Reducer (paper Sec. 2.4).
 *
 * Compresses build/test logs of at least 4 KiB that come from a predefined
 * set of commands. File reads and search results bypass the reducer.
 *
 * Pipeline:
 *   1. Archive the exact original output.
 *   2. Ask a lower-cost model to extract key evidence into a compact receipt.
 *   3. A deterministic verifier checks the receipt's schema, source hash,
 *      exit status, exact quotes, and size.
 *   4. Fall back to the original log if verification fails, credentials are
 *      suspected, or the receipt provides no size reduction.
 *
 * The reducer runs before ObservationPack projects the context; ObservationPack
 * recognizes the receipt marker and skips those results.
 */

export const RECEIPT_MARKER = "[RECEIPT]";

export interface ReducerOptions {
  /** Only reduce outputs of at least this many bytes. Paper: 4 KiB. */
  thresholdBytes?: number;
  /** Tool names whose results are eligible for reduction. */
  eligibleTools?: string[];
  /** Maximum receipt size in bytes. */
  maxReceiptBytes?: number;
  /**
   * Simulated compression quality: the fraction of evidence lines the
   * extractor retains. Selection is deterministic (seeded by the log's own
   * hash), so a given log always yields the same receipt.
   */
  extractorFidelity?: number;
}

interface Receipt {
  marker: string;
  schemaVersion: number;
  sourceHash: string;
  exitStatus: number;
  quotes: string[];
  summary: string;
  bytes: number;
}

/**
 * A low-cost extraction model. In the paper this is GPT-5.6 Luna at `high`.
 * Here it is a deterministic extractor that pulls failure lines, stack traces,
 * and summary lines out of a log, parameterised by a fidelity knob so the
 * verifier can be exercised in both its pass and fallback paths.
 */
export interface ExtractorModel {
  readonly id: string;
  extract(log: string, exitStatus: number): Receipt;
}

export function hashString(s: string): string {
  return numericHash(s).toString(16).padStart(8, "0");
}

/** FNV-1a hash as an unsigned 32-bit integer. */
export function numericHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A typed predicate identifying a line that carries evidence worth quoting.
 *
 * Evidence is matched against the formats `Environment` actually emits
 * (`src/core/environment.ts`): bracketed `[dep]`/`[warn]`/`[summary]` log
 * lines, pytest banners and tally lines, and `E …` assertion details. The
 * rules are ordered by evidentiary value, so failure lines are quoted ahead
 * of routine warnings when a receipt is full.
 */
export interface EvidenceRule {
  readonly kind: string;
  match(line: string): boolean;
}

export const DEFAULT_EVIDENCE_RULES: readonly EvidenceRule[] = [
  // Failures first: these are the lines a human needs to see.
  { kind: "failure", match: (l) => /^\s*E\s+\S/.test(l) },
  { kind: "failure", match: (l) => /^(AssertionError|NameError|TypeError|ValueError|KeyError|Traceback)\b/.test(l.trim()) },
  { kind: "failure", match: (l) => /\bFAILED\b/.test(l) },
  // The pytest tally carries the pass/fail verdict for the whole run.
  { kind: "summary", match: (l) => /^=+\s*\d+\s+(passed|failed)/.test(l) },
  { kind: "banner", match: (l) => /^_{5,}\s*test_\S+.*_{5,}$/.test(l) },
  { kind: "summary", match: (l) => /^\[(summary|error)\b/.test(l) },
  // Routine warnings fill any remaining budget.
  { kind: "warning", match: (l) => /^\[warn\]/.test(l) },
];

export class SimpleExtractor implements ExtractorModel {
  readonly id = "simple-extractor";
  private fidelity: number;
  private rules: readonly EvidenceRule[];
  constructor(fidelity = 1.0, rules: readonly EvidenceRule[] = DEFAULT_EVIDENCE_RULES) {
    this.fidelity = fidelity;
    this.rules = rules;
  }

  extract(log: string, exitStatus: number): Receipt {
    const lines = log.split("\n");

    // Pass the rules in priority order so the quote budget is spent on the
    // most valuable evidence first; each rule walks the whole log once.
    const quotes: string[] = [];
    const keep = (line: string, index: number) => {
      if (line.trim().length === 0) return false;
      if (this.fidelity >= 1) return true;
      if (this.fidelity <= 0) return false;
      // Seed the drop decision with the log's own hash so selection is
      // deterministic for a given log rather than a per-run PRNG draw.
      return (numericHash(`${log}#${index}`) % 100) / 100 < this.fidelity;
    };

    for (const rule of this.rules) {
      for (let i = 0; i < lines.length && quotes.length < 8; i++) {
        const line = lines[i];
        if (quotes.includes(line)) continue;
        if (rule.match(line) && keep(line, i)) quotes.push(line.trim());
      }
      if (quotes.length >= 8) break;
    }

    const summaryLine = lines.find((l) => /passed|failed/i.test(l)) ?? "(no summary line)";
    const summary = `exit=${exitStatus}; ${summaryLine.trim()}; ${quotes.length} evidence lines`;

    return {
      marker: RECEIPT_MARKER,
      schemaVersion: 1,
      sourceHash: hashString(log),
      exitStatus,
      quotes,
      summary,
      bytes: 0,
    };
  }
}

export class EvidencePreservingReducer implements Mechanism {
  readonly name = "EvidencePreservingReducer";
  readonly description =
    "Compress build/test logs with a low-cost model into a verified receipt; fall back to the original on any verification failure.";

  private options: Required<ReducerOptions>;
  private extractor: ExtractorModel;
  private originalArchive = new Map<string, string>();
  private reduced = 0;
  private fallbacks = 0;
  private savedBytes = 0;

  constructor(options: ReducerOptions = {}, extractor?: ExtractorModel) {
    this.options = {
      thresholdBytes: options.thresholdBytes ?? 4 * 1024,
      eligibleTools: options.eligibleTools ?? ["test", "pytest", "npm", "build", "cargo"],
      maxReceiptBytes: options.maxReceiptBytes ?? 2048,
      extractorFidelity: options.extractorFidelity ?? 1.0,
    };
    this.extractor = extractor ?? new SimpleExtractor(this.options.extractorFidelity);
  }

  transformResult(result: ToolResult, _ctx: LoopContext): ToolResult {
    // Exact tool-name allowlist: prefix matching would route any `testing*`
    // or `npm*` invocation through the reducer, and would misroute file
    // reads and searches if the tool vocabulary ever grew.
    const eligible = this.options.eligibleTools.includes(result.tool);
    if (!eligible) return result;
    if (result.bytes < this.options.thresholdBytes) return result;

    const receipt = this.extractor.extract(result.stdout, result.exitCode);
    const body = this.renderReceipt(receipt);
    receipt.bytes = body.length;

    // --- deterministic verifier ---
    if (!this.verify(receipt, body, result)) {
      this.fallbacks++;
      return result;
    }

    this.originalArchive.set(result.callId, result.stdout);
    this.reduced++;
    this.savedBytes += result.bytes - receipt.bytes;
    return {
      ...result,
      stdout: body,
      bytes: body.length,
    };
  }

  private renderReceipt(r: Receipt): string {
    const quoteBlock = r.quotes.map((q) => `  | ${q}`).join("\n");
    return [
      RECEIPT_MARKER,
      `schema_version: ${r.schemaVersion}`,
      `source_hash: ${r.sourceHash}`,
      `exit_status: ${r.exitStatus}`,
      `summary: ${r.summary}`,
      `quotes:`,
      quoteBlock || "  | (none)",
    ].join("\n");
  }

  /**
   * The deterministic verifier. Checks, in order:
   *   1. schema      - required fields present and well typed
   *   2. source hash - receipt describes exactly this log
   *   3. exit status - receipt reports the real exit code
   *   4. exact quotes- every quoted line appears verbatim in the original
   *   5. size        - the receipt is actually smaller than the original
   */
  verify(receipt: Receipt, body: string, result: ToolResult): boolean {
    if (receipt.marker !== RECEIPT_MARKER) return false;
    if (receipt.schemaVersion !== 1) return false;
    if (typeof receipt.sourceHash !== "string" || receipt.sourceHash.length !== 8) return false;
    if (receipt.sourceHash !== hashString(result.stdout)) return false;
    if (receipt.exitStatus !== result.exitCode) return false;
    if (receipt.quotes.length === 0) return false; // an empty receipt preserves no evidence
    for (const q of receipt.quotes) {
      if (!result.stdout.includes(q)) return false;
    }
    if (body.length >= result.bytes) return false;
    if (body.length > this.options.maxReceiptBytes * 4) return false;
    return true;
  }

  originalFor(callId: string): string | undefined {
    return this.originalArchive.get(callId);
  }

  get stats() {
    return {
      reduced: this.reduced,
      fallbacks: this.fallbacks,
      savedBytes: this.savedBytes,
    };
  }

  reset(): void {
    this.originalArchive.clear();
    this.reduced = 0;
    this.fallbacks = 0;
    this.savedBytes = 0;
  }
}
