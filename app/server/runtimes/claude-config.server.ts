import os from "node:os";
import path from "node:path";
import { getEnv } from "~/server/config/env.server";

function isTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The single resolver for the config/HOME dir the spawned Claude runtime reads
 * and writes (session transcripts live under `<dir>/projects/<cwd>/<sid>.jsonl`).
 *
 * There must be ONE resolver: the runtime adapter tells the SDK where to write
 * transcripts, and `session-export` reads them back. When the two disagreed,
 * every real run's transcript landed somewhere the exporter never looked and
 * the "download session" action 404'd. Both now call this.
 *
 * A machine authenticated purely through the logged-in `claude` CLI
 * (`VIBERR_CLAUDE_USE_CLI_AUTH`, no explicit override) keeps its real
 * `~/.claude` so the stored credentials resolve; everyone else gets an
 * app-owned dir under the data root so transcripts stay with the instance and
 * out of the operator's personal config. An explicit `CLAUDE_CONFIG_DIR`
 * always wins.
 */
export function resolveClaudeConfigDir(): string {
  const env = getEnv();
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  if (isTruthy(env.VIBERR_CLAUDE_USE_CLI_AUTH)) {
    return path.join(os.homedir(), ".claude");
  }
  return path.resolve(env.VIBERR_DATA_ROOT, "runtimes", "claude-home");
}
