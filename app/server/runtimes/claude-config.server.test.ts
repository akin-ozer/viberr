import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import {
  resolveClaudeConfigDir,
  resolveClaudeConfigDirFrom,
} from "./claude-config.server";

/**
 * The Claude config/HOME resolver — the ONE place that decides where a spawned
 * run reads and writes `projects/<encoded cwd>/<sid>.jsonl`.
 *
 * WHY THIS FILE EXISTS. Three consumers depend on this answer and none of them
 * is the same call site:
 *   - `createAdapters` bakes it into the child's `CLAUDE_CONFIG_DIR`
 *     (runtime-registry.server.ts) — the WRITE side;
 *   - `session-export` reads transcripts back out of `<dir>/projects`
 *     (session-export.server.ts) — the READ side;
 *   - `claudeCliAuthDiagnostics` calls the raw-env twin per probe and reports
 *     the backend UNAVAILABLE when `<dir>` does not exist (D2).
 * The module's own doc comment names the defect: "When the two disagreed, every
 * real run's transcript landed somewhere the exporter never looked and the
 * 'download session' action 404'd… the two must never disagree." Nothing in the
 * suite imported this module (pass 33 coverage inventory), so that sentence was
 * a comment, not a guard — ruling 65: a rule whose guard cannot go red is a rule
 * that gets reverted in silence.
 *
 * The order under test is the documented one (docs/domain/agents-and-runtime.md
 * and docs/operations/configuration.md): `CLAUDE_CONFIG_DIR` wins; else with CLI
 * auth on, `~/.claude`; else `<dataRoot>/runtimes/claude-home`.
 *
 * TWO FUNCTIONS, ONE RULE. `resolveClaudeConfigDir()` reads the validated,
 * process-lifetime `getEnv()` cache; `resolveClaudeConfigDirFrom(env)` reads a
 * raw env snapshot because the credential probe must be LIVE (a credential
 * fixed at runtime has to heal without a restart). That is a difference of
 * SOURCE, never of rule — so the last describe block below asserts the two
 * agree on a table of real deployments, which is the assertion the docstring
 * actually asks for.
 */

/** Every key either resolver consults. Saved and restored around each test. */
const ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "VIBERR_CLAUDE_USE_CLI_AUTH",
  "VIBERR_DATA_ROOT",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The cached resolver reads `getEnv()`; a test that moved the process env
  // must drop the cache on the way OUT as well as on the way in, or it leaks
  // its data root into every later file in this worker.
  resetEnvCacheForTests();
});

/**
 * Put a snapshot on the real process env and drop the validated-env cache, so
 * `resolveClaudeConfigDir()` sees exactly the environment `…From()` is handed.
 * A key absent from the snapshot is DELETED, not left standing — otherwise a
 * previous case's data root would decide the next case's answer.
 */
function applyToProcess(env: NodeJS.ProcessEnv): void {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCacheForTests();
}

/** `<cwd>/data/runtimes/claude-home` — what an unset data root has to mean. */
const DEFAULT_DIR = path.join(
  process.cwd(),
  "data",
  "runtimes",
  "claude-home",
);

