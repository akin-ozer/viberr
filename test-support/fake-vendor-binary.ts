import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BackendBinaries } from "~/server/runtimes/backend-credentials.server";

/**
 * Executable stand-ins for the vendors' own `claude` and `codex` binaries
 * (ruling 127, spec §3.4).
 *
 * The sign-in driver's whole job is to drive a REAL child process: spawn it with
 * one home variable and no credentials, read what it prints, write a code to its
 * stdin, ask it afterwards whether it is signed in. Faking that with a stubbed
 * module would test nothing that matters, so these are actual executables
 * (mode 0o755, a shebang pointing at the node running the suite) that print the
 * vendors' exact lines, ANSI colour included, and write the credential file the
 * availability probe looks for.
 *
 * Each script also drops its artefacts INSIDE the home it was handed:
 * `fake-env.json` (its whole environment, so a test can prove the child saw one
 * home and no credential), for Claude `fake-stdin.txt` (everything that reached
 * stdin, so a test can prove nothing but the code was written there), and
 * `fake-terminated.txt` on SIGTERM (so a test can prove a replaced or cancelled
 * child really died instead of being orphaned). The LOGOUT branch drops
 * `fake-logout.json` — its argv and its whole environment — so the credential
 * store's disconnect path can prove the vendor's own logout ran, ran on the
 * home that call named, and saw no credential of the server's. Writing them
 * into the home is itself an assertion: a script that received the wrong home
 * writes them somewhere the test does not look.
 *
 * Behaviour is switched by environment variables the harness sets on the SUITE's
 * process (they survive `filteredSpawnEnv`, which strips credential-shaped names
 * only), so one pair of executables covers success, vendor failure and a hang.
 */

/** How the fake binaries behave for the next sign-in. */
export type FakeVendorMode = "success" | "fail" | "hang";

const FAKE_VENDOR_MODE_ENV = "VIBERR_FAKE_VENDOR_MODE";
const FAKE_VENDOR_STATUS_ENV = "VIBERR_FAKE_VENDOR_STATUS";
const FAKE_VENDOR_DELAY_ENV = "VIBERR_FAKE_VENDOR_DELAY_MS";
const FAKE_VENDOR_LOGOUT_EXIT_ENV = "VIBERR_FAKE_VENDOR_LOGOUT_EXIT";
/** Ruling 507: a directory OUTSIDE every home where a logout also records
 *  itself. Disconnecting an account removes that account's whole home — the
 *  `fake-logout.json` inside it included — so a test that must prove the
 *  logout ran in that home reads this durable copy instead. */
const FAKE_VENDOR_EVIDENCE_ENV = "VIBERR_FAKE_VENDOR_EVIDENCE_DIR";

/** The device code the fake Codex prints, in OpenAI's own format. */
export const FAKE_DEVICE_CODE = "WDJB-MJHT";
/** The URLs each fake prints. The Codex one is the real device-flow URL. */
export const FAKE_CLAUDE_URL =
  "https://claude.ai/oauth/authorize?code=true&scope=user";
export const FAKE_CODEX_URL = "https://auth.openai.com/codex/device";

export interface FakeVendorBinaries {
  binaries: BackendBinaries;
  cleanup(): void;
}

/** ANSI colour, assembled from char codes so this file carries no control
 *  character of its own. */
const ESC = String.fromCharCode(27);

