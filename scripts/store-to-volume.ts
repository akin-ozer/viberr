/**
 * Ruling 460: move the store from the `./docker-data` bind mount into the named
 * volume `viberr-data` that compose.yml now mounts at /data — once.
 *
 *   docker compose stop app
 *   npm run store:to-volume            # or: npm run store:to-volume -- <dir>
 *   # set VIBERR_STORE_EXTERNAL=true in .env (ruling 504: a store Compose did not make)
 *   docker compose up -d
 *
 *   npm run store:to-volume -- <dir> --volume <name>   # a rehearsal elsewhere
 *
 * Why: every agent process runs as its person's own OS user, and what keeps it
 * out of the projection database and other people's sign-ins is file
 * permissions. A macOS bind mount does not enforce those between uids at all
 * (measured: uid 65534 read a 0600 file owned by 1000), so a store left there
 * boots `agentIsolation: degraded`.
 *
 * It takes the data-root WRITER lock on the source first (B-FD1), so it
 * refuses while the app still runs on it — the running container holds that
 * lock. It refuses, too, when the volume already holds a store: this is a
 * one-time move, never a merge. The copy keeps every file and makes the whole
 * tree the server's (uid 1000), minus this command's own lock file; the app
 * re-asserts the layout and hands each person's home to their agent uid at its
 * next boot. The source directory is left as it was, as the fallback.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runWithDataRootWriterLock } from "../app/server/db/cli-lock.server";
import { DATA_ROOT_LOCK_FILENAME } from "../app/server/db/data-root-lock.server";

/** `--volume <name>` targets another volume (a rehearsal); the default is the
 *  one compose.yml mounts. */
const volumeFlag = process.argv.indexOf("--volume");
const VOLUME = volumeFlag === -1 ? "viberr-data" : (process.argv[volumeFlag + 1] ?? "");
/** The helper container: the image the app is built on, nothing of the app's. */
const HELPER_IMAGE = "node:26-slim";
const positional = process.argv
  .slice(2)
  .filter((arg, index, args) => arg !== "--volume" && args[index - 1] !== "--volume");
const source = path.resolve(positional[0] ?? "./docker-data");

if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(VOLUME)) {
  console.error(`store:to-volume: "${VOLUME}" is not a volume name.`);
  process.exit(1);
}

if (!existsSync(path.join(source, "state"))) {
  console.error(`store:to-volume: ${source} holds no store (there is no state/ in it).`);
  process.exit(1);
}

function docker(args: string[], inherit = false) {
  return spawnSync("docker", args, { stdio: inherit ? "inherit" : "pipe", encoding: "utf8" });
}

await runWithDataRootWriterLock(
  "`npm run store:to-volume`",
  () => {
    const existing = docker(["run", "--rm", "-v", `${VOLUME}:/data`, HELPER_IMAGE, "test", "-e", "/data/state"]);
    if (existing.error) {
      console.error(`store:to-volume: docker is not available: ${existing.error.message}`);
      process.exitCode = 1;
      return;
    }
    if (existing.status === 0) {
      console.error(
        `store:to-volume: the volume ${VOLUME} already holds a store (it has a state/). ` +
          "This is a one-time move and never merges; remove the volume first if you mean to replace it " +
          `(docker volume rm ${VOLUME}), after a backup.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`store:to-volume: copying ${source} into the volume ${VOLUME}…`);
    const copy = docker(
      [
        "run",
        "--rm",
        "-v",
        `${VOLUME}:/data`,
        "-v",
        `${source}:/from:ro`,
        HELPER_IMAGE,
        "sh",
        "-c",
        `cp -a /from/. /data/ && rm -f /data/state/${DATA_ROOT_LOCK_FILENAME} && chown -R 1000:1000 /data`,
      ],
      true,
    );
    if (copy.status !== 0) {
      console.error(`store:to-volume: the copy failed (exit ${copy.status}). ${source} is unchanged.`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `store:to-volume: done. The volume holds real data and Compose did not make it, so set ` +
        `VIBERR_STORE_EXTERNAL=true in .env (ruling 504), then start the app (docker compose up -d); ` +
        `/resources/health should report agentIsolation.status "on". ${source} is left as it was: ` +
        `keep it until you have checked, then remove it.`,
    );
  },
  {
    dataRoot: source,
    alternative: "Stop the app first (docker compose stop app): the store must not move under a running server.",
  },
);
