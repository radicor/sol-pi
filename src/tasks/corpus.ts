import { TaskSpec } from "../core/environment.js";

/**
 * A corpus of search environments (paper Sec. 2.3).
 *
 * Two families:
 *   - REPOSITORY-DERIVED: a pre-fix repository state paired with a hidden
 *     regression test that fails before the accepted patch and passes after.
 *   - VERIFIER-DRIVEN: an executable verifier defines success, allowing
 *     multiple valid solution paths.
 *
 * The corpus here is a compact stand-in for the paper's 535 environments,
 * but follows the same fail-before / pass-after construction.
 */

function bigLog(kind: string): string {
  const lines: string[] = [];
  for (let i = 0; i < 900; i++) {
    lines.push(`[dep ${i.toString().padStart(3, "0")}] ${kind}: resolving module chunk-${i} (cache miss, 14ms)`);
  }
  for (let i = 0; i < 200; i++) {
    lines.push(`[warn] ${kind}: deprecated API usage in vendor/legacy/lib-${i}.js; use v2 API instead`);
  }
  lines.push("[summary] build finished with 0 errors, 1100 modules transformed");
  return lines.join("\n");
}

const PYTHON_BUGGY = `def add(a, b):
    return a - b


def multiply(a, b):
    return a * b
`;

const PYTHON_FIXED = `def add(a, b):
    return a + b


def multiply(a, b):
    return a * b
`;

export const REPO_TASKS: TaskSpec[] = [
  {
    id: "repo-001",
    language: "python",
    category: "data-science",
    description: "Fix the arithmetic bug in math_utils.py so the add() test passes.",
    initialFiles: { "math_utils.py": PYTHON_BUGGY },
    tests: [
      {
        name: "add_returns_sum",
        fn: (files) => {
          const src = files["math_utils.py"] ?? "";
          const ok = /def add\(a, b\):\s*return a \+ b/.test(src);
          return {
            passed: ok,
            detail: ok ? "" : "AssertionError: add(2, 3) returned -1, expected 5",
          };
        },
      },
    ],
    bigLog: () => bigLog("pytest"),
  },
  {
    id: "repo-002",
    language: "typescript",
    category: "web-app",
    description: "The status formatter returns lowercase; make it uppercase to match the API contract.",
    initialFiles: {
      "format.ts": "export function formatStatus(s: string): string {\n  return s.toLowerCase();\n}\n",
    },
    tests: [
      {
        name: "formatStatus_uppercases",
        fn: (files) => {
          const ok = /toUpperCase/.test(files["format.ts"] ?? "");
          return { passed: ok, detail: ok ? "" : "AssertionError: expected 'OK', got 'ok'" };
        },
      },
    ],
    bigLog: () => bigLog("tsc"),
  },
  {
    id: "repo-003",
    language: "go",
    category: "cli-tool",
    description: "The CLI exits 0 even on failure. Return a non-zero exit code when the run fails.",
    initialFiles: { "main.go": "func main() { run(); }\n\nfunc run() bool { return false }\n" },
    tests: [
      {
        name: "propagates_exit_code",
        fn: (files) => {
          const ok = /os\.Exit\(1\)|exitCode\s*=\s*1|return false/.test(files["main.go"] ?? "") && !/func main\(\) \{ run\(\); \}/.test(files["main.go"] ?? "");
          return { passed: ok, detail: ok ? "" : "AssertionError: expected exit code 1 on failure, got 0" };
        },
      },
    ],
    bigLog: () => bigLog("go"),
  },
];

export const VERIFIER_TASKS: TaskSpec[] = [
  {
    id: "verifier-001",
    language: "python",
    category: "ml-pipeline",
    description: "Write a normalize() function in pipeline.py that scales a list into [0, 1].",
    initialFiles: { "pipeline.py": "# implement normalize\n" },
    tests: [
      {
        name: "normalize_range",
        fn: (files) => {
          const src = files["pipeline.py"] ?? "";
          const ok = /def normalize/.test(src) && /max|min/.test(src);
          return { passed: ok, detail: ok ? "" : "verifier: normalize() missing or does not scale to [0,1]" };
        },
      },
    ],
    bigLog: () => bigLog("pipeline"),
  },
  {
    id: "verifier-002",
    language: "rust",
    category: "infra",
    description: "Add a retry counter to fetch() in client.rs that retries at least twice.",
    initialFiles: { "client.rs": "fn fetch() -> bool { false }\n" },
    tests: [
      {
        name: "retries_at_least_twice",
        fn: (files) => {
          const src = files["client.rs"] ?? "";
          const ok = /retry|attempt|loop|for /.test(src);
          return { passed: ok, detail: ok ? "" : "verifier: no retry loop found" };
        },
      },
    ],
    bigLog: () => bigLog("cargo"),
  },
];

/**
 * A deliberately long task: the agent must iterate over many build cycles,
 * each producing a large log. This is the regime the paper targets, where
 * accumulated observations dominate the context and ObservationPack /
 * OnlineContext Compact have room to act.
 */
export const LONG_HORIZON_TASK: TaskSpec = {
  id: "long-horizon-001",
  language: "python",
  category: "infra",
  description: "Iterate on server.py until the health endpoint returns ok; the build log is verbose.",
  initialFiles: { "server.py": "def health():\n    return 'down'\n" },
  tests: [
    {
      name: "health_returns_ok",
      fn: (files) => {
        const ok = /def health\(\):\s*return 'ok'/.test(files["server.py"] ?? "");
        return { passed: ok, detail: ok ? "" : "AssertionError: health() returned 'down', expected 'ok'" };
      },
    },
  ],
  bigLog: () => bigLog("uvicorn"),
};

export const SEARCH_ENVIRONMENTS: TaskSpec[] = [...REPO_TASKS, ...VERIFIER_TASKS, LONG_HORIZON_TASK];

/** Held-out: never seen by the search loop. */
export const HELD_OUT_ENVIRONMENTS: TaskSpec[] = [
  {
    id: "heldout-001",
    language: "java",
    category: "docs",
    description: "The validator rejects valid emails containing '+'. Allow plus-addressing.",
    initialFiles: {
      "Validator.java": "class Validator { boolean valid(String e) { return e.matches(\"^[a-z]+@[a-z]+\\\\.[a-z]+$\"); } }\n",
    },
    tests: [
      {
        name: "allows_plus_addressing",
        fn: (files) => {
          const ok = /\+/.test(files["Validator.java"] ?? "");
          return { passed: ok, detail: ok ? "" : "AssertionError: 'a+b@x.com' rejected" };
        },
      },
    ],
    bigLog: () => bigLog("javac"),
  },
  {
    id: "heldout-002",
    language: "cpp",
    category: "cli-tool",
    description: "Buffer is fixed at 64 bytes; make it at least 1024 to prevent overflow.",
    initialFiles: { "buffer.cpp": "char buf[64];\n" },
    tests: [
      {
        name: "buffer_size_1024",
        fn: (files) => {
          const m = /buf\[(\d+)\]/.exec(files["buffer.cpp"] ?? "");
          const size = m ? Number(m[1]) : 0;
          return { passed: size >= 1024, detail: `AssertionError: buf size ${size}, expected >= 1024` };
        },
      },
    ],
    bigLog: () => bigLog("gcc"),
  },
];

export { PYTHON_BUGGY, PYTHON_FIXED, bigLog };