describe("resolveClaudeConfigDirFrom (the live-env rule)", () => {
  it("an explicit CLAUDE_CONFIG_DIR wins over the CLI-auth flag and the data root", () => {
    // The shipped image sets CLAUDE_CONFIG_DIR=/data/runtimes/claude-home
    // explicitly (docs/operations/configuration.md) and an operator may point
    // it at a mounted volume so resumable sessions survive a redeploy. If any
    // lower branch could outrank it, the dir the operator mounted stops being
    // the dir runs write to, and every "download session" after the redeploy
    // 404s against an empty volume.
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: "/mnt/sessions/claude",
      VIBERR_CLAUDE_USE_CLI_AUTH: "1",
      VIBERR_DATA_ROOT: "/data",
    };
    expect(resolveClaudeConfigDirFrom(env)).toBe("/mnt/sessions/claude");
  });

  it("CLI-auth mode resolves the real ~/.claude, where the stored login lives", () => {
    // VIBERR_CLAUDE_USE_CLI_AUTH means "authenticate as the logged-in `claude`
    // CLI on this machine". The credential lives in the human's own ~/.claude
    // (or, on darwin, the Keychain that dir stands for), so pointing a run at
    // an app-owned dir under the data root would make the opt-in unusable:
    // `claudeCliAuthDiagnostics` inspects THIS path for `.credentials.json`
    // and reports `refuted` — backend unavailable — when it is the wrong dir.
    const env: NodeJS.ProcessEnv = {
      VIBERR_CLAUDE_USE_CLI_AUTH: "1",
      VIBERR_DATA_ROOT: "/data",
    };
    expect(resolveClaudeConfigDirFrom(env)).toBe(
      path.join(os.homedir(), ".claude"),
    );
  });

  it("without the opt-in, runs get the app-owned dir under the data root", () => {
    // An API-key/token deployment must keep transcripts with the instance and
    // OUT of the operator's personal config: the data root is what gets backed
    // up, what `pruneRuntimeTranscripts` is allowed to age out, and what a
    // second instance on another volume does not share.
    const env: NodeJS.ProcessEnv = { VIBERR_DATA_ROOT: "/srv/viberr-data" };
    expect(resolveClaudeConfigDirFrom(env)).toBe(
      "/srv/viberr-data/runtimes/claude-home",
    );
    expect(resolveClaudeConfigDirFrom(env)).not.toBe(
      path.join(os.homedir(), ".claude"),
    );
  });

  it("only 1/true/yes opt in — no other value may hand runs the operator's ~/.claude", () => {
    // The refusal path. `VIBERR_CLAUDE_USE_CLI_AUTH=0` / `=off` / `=""` is an
    // operator saying NO, and the suite's own hermeticity depends on it:
    // test-support/setup-env.ts blanks this key (F10-10) precisely so no test
    // can construct a real CLI-auth adapter against a developer's login. A
    // resolver that treated any non-empty value as truthy would point the whole
    // test suite — and any deployment with the flag explicitly disabled — at
    // ~/.claude.
    const home = path.join(os.homedir(), ".claude");
    const root = "/data/runtimes/claude-home";
    for (const value of ["1", "true", "yes"]) {
      expect(
        resolveClaudeConfigDirFrom({
          VIBERR_CLAUDE_USE_CLI_AUTH: value,
          VIBERR_DATA_ROOT: "/data",
        }),
      ).toBe(home);
    }
    for (const value of ["0", "false", "no", "off", "", "TRUE", "Yes", "on"]) {
      expect(
        resolveClaudeConfigDirFrom({
          VIBERR_CLAUDE_USE_CLI_AUTH: value,
          VIBERR_DATA_ROOT: "/data",
        }),
      ).toBe(root);
    }
    expect(resolveClaudeConfigDirFrom({ VIBERR_DATA_ROOT: "/data" })).toBe(root);
  });

  it("an unset data root still resolves — to ./data, absolutely", () => {
    // `…From()` is handed RAW env, which (unlike `getEnv()`) applies no schema
    // default. Its `|| "./data"` is what keeps the credential probe from
    // building `/runtimes/claude-home` — a path at the filesystem root — on a
    // process that never set VIBERR_DATA_ROOT.
    expect(resolveClaudeConfigDirFrom({})).toBe(DEFAULT_DIR);
  });
});

describe("resolveClaudeConfigDir (the validated-env rule)", () => {
  it("an explicit CLAUDE_CONFIG_DIR wins here too", () => {
    applyToProcess({
      CLAUDE_CONFIG_DIR: "/mnt/sessions/claude",
      VIBERR_CLAUDE_USE_CLI_AUTH: "1",
      VIBERR_DATA_ROOT: "/data",
    });
    expect(resolveClaudeConfigDir()).toBe("/mnt/sessions/claude");
  });

  it("CLI-auth mode resolves ~/.claude", () => {
    applyToProcess({
      VIBERR_CLAUDE_USE_CLI_AUTH: "true",
      VIBERR_DATA_ROOT: "/data",
    });
    expect(resolveClaudeConfigDir()).toBe(path.join(os.homedir(), ".claude"));
  });

  it("the default branch is absolute, so it cannot follow the CHILD's cwd", () => {
    // This string is handed to a SPAWNED process whose cwd is the task
    // workspace, not the server's. A relative answer here (path.join instead of
    // path.resolve) would make every run write its transcript into whatever
    // repo it happened to be checked out in, while `session-export` — running
    // in the server's cwd — kept looking under the data root. That is the
    // exact "the two disagreed" failure, reintroduced by one function call.
    applyToProcess({ VIBERR_DATA_ROOT: "./relative-data" });
    const dir = resolveClaudeConfigDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(
      path.join(process.cwd(), "relative-data", "runtimes", "claude-home"),
    );
  });

  it("keeps the `runtimes/claude-home` segments the rest of the app hardcodes", () => {
    // Not decoration: `pruneRuntimeTranscripts` deletes
    // `<root>/runtimes/claude-home/projects` by literal segments
    // (transcript-retention.server.ts), `ensureDataRootDirs` creates them, and
    // docs/architecture/data-model.md documents them. Renaming a segment here
    // alone would silently strand retention on a directory nothing writes to.
    applyToProcess({ VIBERR_DATA_ROOT: "/srv/viberr-data" });
    expect(resolveClaudeConfigDir()).toBe(
      "/srv/viberr-data/runtimes/claude-home",
    );
  });

  it("an empty-string value reads as unset, which is how the suite is hermetic", () => {
    // test-support/setup-env.ts deliberately assigns "" rather than deleting
    // (a deleted key is refilled by `loadEnvFile()` from a developer's .env).
    // Both halves of that contract are load-bearing: `parseEnv` drops empty
    // strings before validation, and the raw twin's `||`/falsy tests agree — so
    // a blanked CLAUDE_CONFIG_DIR must fall THROUGH rather than resolve to "".
    applyToProcess({
      CLAUDE_CONFIG_DIR: "",
      VIBERR_CLAUDE_USE_CLI_AUTH: "",
      VIBERR_DATA_ROOT: "",
    });
    expect(resolveClaudeConfigDir()).toBe(DEFAULT_DIR);
  });
});

