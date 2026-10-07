/**
 * Ruling 345 — build, deploy, and then READ BACK which build is serving.
 *
 *   npm run deploy            — stamp from git, build, up, verify
 *   npm run deploy -- --no-up — stamp and build only
 *   --skip-disk-check         — build without measuring the host first (ruling 603)
 *
 * After the verify, it removes the older untagged builds of this project's app
 * and keeps the one it replaced, to roll back to (ruling 605).
 *
 * `build-info.server.ts` has resolved build identity from env since gap 18, and
 * says plainly that env "is the only source a container can have" —
 * `.dockerignore` excludes `.git`, so its file-reading fallback cannot fire
 * inside an image. The Dockerfile has declared `VIBERR_BUILD_VERSION`,
 * `VIBERR_BUILD_SHA` and `VIBERR_BUILD_TIME` all along, and the runbook
 * documented a `--build-arg` incantation for them — but `compose.yml` passed
 * none, so the default `docker compose build` could not stamp and the stamp was
 * a thing to remember. Nobody remembered: every container on this instance
 * reported `revision: null`, `revisionSource: null`, `builtAt: null`, and a
 * `version` identical for every build of a release. Every rollback instruction in
 * docs/operations/deployment.md ("redeploy the previous image") assumes an
 * operator can tell two builds apart at runtime, which is the gap that module
 * was written to close and could not.
 *
 * The verify step is the half that makes this worth a script rather than three
 * exports in the runbook. Live on 2026-09-17 a deploy's build was killed
 * mid-flight and the operator spent forty minutes unable to say whether the
 * running container held the new image or the old one — inferring it from
 * `docker compose ps` uptime, because `/resources/health` answered
 * `version: 0.19.0` (unchanged across every build) and three nulls. This reads
 * the instance back and prints the sha it is actually serving.
 *
 * `git` runs HERE, on the host, never in the image and never at request time —
 * the same rule `build-info.server.ts` follows.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { composePort } from "../app/server/ops/compose-port.server";
import { formatBytes } from "../app/server/ops/disk-space.server";
import {
  buildRoomRefusal,
  BUILD_CACHE_KEEP_BYTES,
  supersededImagesToRemove,
  tightestHostDisk,
  type SupersededImage,
} from "../app/server/ops/host-disk.server";

const ROOT = path.resolve(import.meta.dirname, "..");

function readDotenv(): string | null {
  try {
    return readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch {
    // No `.env` is a valid compose setup: the port is then the default.
    return null;
  }
}

/** Polled on the port `compose.yml` publishes, from the same shell and `.env`
 *  compose reads — never a literal (see `composePort`). */
const HEALTH_URL = `http://127.0.0.1:${composePort(process.env, readDotenv())}/resources/health`;
/** Long enough for a cold container to finish migrations and answer. */
const VERIFY_TIMEOUT_MS = 180_000;

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    // A tarball checkout has no `.git`. An unstamped build is a true statement
    // about itself, so this degrades rather than refusing.
    return null;
  }
}

/** The same "a blank stamp is not a version" rule `build-info.server.ts`
 *  applies to every one of its sources. */
const manifestSchema = z.object({
  version: z.string().trim().min(1).optional().catch(undefined),
});

function packageVersion(): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return manifestSchema.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

const sha = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain");
const version = packageVersion();
const builtAt = new Date().toISOString();

if (!sha) {
  console.warn(
    "! no git revision available — this image will report `revision: null`, which is true and unhelpful.",
  );
}
if (dirty) {
  // Named, not refused: deploying a dirty tree is a normal move here. But
  // the sha stamped on the image is then NOT the whole of what is running, and
  // an operator comparing two images by sha has to know that.
  console.warn(
    `! working tree is dirty (${dirty.split("\n").length} paths) — the stamped sha describes HEAD, not the tree.`,
  );
}

const buildEnv = {
  ...process.env,
  VIBERR_BUILD_VERSION: version ?? "",
  VIBERR_BUILD_SHA: sha ?? "",
  VIBERR_BUILD_TIME: builtAt,
};

console.log(
  `deploying ${version ?? "(no version)"} @ ${sha ? sha.slice(0, 12) : "(no sha)"} built ${builtAt}`,
);

function compose(...args: string[]): void {
  execFileSync("docker", ["compose", ...args], {
    cwd: ROOT,
    env: buildEnv,
    stdio: "inherit",
  });
}

/** Docker's own storage when it lives on this host's filesystem (a Linux
 *  engine); on Docker Desktop it names a path inside the VM, which is skipped. */