function claudeScript(): string {
  return `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const home = process.env.CLAUDE_CONFIG_DIR || "";
const ESC = String.fromCharCode(27);
const CYAN = ESC + "[36m";
const RESET = ESC + "[0m";
function drop(name, data) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, name), data);
  } catch {
    // A script that was handed no home has nothing to prove and exits below.
  }
}
function evidence(name, data) {
  const dir = process.env.${FAKE_VENDOR_EVIDENCE_ENV};
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, name), data + "\\n");
  } catch {
    // Evidence is best effort; the home copy above is the primary one.
  }
}
// The driver kills a replaced (or cancelled, or timed-out) sign-in with SIGTERM.
// Recording it in the home is how a test can prove the child actually died
// rather than being orphaned: an unhandled SIGTERM would end the process with no
// trace, and a leaked child would keep running with none either.
process.on("SIGTERM", () => {
  drop("fake-terminated.txt", "sigterm\\n");
  evidence("terminated.jsonl", JSON.stringify({ home }));
  process.exit(0);
});
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = process.env.${FAKE_VENDOR_STATUS_ENV} !== "logged-out";
  process.stdout.write(
    JSON.stringify({
      loggedIn,
      authMethod: "claudeai",
      apiProvider: "anthropic",
      email: "person@example.com",
    }) + "\\n",
  );
  process.exit(0);
} else if (args[0] === "auth" && args[1] === "logout") {
  drop("fake-logout.json", JSON.stringify({ argv: args, env: process.env }));
  evidence("logouts.jsonl", JSON.stringify({ argv: args, env: process.env }));
  process.exit(Number(process.env.${FAKE_VENDOR_LOGOUT_EXIT_ENV} || "0"));
} else {
  drop("fake-env.json", JSON.stringify(process.env, null, 2));
  drop("fake-argv.json", JSON.stringify(args));
  const mode = process.env.${FAKE_VENDOR_MODE_ENV} || "success";
  if (mode === "fail") {
    process.stderr.write(CYAN + "error" + RESET + ": browser authorization was refused.\\n");
    process.exit(3);
  } else {
    process.stdout.write(
      CYAN + "Open this URL to sign in: ${FAKE_CLAUDE_URL}" + RESET + "\\n",
    );
    if (mode !== "hang") {
      // No trailing newline: the real CLI leaves the cursor on the prompt line.
      process.stdout.write("Paste code here if prompted: ");
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\\n")) return;
        drop("fake-stdin.txt", buffer);
        drop(".credentials.json", JSON.stringify({ fake: true }));
        process.exit(0);
      });
    } else {
      // Hang: hold the event loop so the driver's timeout and cancel paths are
      // the only things that can end this process.
      setInterval(() => {}, 1000);
    }
  }
}
`;
}

function codexScript(): string {
  return `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME || "";
const ESC = String.fromCharCode(27);
const CYAN = ESC + "[36m";
const RESET = ESC + "[0m";
function drop(name, data) {
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, name), data);
  } catch {
    // A script that was handed no home has nothing to prove and exits below.
  }
}
function evidence(name, data) {
  const dir = process.env.${FAKE_VENDOR_EVIDENCE_ENV};
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, name), data + "\\n");
  } catch {
    // Evidence is best effort; the home copy above is the primary one.
  }
}
// The driver kills a replaced (or cancelled, or timed-out) sign-in with SIGTERM.
// Recording it in the home is how a test can prove the child actually died
// rather than being orphaned: an unhandled SIGTERM would end the process with no
// trace, and a leaked child would keep running with none either.
process.on("SIGTERM", () => {
  drop("fake-terminated.txt", "sigterm\\n");
  evidence("terminated.jsonl", JSON.stringify({ home }));
  process.exit(0);
});
if (args[0] === "login" && args[1] === "status") {
  const loggedIn = process.env.${FAKE_VENDOR_STATUS_ENV} !== "logged-out";
  process.stdout.write(
    loggedIn
      ? "Logged in using ChatGPT (person@example.com)\\n"
      : "Not logged in\\n",
  );
  process.exit(0);
} else if (args[0] === "logout") {
  drop("fake-logout.json", JSON.stringify({ argv: args, env: process.env }));
  evidence("logouts.jsonl", JSON.stringify({ argv: args, env: process.env }));
  process.exit(Number(process.env.${FAKE_VENDOR_LOGOUT_EXIT_ENV} || "0"));
} else {
  drop("fake-env.json", JSON.stringify(process.env, null, 2));
  drop("fake-argv.json", JSON.stringify(args));
  const mode = process.env.${FAKE_VENDOR_MODE_ENV} || "success";
  if (mode === "fail") {
    process.stderr.write("device code login is not enabled for this workspace.\\n");
    process.exit(4);
  } else {
    process.stdout.write(
      "Open " + CYAN + "${FAKE_CODEX_URL}" + RESET + " in your browser\\n",
    );
    process.stdout.write("Enter this one-time code\\n");
    process.stdout.write(CYAN + "${FAKE_DEVICE_CODE}" + RESET + "\\n");
    if (mode !== "hang") {
      const delay = Number(process.env.${FAKE_VENDOR_DELAY_ENV} || "80");
      setTimeout(() => {
        drop("auth.json", JSON.stringify({ fake: true }));
        process.exit(0);
      }, delay);
    } else {
      setInterval(() => {}, 1000);
    }
  }
}
`;
}

/**
 * Write both executables to a temp directory and hand back their absolute
 * paths, ready for `deps.binaries`.
 */
