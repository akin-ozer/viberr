import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse } from "yaml";

/**
 * Ruling 473 (pass 40, F40-18) — Compose must never own the store.
 *
 * Ruling 460 moved the store to the named volume `viberr-data`, declared in
 * compose.yml without `external`. On the owner's host the volume was made by
 * `npm run store:to-volume`, so it carries no Compose labels and every deploy
 * printed "volume already exists but was not created by Docker Compose". On a
 * FRESH host Compose creates it on the first `up`, labelled as its own — and a
 * volume Compose owns is one `docker compose down -v` deletes: the canonical
 * files, the database, every sealed credential and every sign-in, in one
 * routine command (measured 2026-09-25: an unlabelled volume survives
 * `down -v`; a Compose-created one is what the flag removes).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const composeSchema = z.object({
  services: z.object({ app: z.object({ volumes: z.array(z.string()) }) }),
  volumes: z.record(z.string(), z.object({ name: z.string(), external: z.boolean().optional() })),
});

describe("ruling 473: the store volume is never Compose's to delete", () => {
  it("compose.yml mounts viberr-data at /data and declares it external", () => {
    const compose = composeSchema.parse(parse(read("compose.yml")));
    expect(compose.services.app.volumes).toContain("viberr-data:/data");
    // CANARY: drop `external: true` and a fresh host's first `up` makes a volume
    // `docker compose down -v` removes.
    expect(compose.volumes["viberr-data"]).toEqual({ name: "viberr-data", external: true });
  });

  it("the deploy creates a missing store volume before the first `up`, and never replaces one", () => {
    const deploy = read("scripts/deploy.ts");
    const inspect = deploy.indexOf('["volume", "inspect", STORE_VOLUME]');
    const create = deploy.indexOf('["volume", "create", STORE_VOLUME]');
    const up = deploy.indexOf('compose("up", "-d")');
    expect(deploy).toContain('const STORE_VOLUME = "viberr-data";');
    // An external volume that does not exist fails `up`, so the create must
    // come first — and only after an inspect says it is missing.
    expect(inspect).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(inspect);
    expect(up).toBeGreaterThan(create);
  });
});