function dockerRootDir(): string | null {
  try {
    return (
      execFileSync("docker", ["info", "--format", "{{.DockerRootDir}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

// Ruling 603: the build writes into Docker's disk, which on Docker Desktop is a
// sparse image file on this host. Measure the host before building.
if (!process.argv.includes("--skip-disk-check")) {
  const disk = tightestHostDisk(
    [
      ROOT,
      path.join(os.homedir(), "Library/Containers/com.docker.docker/Data"),
      path.join(os.homedir(), ".docker/desktop"),
      dockerRootDir(),
    ].filter((p): p is string => p !== null),
  );
  if (!disk) {
    console.warn("! could not measure the host disk; building without the free-space check.");
  } else {
    const refusal = buildRoomRefusal(disk);
    if (refusal) {
      console.error(refusal);
      process.exit(1);
    }
    console.log(`host disk: ${formatBytes(disk.freeBytes)} free under ${disk.path}`);
  }
}

compose("build");

if (process.argv.includes("--no-up")) {
  console.log("built; --no-up, so nothing was restarted.");
  process.exit(0);
}

// Every `up -d` kills the runs in flight — that is a property of the deploy, not
// of this script, and it is why the runbook says to check the board first.
compose("up", "-d");

/** Parsed at the boundary, because this is a live HTTP body: a health surface
 *  that answered something else is "did not answer", not a shape to trust. */
const healthSchema = z.object({
  build: z.object({
    version: z.string().nullable(),
    revision: z.string().nullable(),
    revisionSource: z.enum(["env", "git"]).nullable(),
    builtAt: z.string().nullable(),
  }),
});

type HealthBuild = z.infer<typeof healthSchema>["build"];

async function readBuild(): Promise<HealthBuild | null> {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const parsed = healthSchema.safeParse(await res.json());
        if (parsed.success) return parsed.data.build;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return null;
}

console.log(`verifying ${HEALTH_URL} (up to ${VERIFY_TIMEOUT_MS / 1000}s)`);
const serving = await readBuild();
if (!serving) {
  console.error(`x ${HEALTH_URL} did not answer within ${VERIFY_TIMEOUT_MS / 1000}s.`);
  process.exit(1);
}

console.log(
  `serving ${serving.version ?? "(no version)"} @ ${serving.revision ?? "(no revision)"}` +
    ` (${serving.revisionSource ?? "unstamped"}) built ${serving.builtAt ?? "(unknown)"}`,
);

// The check this script exists for: the thing that answered is the thing we just
// built. A stale container answering a fresh build's port is exactly the
// forty-minute confusion of 2026-09-17.
if (sha && serving.revision !== sha.slice(0, 12)) {
  console.error(
    `x the instance reports ${serving.revision ?? "no revision"}, not the ${sha.slice(0, 12)} just built.`,
  );
  process.exit(1);
}
console.log("ok — the running instance reports the build that was just made.");

/** `docker` with its output captured; null when it fails. */
function dockerOut(...args: string[]): string | null {
  try {
    return execFileSync("docker", args, {
      cwd: ROOT,
      env: buildEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The untagged images earlier builds of this compose project's app left. */
function supersededImages(): SupersededImage[] {
  const config = dockerOut("compose", "config", "--format", "json");
  const project = config ? z.object({ name: z.string() }).safeParse(JSON.parse(config)) : null;
  if (!project?.success) return [];
  const ids = dockerOut(
    "images", "-q", "--no-trunc", "--filter", "dangling=true",
    "--filter", `label=com.docker.compose.project=${project.data.name}`,
    "--filter", "label=com.docker.compose.service=app",
  );
  if (!ids) return [];
  const inspected = dockerOut("image", "inspect", "--format", "{{.Id}} {{.Created}}", ...ids.split("\n"));
  return (inspected ?? "")
    .split("\n")
    .map((line) => line.split(" "))
    .flatMap(([id, created]) => (id && created ? [{ id, created }] : []));
}

// Ruling 605: every build leaves the image it replaced untagged. Keep that one
// to roll back to and remove the older ones; a removal that fails (an image a
// container still uses) is left alone.
const removable = supersededImagesToRemove(supersededImages());
const removed = removable.filter((id) => dockerOut("image", "rm", id) !== null);
if (removed.length > 0) {
  console.log(`removed ${removed.length} older build(s) of this app; kept the one this deploy replaced to roll back to.`);
}

// Ruling 628: BuildKit's cache grows with every build and nothing trimmed it.
// Keep the most recently used BUILD_CACHE_KEEP_BYTES, a whole build's layers,
// so the next build stays incremental; Docker evicts the rest oldest first.
const cacheTrim = dockerOut("builder", "prune", "-f", "--max-used-space", String(BUILD_CACHE_KEEP_BYTES));
const reclaimed = cacheTrim?.match(/^Total:\s*(\S+)/m)?.[1];
if (reclaimed && reclaimed !== "0B") {
  console.log(`trimmed Docker's build cache by ${reclaimed}; kept the most recently used ${formatBytes(BUILD_CACHE_KEEP_BYTES)}.`);
}
