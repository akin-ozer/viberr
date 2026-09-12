import type { Toolchain } from "~/server/ops/toolchain.server";

/**
 * The suite's hermetic toolchain reading (ruling 182).
 *
 * `cachedToolchain()` spawns `npm`, `git`, `python3`, `go` and the Codex CLI's
 * own sandbox helper once per process. A unit test must never do that: the
 * versions are the host's, the sandbox verdict depends on the kernel and the
 * seccomp profile the process runs under, and the probe runs a vendor binary.
 * So `setup-env.ts` primes the override slot the server module reads — the
 * same shape as `setBackendBinariesForTests` — with the reading below before
 * any app module loads, and a test that needs a different verdict (the
 * ruling-182 refusal) sets its own through `primeToolchain` and restores this
 * one afterwards.
 *
 * `Symbol.for` is a registry: this key IS the one `toolchain.server.ts` reads,
 * by construction, without importing that module into every test file's
 * setup. This file is the slot's only writer.
 */
const TOOLCHAIN_OVERRIDE_KEY = Symbol.for("viberr.toolchainOverride");

export const HERMETIC_TOOLCHAIN: Toolchain = {
  node: "26.0.0-test",
  npm: "11.0.0-test",
  git: "2.50.0-test",
  python3: null,
  go: null,
  codexCli: "0.0.0-test",
  claudeAgentSdk: "0.0.0-test",
  codexSandbox: {
    ok: true,
    detail: "hermetic test reading: no probe ran",
    childProcesses: { ok: true, detail: "hermetic test reading: no probe ran" },
  },
};

/** Point `cachedToolchain()` at `reading`; `null` lets the real resolver run
 *  (the toolchain module's own tests, with injected deps). */
export function primeToolchain(reading: Toolchain | null): void {
  // SAFETY: the slot `toolchainOverride` (toolchain.server.ts) reads, named
  // the same way and for the same reason — `globalThis` has no index
  // signature, and this line is the only writer of that symbol key.
  const slot = globalThis as Record<symbol, Toolchain | undefined>;
  if (reading) slot[TOOLCHAIN_OVERRIDE_KEY] = reading;
  else delete slot[TOOLCHAIN_OVERRIDE_KEY];
}

export function primeHermeticToolchain(): void {
  primeToolchain(HERMETIC_TOOLCHAIN);
}
