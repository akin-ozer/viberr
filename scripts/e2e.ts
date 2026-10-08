/**
 * E2E orchestrator — the whole Playwright suite runs against the PRODUCTION
 * image in an isolated Docker Compose stack (owner policy, 2026-08-02: never
 * a dev server for app-serving tests).
 *
 *   npm run e2e                          full suite
 *   npm run e2e -- e2e/01-home-board.spec.ts   any playwright args pass through
 *   VIBERR_E2E_KEEP=1 npm run e2e        keep the stack running afterwards
 *
 * Flow: remove any leftover stack → `up --build` (seed one-shot, then the
 * production app on a fresh named volume) → wait for /resources/health →
 * `agentIsolation` must be `on` and `scripts/check-agent-isolation.sh` must
 * pass inside the app container (ruling 460) → `playwright test` with the
 * derived base URL → tear down with --volumes.
 */
import { spawn } from "node:child_process";
import process from "node:process";
import { z } from "zod";

const PROJECT = "viberr-e2e";
const COMPOSE = ["compose", "-f", "compose.e2e.yml", "-p", PROJECT];

/** `/resources/health` answers `{ ok: true }` once the app is serving. Anything
 *  else — an error body, a proxy's HTML, a half-started reply — is "not up yet",
 *  which is what the polling loop does with a failed parse. */
const healthBody = z.object({ ok: z.boolean().catch(false) }).catch({ ok: false });

/** Ruling 460's reading, off the same body. */
const agentIsolationBody = z.object({
  agentIsolation: z
    .object({ status: z.string(), reason: z.string().nullable() })
    .catch({ status: "missing", reason: "the health body has no agentIsolation" }),
});

function run(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; capture?: boolean } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: opts.env ?? process.env,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function compose(args: string[], capture = false) {
  return run("docker", [...COMPOSE, ...args], { capture });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.status === 200) {
        if (healthBody.parse(await response.json()).ok) return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`app did not become healthy at ${url} within ${timeoutMs / 1000}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<number> {
  const playwrightArgs = process.argv.slice(2);

  // Clean slate even if a previous run crashed mid-flight.
  await compose(["down", "--volumes", "--remove-orphans"]);

  const up = await compose(["up", "--build", "--detach", "--wait", "--wait-timeout", "300"]);
  if (up.code !== 0) {
    console.error("e2e: compose up failed — seed or app did not start");
    await compose(["logs", "--tail", "100"]);
    await compose(["down", "--volumes", "--remove-orphans"]);
    return 1;
  }

  const port = await compose(["port", "app", "3000"], true);
  const hostPort = port.stdout.trim().split(":").pop();
  if (port.code !== 0 || !hostPort) {
    console.error("e2e: could not derive the published app port");
    await compose(["down", "--volumes", "--remove-orphans"]);
    return 1;
  }
  const baseUrl = `http://127.0.0.1:${hostPort}`;

  try {
    await waitForHealth(`${baseUrl}/resources/health`, 60_000);
    console.log(`e2e: production stack healthy at ${baseUrl}`);

    // Ruling 460: the shipped image runs every agent as its person's own OS
    // user, and this stack's store is a named volume, so the isolation must be
    // `on` — and the kernel must agree, which only a check inside the running
    // container can ask (`scripts/check-agent-isolation.sh`).
    const isolation = agentIsolationBody.parse(
      await (await fetch(`${baseUrl}/resources/health`)).json(),
    ).agentIsolation;
    if (isolation.status !== "on") {
      console.error(`e2e: agentIsolation is ${isolation.status}: ${isolation.reason ?? ""}`);
      return 1;
    }
    const check = await compose(["exec", "-T", "app", "sh", "scripts/check-agent-isolation.sh"]);
    if (check.code !== 0) {
      console.error("e2e: the in-image agent isolation check failed");
      return 1;
    }
    // Ruling 691: the unit suites drive the page capture's renderer with a
    // stand-in browser, so what only the image's own Chromium can show (the
    // proxy rule that leaves a page no way out, a full-page picture that
    // leaves the layout alone, a picture of an exact size drawn at its own
    // device scale, an SVG drawing set as a page, the fonts) is asked here,
    // as an agent uid through the launcher (`scripts/check-page-capture.sh`).
    const capture = await compose(["exec", "-T", "app", "sh", "scripts/check-page-capture.sh"]);
    if (capture.code !== 0) {
      console.error("e2e: the in-image page capture check failed");
      return 1;
    }

    const result = await run("npx", ["playwright", "test", ...playwrightArgs], {
      env: { ...process.env, VIBERR_E2E_BASE_URL: baseUrl },
    });
    if (result.code !== 0) {
      console.error("e2e: playwright failed — last app logs:");
      await compose(["logs", "--tail", "100", "app"]);
    }
    return result.code;
  } finally {
    if (process.env.VIBERR_E2E_KEEP === "1") {
      console.log(`e2e: keeping stack up (VIBERR_E2E_KEEP=1) at ${baseUrl} — remove with:`);
      console.log(`  docker ${COMPOSE.join(" ")} down --volumes --remove-orphans`);
    } else {
      await compose(["down", "--volumes", "--remove-orphans"]);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("e2e:", error);
    process.exit(1);
  },
);
