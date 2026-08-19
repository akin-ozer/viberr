import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "~/server/logging/logger.server";

/**
 * The `CODEX_HOME` a Viberr run gets — the Codex counterpart of
 * `resolveClaudeConfigDir`, and the ONLY isolation boundary Codex has.
 *
 * WHY A DEDICATED HOME (P13-LV-13 / LV-14, live-proven 2026-07-24):
 * the Claude SDK closes the host-leak channels with run options
 * (`settingSources: []`, `plugins: []`, `skills: []`, `Skill` denied). The Codex
 * SDK has NO equivalent option — everything ambient is read out of
 * `$CODEX_HOME`, and the CLI merges `--config` overrides INTO the loaded
 * `config.toml` per dotted leaf key rather than replacing a table. Verified
 * against codex-cli 0.144.6:
 *
 *   $ cd <ws> && codex -c 'mcp_servers.viberr_probe.url="http://…"' mcp list
 *   → viberr_probe  AND  computer-use, node_repl, sites-design-picker   ← host
 *   $ CODEX_HOME=<clean> codex -c 'mcp_servers.viberr_probe.url="http://…"' mcp list
 *   → viberr_probe                                                       ← only
 *
 * The same walk showed a Viberr run inheriting the host's 20+ global/plugin
 * skills (`imagegen`, `github:yeet`, `openai-developers:*`, …) and the host's
 * `AGENTS.md` merge. Pointing every run at an app-owned home closes host
 * `config.toml` (models, `notify`, MCP servers), `skills/`, `plugins/`,
 * `marketplaces`, `hooks`, `rules/` and `$CODEX_HOME/AGENTS.md` in one move.
 *
 * AUTH still has to work, so `prepareCodexHome` mirrors the human's
 * `auth.json` (a symlink when possible, so a CLI token refresh stays coherent
 * with the login the operator manages) — nothing else is copied.
 *
 * These read the RAW process env rather than `getEnv()` because the codex
 * availability probe (`codexCliAuthDiagnostics`) is deliberately live/
 * re-probing: a deployment that drops `auth.json` in mid-process must become
 * available without a restart, and `getEnv()` is cached for the process
 * lifetime.
 */

const DEFAULT_DATA_ROOT = "./data";

/** Where the human's `codex login` credentials live (never used as a run home). */
export function resolveCodexAuthSource(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Home comes from the env this was HANDED, so a caller passing an explicit
  // env gets an answer derived only from it. Identical in production (where
  // `env` IS `process.env`, which is what `os.homedir()` reads on POSIX) — the
  // difference is that nothing here silently depends on the machine. Same
  // idiom as `codexCliAuthDiagnostics`, which learned it the hard way.
  return env.CODEX_HOME || path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".codex");
}

/**
 * The app-owned home every Viberr codex run uses. In the container this is the
 * SAME path the image already sets (`CODEX_HOME=/data/runtimes/codex-home` with
 * `VIBERR_DATA_ROOT=/data`), so the documented docker auth recipe is unchanged;
 * on a developer machine it moves runs off the personal `~/.codex`.
 */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.VIBERR_DATA_ROOT || DEFAULT_DATA_ROOT,
    "runtimes",
    "codex-home",
  );
}

/** Every dir a codex session transcript may live in: the run home, plus the
 *  human's login dir when a deployment pointed CODEX_HOME somewhere else (runs
 *  recorded before the run home existed are still exportable). */
export function codexSessionRoots(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = resolveCodexHome(env);
  const source = path.resolve(resolveCodexAuthSource(env));
  return source === home ? [home] : [home, source];
}

function mtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function isTruthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/** What `prepareCodexHome` resolved for a run. */
export interface PreparedCodexHome {
  home: string;
  authSource: string;
  /** True when this call created or refreshed the mirrored auth.json. */
  authMirrored: boolean;
}

/**
 * Materialize the run home: create it, and mirror the human's `auth.json` into
 * it when the two differ. Prefers a SYMLINK (the CLI refreshes the subscription
 * token in place, so a link keeps the app and the operator's own `codex` CLI on
 * one credential); falls back to a copy where symlinks are unavailable, and
 * refreshes a stale copy when the source is newer (a re-login).
 *
 * Called per RUN (from `selectAdapter`), not once per process: the adapter set
 * is built once, so a boot-time-only mirror never saw an `auth.json` that landed
 * afterwards — the exact state the availability probe reports as "available, no
 * restart needed" (P14-RT-05). Idempotent and cheap enough for that: it returns
 * before touching the disk outside cached-login mode, and a live symlink costs
 * one lstat.
 *
 * Only touches the filesystem in CACHED-LOGIN mode (`VIBERR_CODEX_USE_CLI_AUTH`)
 * — that is the only auth mode where `auth.json` is consulted at all; token and
 * API-key modes carry the credential in the spawn env. That also keeps `npm
 * test` (which blanks the flag, F10-10) from ever linking a developer's
 * personal `~/.codex/auth.json` into a data root.
 *
 * Never throws — an unpreparable home degrades to "codex unavailable" through
 * the normal credential probe rather than crashing adapter construction.
 */
export function prepareCodexHome(
  env: NodeJS.ProcessEnv = process.env,
): PreparedCodexHome {
  const home = resolveCodexHome(env);
  const authSource = path.resolve(resolveCodexAuthSource(env));
  let authMirrored = false;
  if (!isTruthy(env.VIBERR_CODEX_USE_CLI_AUTH)) {
    return { home, authSource, authMirrored };
  }
  try {
    mkdirSync(home, { recursive: true });
    if (authSource === home) return { home, authSource, authMirrored };

    const src = path.join(authSource, "auth.json");
    const dst = path.join(home, "auth.json");
    if (!existsSync(src)) return { home, authSource, authMirrored };

    let dstKind: "missing" | "link" | "file" = "missing";
    try {
      dstKind = lstatSync(dst).isSymbolicLink() ? "link" : "file";
    } catch {
      dstKind = "missing";
    }
    // A live symlink already tracks the source — nothing to do.
    if (dstKind === "link") return { home, authSource, authMirrored };
    if (dstKind === "file") {
      // A copy only exists because symlinking failed (or the CLI replaced the
      // link during an atomic token rewrite). Refresh it after a re-login.
      if (mtimeMs(src) > mtimeMs(dst)) {
        copyFileSync(src, dst);
        authMirrored = true;
      }
      return { home, authSource, authMirrored };
    }
    try {
      symlinkSync(src, dst);
    } catch {
      copyFileSync(src, dst);
    }
    authMirrored = true;
  } catch (error) {
    logger.warn("codex run home could not be prepared", {
      home,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  return { home, authSource, authMirrored };
}
