import { TaskSpec } from "../core/environment.js";

/**
 * The task spec for a live session. Nothing is scripted, there is no test suite
 * to score, and the initial files are whatever is already on disk. `finish()`
 * already treats `tests: []` as score 0, so a live session reports `success:
 * false` without a new conditional on the research path — and the agent path
 * uses `stopReason` as its success signal anyway.
 */
export function liveTask(cwd: string): TaskSpec {
  return {
    id: `live:${cwd}`,
    language: "typescript",
    category: "cli-tool",
    description: `Work in ${cwd} as directed by the user.`,
    initialFiles: {},
    tests: [],
  };
}
