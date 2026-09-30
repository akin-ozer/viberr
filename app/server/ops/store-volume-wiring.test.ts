import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parse } from "yaml";

/**
 * Ruling 504 (superseding 473): a starter's bare `docker compose up` is the
 * whole install.
 *
 * Ruling 473 declared the store volume `external`, so `docker compose down -v`
 * could never delete it. The price was that a fresh `up` failed with
 * `external volume "viberr-data" not found` until someone created the volume
 * by hand, and the README's quickstart never said to. The owner ruled for the
 * starter: Compose owns the volume. `down` keeps it and `down -v` deletes it,
 * because `-v` is an explicit request to.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const composeSchema = z.object({
  services: z.object({
    app: z.object({
      volumes: z.array(z.string()),
      env_file: z.array(z.object({ path: z.string(), required: z.boolean() })),
      environment: z.record(z.string(), z.string()),
      cpus: z.string(),
    }),
  }),
  volumes: z.record(z.string(), z.record(z.string(), z.unknown())),
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

  it("mounts viberr-data, a volume Compose owns", () => {
    expect(app.services.app.volumes).toContain("viberr-data:/data");
    // CANARY: `external: true` fails every fresh `up`.
    expect(app.volumes["viberr-data"]).toEqual({ name: "viberr-data" });
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

describe("ruling 603: the free-space check sees the host disk", () => {
  const app = composeSchema.parse(parse(read("compose.yml")));

  // Ruling 460 moved the store onto a named volume, and on Docker Desktop that
  // volume reports the VM disk image's virtual size: the check read 940.8 GB
  // free while the Mac had 19.9 GB. The host disk reaches the app only through
  // this mount and the env that names it.
  it("mounts a host directory read-only and names it to the app", () => {
    expect(app.services.app.volumes).toContain("./.host-disk:/host-disk:ro");
    expect(app.services.app.environment.VIBERR_HOST_DISK_PATH).toBe(
      "${VIBERR_HOST_DISK_PATH-/host-disk}",
    );
  });
});
