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
 * `playwright test` with the derived base URL → tear down with --volumes.
 */
import { spawn } from "node:child_process";
import process from "node:process";

const PROJECT = "viberr-e2e";
const COMPOSE = ["compose", "-f", "compose.e2e.yml", "-p", PROJECT];

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
        const body = (await response.json()) as { ok?: boolean };
        if (body.ok === true) return;
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
