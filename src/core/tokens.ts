const WORD_RE = /[\w']+|[^\s\w]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.match(WORD_RE);
  if (words && words.length > 0) return Math.max(1, Math.ceil((words.length * 4) / 3));
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value));
}

export function excerpt(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  const omitted = text.length - headChars - tailChars;
  return `${head}\n...[${omitted} bytes omitted]...\n${tail}`;
}

export function headTailCompleteLines(text: string, budget: number): string {
  const lines = text.split("\n");
  if (text.length <= budget) return text;
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > budget / 2) break;
    out.push(line);
    used += cost;
  }
  const tail: string[] = [];
  let tailUsed = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (tailUsed + cost > budget / 2) break;
    tail.unshift(lines[i]);
    tailUsed += cost;
  }
  const omitted = lines.length - out.length - tail.length;
  return `${out.join("\n")}\n...[${omitted} lines omitted]...\n${tail.join("\n")}`;
}
