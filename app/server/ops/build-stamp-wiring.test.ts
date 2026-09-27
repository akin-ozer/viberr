import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 345 (pass 37, F37-181) — a build stamp the image declares and nothing
 * supplies.
 *
 * `build-info.server.ts` has resolved identity from env since gap 18, and its
 * own docstring says env "is the only source a container can have" — correctly,
 * because `.dockerignore` excludes `.git` and its file-reading fallback cannot
 * fire inside an image. The Dockerfile declared all three ARGs and wired them
 * to ENV, and the runbook documented a four-line `--build-arg` incantation.
 * `compose.yml` said `build: .`, with no `args:` at all — so the DEFAULT deploy
 * path could not stamp, and the stamp was a thing to remember.
 *
 * Nobody remembered. Every container on this instance reported
 * `revision: null`, `revisionSource: null`, `builtAt: null` and a `version`
 * identical for every build of a release — while the module existed
 * specifically because *"every upgrade/rollback instruction in
 * docs/operations/deployment.md ('redeploy the previous image') assumes the
 * operator can tell two builds apart at runtime"*.
 *
 * It cost the pass directly: on 2026-09-17 a killed build left the operator
 * unable to say whether the running container held the new image or the old
 * one, inferring it from `docker compose ps` uptime because this surface
 * answered `0.19.0` and three nulls.
 *
 * Three ends have to agree, and only the middle one was ever checked: the
 * module READS an env var, the Dockerfile DECLARES it, and the compose build
 * PASSES it. This asserts all three against each other, so adding a fourth
 * stamp cannot land half-wired.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Every `VIBERR_BUILD_*` name the module actually reads out of the env. */
function namesTheModuleReads(): string[] {
  const src = read("app/server/ops/build-info.server.ts");
  return [...new Set([...src.matchAll(/env\.(VIBERR_BUILD_\w+)/g)].map((m) => m[1]!))].sort();
}

describe("the build stamp is wired end to end (ruling 345)", () => {
  const names = namesTheModuleReads();

  it("the module reads the three stamps this test is about", () => {
    // CANARY: rename a stamp in the module and the two assertions below start
    // checking a name nothing uses.
    expect(names).toEqual([
      "VIBERR_BUILD_SHA",
      "VIBERR_BUILD_TIME",
      "VIBERR_BUILD_VERSION",
    ]);
  });

  it.each(namesTheModuleReads())("the Dockerfile declares %s as an ARG and an ENV", (name) => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain(`ARG ${name}=`);
    // Declared as ARG and NOT promoted to ENV is the same defect one layer in:
    // a build argument the running process cannot see.
    expect(dockerfile).toContain(`ENV ${name}=$${name}`);
  });

  it.each(namesTheModuleReads())("the compose build PASSES %s", (name) => {
    // CANARY: this is the assertion that was red for the whole of pass 37.
    // Revert `compose.yml` to `build: .` and every case here fails.
    const compose = read("compose.yml");
    expect(
      new RegExp(`^\\s+${name}:\\s`, "m").test(compose),
      `compose.yml declares no build arg for ${name}, so the Dockerfile's ARG ` +
        `stays empty and the image reports itself unstamped`,
    ).toBe(true);
  });

  it("the deploy path fills every stamp the module reads", () => {
    const deploy = read("scripts/deploy.ts");
    for (const name of names) {
      expect(deploy, `scripts/deploy.ts never sets ${name}`).toContain(`${name}:`);
    }
    // And it reads the instance back, which is the half that makes a stamp
    // worth having. CANARY: delete the verify block and a deploy can still
    // report success over a container that never restarted.
    expect(deploy).toContain("/resources/health");
  });
});
