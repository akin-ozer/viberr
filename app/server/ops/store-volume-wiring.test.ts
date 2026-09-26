import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse } from "yaml";

/**
 * Ruling 504 (narrowing 473): a starter's bare `docker compose up` is the
 * whole install, and a host that holds real data can still keep Compose's
 * hands off the store.
 *
 * Ruling 473 declared the store volume `external`, so `docker compose down -v`
 * could never delete it. The price was that a fresh `up` failed with
 * `external volume "viberr-data" not found` until someone created the volume
 * by hand, and the README's quickstart never said to. The owner ruled for the
 * starter: Compose owns the volume by default, and VIBERR_STORE_EXTERNAL=true
 * in `.env` re-arms ruling 473 where it matters, on a volume made outside
 * Compose (measured 2026-09-26 on Compose 5.5.1: that one survives every form
 * of `down -v`, while one Compose made is still deleted by a
 * `docker compose -p <name> down -v` run without the file).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const composeSchema = z.object({
  services: z.object({
    app: z.object({
      volumes: z.array(z.string()),
      env_file: z.array(z.object({ path: z.string(), required: z.boolean() })),
      cpus: z.string(),
    }),
  }),
  volumes: z.record(z.string(), z.object({ name: z.string(), external: z.unknown() })),
});

/** The first shell block that runs Compose: the install a newcomer follows. */
function firstComposeBlock(markdown: string): string {
  return (
    [...markdown.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)]
      .map((block) => block[1] ?? "")
      .find((block) => /^docker compose /m.test(block)) ?? ""
  );
}

describe("ruling 504: a starter's `docker compose up` is the whole install", () => {
  const app = composeSchema.parse(parse(read("compose.yml")));

  it("mounts viberr-data, owned by Compose unless VIBERR_STORE_EXTERNAL re-arms ruling 473", () => {
    expect(app.services.app.volumes).toContain("viberr-data:/data");
    // CANARY: a literal `external: true` fails every fresh `up`; dropping the
    // variable leaves a host with real data no way to keep `down -v` off it.
    expect(app.volumes["viberr-data"]).toEqual({
      name: "viberr-data",
      external: "${VIBERR_STORE_EXTERNAL:-false}",
    });
  });

  it("the deploy makes a guarded store outside Compose before `up`, and only a guarded one", () => {
    const deploy = read("scripts/deploy.ts");
    const guard = deploy.indexOf("resolved.volumes[STORE_VOLUME]?.external");
    const create = deploy.indexOf('["volume", "create", STORE_VOLUME]');
    const up = deploy.indexOf('compose("up", "-d")');
    // CANARY: create it unguarded and every default host gets a volume Compose
    // did not make and warns about on each `up`; create it after `up` and a
    // guarded fresh host fails with `external volume "viberr-data" not found`.
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
    expect(up).toBeGreaterThan(create);
  });

  it("needs no .env, and sets no CPU ceiling a small host cannot meet", () => {
    expect(app.services.app.env_file).toEqual([{ path: ".env", required: false }]);
    // Docker refuses to start a container whose ceiling exceeds the host's CPUs.
    expect(app.services.app.cpus).toBe("${VIBERR_CPUS:-0}");
  });

  it("documents the install as that `up`, with no setup step before it", () => {
    for (const doc of ["README.md", "docs/operations/deployment.md"]) {
      const steps = firstComposeBlock(read(doc));
      expect(steps, doc).toMatch(/^docker compose up\b/m);
      expect(steps, doc).not.toMatch(/cp \.env\.example|docker volume create/);
    }
  });
});