/** One deployment shape, and the single path both resolvers owe it. */
interface ParityCase {
  readonly name: string;
  readonly env: NodeJS.ProcessEnv;
  readonly expected: string;
}

const PARITY_CASES: readonly ParityCase[] = [
  {
    name: "the shipped image (explicit dir + data root)",
    env: {
      CLAUDE_CONFIG_DIR: "/data/runtimes/claude-home",
      VIBERR_DATA_ROOT: "/data",
    },
    expected: "/data/runtimes/claude-home",
  },
  {
    name: "an override pointed at a mounted volume, CLI auth also on",
    env: {
      CLAUDE_CONFIG_DIR: "/mnt/sessions/claude",
      VIBERR_CLAUDE_USE_CLI_AUTH: "1",
      VIBERR_DATA_ROOT: "/data",
    },
    expected: "/mnt/sessions/claude",
  },
  {
    name: "a developer on CLI auth",
    env: { VIBERR_CLAUDE_USE_CLI_AUTH: "1", VIBERR_DATA_ROOT: "/data" },
    expected: path.join(os.homedir(), ".claude"),
  },
  {
    name: "an API-key deployment",
    env: { VIBERR_DATA_ROOT: "/srv/viberr-data" },
    expected: "/srv/viberr-data/runtimes/claude-home",
  },
  {
    name: "a relative data root (`.env` in a dev checkout)",
    env: { VIBERR_DATA_ROOT: "./relative-data" },
    expected: path.join(
      process.cwd(),
      "relative-data",
      "runtimes",
      "claude-home",
    ),
  },
  {
    name: "the flag explicitly disabled",
    env: { VIBERR_CLAUDE_USE_CLI_AUTH: "0", VIBERR_DATA_ROOT: "/data" },
    expected: "/data/runtimes/claude-home",
  },
  {
    name: "the suite's own shape: blanked, not deleted",
    env: {
      CLAUDE_CONFIG_DIR: "",
      VIBERR_CLAUDE_USE_CLI_AUTH: "",
      VIBERR_DATA_ROOT: "",
    },
    expected: DEFAULT_DIR,
  },
  {
    name: "nothing configured at all",
    env: {},
    expected: DEFAULT_DIR,
  },
];

describe("parity — the invariant the docstring asks for", () => {
  // "This is deliberately the same branch order as above, not a second rule —
  // the two must never disagree, or the dir the adapter writes transcripts to
  // stops being the dir the probe inspects." Two functions, two env sources
  // (validated cache vs live snapshot), one rule: the only way a change to one
  // and not the other gets caught is if something compares them.
  for (const testCase of PARITY_CASES) {
    it(`agrees on ${testCase.name}`, () => {
      applyToProcess(testCase.env);
      const live = resolveClaudeConfigDirFrom(testCase.env);
      const cached = resolveClaudeConfigDir();
      // Both the agreement AND the value: two resolvers that drifted together
      // would still be a broken deployment.
      expect(live).toBe(testCase.expected);
      expect(cached).toBe(testCase.expected);
      expect(cached).toBe(live);
    });
  }

  it("a HOME inside the handed snapshot cannot make the two disagree", () => {
    // The codex twin (`resolveCodexAuthSource`) derives the home from the env
    // it was HANDED (`env.HOME ?? env.USERPROFILE ?? os.homedir()`), and it is
    // tempting to copy that idiom here. Doing it to ONE of these two functions
    // is how they split: the probe would inspect a per-call HOME while runs
    // kept writing under the process home. Both read the process home today,
    // so a snapshot's HOME changes nothing on either side.
    const env: NodeJS.ProcessEnv = {
      VIBERR_CLAUDE_USE_CLI_AUTH: "1",
      VIBERR_DATA_ROOT: "/data",
      HOME: "/somewhere/else",
      USERPROFILE: "C:\\somewhere\\else",
    };
    applyToProcess(env);
    expect(resolveClaudeConfigDirFrom(env)).toBe(resolveClaudeConfigDir());
    expect(resolveClaudeConfigDirFrom(env)).toBe(
      path.join(os.homedir(), ".claude"),
    );
  });
});