export function writeFakeVendorBinaries(): FakeVendorBinaries {
  const dir = mkdtempSync(path.join(tmpdir(), "viberr-fake-vendor-"));
  const claude = path.join(dir, "claude");
  const codex = path.join(dir, "codex");
  // The shebang names the node running this suite, not whatever `env node`
  // finds: the child must be the same runtime the gates pin.
  writeFileSync(claude, `#!${process.execPath}\n${claudeScript()}`);
  writeFileSync(codex, `#!${process.execPath}\n${codexScript()}`);
  chmodSync(claude, 0o755);
  chmodSync(codex, 0o755);
  return {
    binaries: { claude, codex },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Point the fakes at one behaviour for the next spawn. */
export function setFakeVendorMode(mode: FakeVendorMode): void {
  process.env[FAKE_VENDOR_MODE_ENV] = mode;
}

/** Make the vendors' status commands report a session that never landed. */
export function setFakeVendorLoggedOut(): void {
  process.env[FAKE_VENDOR_STATUS_ENV] = "logged-out";
}

/** Make the vendors' logout commands fail, the way a revoke that could not
 *  reach the provider does. The disconnect must survive it: the local half —
 *  the credential file and the row — is what makes the account unusable here. */
export function setFakeVendorLogoutExit(code: number): void {
  process.env[FAKE_VENDOR_LOGOUT_EXIT_ENV] = String(code);
}

/** Ruling 507: also record every logout in `dir`, which outlives the home the
 *  logout ran in (see `FAKE_VENDOR_EVIDENCE_ENV`). */
export function setFakeVendorEvidenceDir(dir: string): void {
  process.env[FAKE_VENDOR_EVIDENCE_ENV] = dir;
}

/** Clear every knob. Call it in `afterEach`: these live on the worker's own
 *  process env and would otherwise leak into the next file. */
export function resetFakeVendorEnv(): void {
  delete process.env[FAKE_VENDOR_MODE_ENV];
  delete process.env[FAKE_VENDOR_STATUS_ENV];
  delete process.env[FAKE_VENDOR_DELAY_ENV];
  delete process.env[FAKE_VENDOR_LOGOUT_EXIT_ENV];
  delete process.env[FAKE_VENDOR_EVIDENCE_ENV];
}

/** The environment map is written by the fake itself, so it is DECODED, not
 *  trusted: a partially written file reads as "the child left no evidence". */
const envDumpSchema = z.record(z.string(), z.string());

/** The whole environment the child was spawned with, or null when it never
 *  ran (or ran against a different home than the test expected). */
export function fakeVendorEnv(home: string): Record<string, string> | null {
  return readJson(path.join(home, "fake-env.json"), envDumpSchema);
}

const argvDumpSchema = z.array(z.string());

/** The argv the child was spawned with. */
export function fakeVendorArgv(home: string): string[] | null {
  return readJson(path.join(home, "fake-argv.json"), argvDumpSchema);
}

/** Everything that reached the child's stdin, or null when nothing did. */
export function fakeVendorStdin(home: string): string | null {
  try {
    return readFileSync(path.join(home, "fake-stdin.txt"), "utf8");
  } catch {
    return null;
  }
}

/** Whether the fake child received SIGTERM and exited, i.e. whether the driver
 *  actually terminated it. Absent while it is still running. */
export function fakeVendorTerminated(home: string): boolean {
  try {
    readFileSync(path.join(home, "fake-terminated.txt"), "utf8");
    return true;
  } catch {
    return false;
  }
}

const logoutDumpSchema = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

/** What the vendor's own `logout` child was given — its argv and its whole
 *  environment — or null when no logout ran against this home. */
export function fakeVendorLogout(
  home: string,
): z.infer<typeof logoutDumpSchema> | null {
  return readJson(path.join(home, "fake-logout.json"), logoutDumpSchema);
}

const terminationSchema = z.object({ home: z.string() });

/** The homes of every fake child that received SIGTERM and exited, as recorded
 *  in an evidence directory (`setFakeVendorEvidenceDir`). Ruling 507: a
 *  cancelled or replaced sign-in into a NEW account takes its home with it
 *  once the child has exited, so the in-home marker cannot be read after. */
export function fakeVendorTerminations(dir: string): string[] {
  return readJsonLines(path.join(dir, "terminated.jsonl"), terminationSchema).map(
    (entry) => entry.home,
  );
}

/** Every logout recorded in an evidence directory (`setFakeVendorEvidenceDir`),
 *  in the order they ran; a line that does not decode is skipped. */
export function fakeVendorLogouts(dir: string): z.infer<typeof logoutDumpSchema>[] {
  return readJsonLines(path.join(dir, "logouts.jsonl"), logoutDumpSchema);
}

/** One JSON value per line; a line that does not decode is skipped. */
function readJsonLines<T>(file: string, schema: z.ZodType<T>): T[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

function readJson<T>(file: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The escape byte the scripts colourise with, so a test can assert the driver
 *  stripped it rather than re-deriving it. */
export const ANSI_ESCAPE = ESC;
