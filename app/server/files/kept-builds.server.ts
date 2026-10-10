/**
 * Ruling 86: the pages a delivered revision builds are kept as built.
 *
 * A files delivery is kept as delivered (`kept-deliveries.server.ts`), and its
 * pages are pictured, measured and looked at from that copy. A revision had no
 * such copy: its pages exist only once the repository is built, in a checkout
 * that is removed when the project's gates have run. So a board that ships a
 * site through pull requests was pictured by nobody, and its reviewer looked
 * at whatever its own browser showed of its own build.
 *
 * Where a gate says which folder it builds the pages into (`pages` on the gate,
 * ruling 104), that folder is copied here once every gate has passed, into
 * `tasks/<KEY>/builds/<revisionId>/`: the server's own, beside `attachments/`
 * and `deliveries/`, unseen by the attachments panel and never an agent's to
 * write. What a judge is shown of the revision, and what Viberr pictures and
 * measures of it, is this copy.
 */
import { constants, lstatSync, mkdirSync, readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProjectGate } from "~/schemas/project-file.schema";
import { PAGE_CAPTURE_MAX_PAGES, pageKindOf } from "~/shared/page-capture";
import { taskDir } from "./file-store-root.server";

/** A revision's id as a folder name: what `newId` makes, and nothing a path
 *  could be built from. */
const REVISION_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A folder a gate builds pages into, as the project names it: plain names
 *  between slashes, relative to the checkout, never above it. */
const PAGES_DIR = /^(?!\.)[A-Za-z0-9._-]+(?:\/(?!\.)[A-Za-z0-9._-]+)*$/;
export const PAGES_DIR_MAX_CHARS = 200;

/** The most a kept build holds: a site's pages and what they load, not a
 *  repository's whole output. What is past these is left out and counted. */
export const KEPT_BUILD_MAX_FILES = 2_000;
export const KEPT_BUILD_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const KEPT_BUILD_MAX_BYTES = 200 * 1024 * 1024;
/** How many revisions' builds a task keeps: the one under review and the one
 *  before it. */
const KEPT_BUILDS = 2;
const COPY_CHUNK_BYTES = 1024 * 1024;

function buildsDir(slug: string, key: string, dataRoot?: string): string {
  return path.join(taskDir(slug, key, dataRoot), "builds");
}

/** The pages folder a project names, or null when it is not a plain path
 *  relative to the checkout. */
export function plainPagesDir(named: string): string | null {
  const dir = named.trim().replace(/\/+$/, "");
  return dir.length <= PAGES_DIR_MAX_CHARS && PAGES_DIR.test(dir) ? dir : null;
}

/** Ruling 104: a gate says which folder of the checkout it builds the
 *  project's pages into (`pages`). Read here and not declared on the schema,
 *  whose module the browser loads: a gate row keeps the keys it is given. */
const gatePagesSchema = z.looseObject({ pages: z.string() });

/**
 * The folder, relative to a checkout of the repository, the project's gates
 * build its pages into: what the first gate that names one says, or null
 * when none does (or it names no plain relative path).
 */
export function projectPagesDir(gates: readonly ProjectGate[] | undefined): string | null {
  for (const gate of gates ?? []) {
    const named = gatePagesSchema.safeParse(gate);
    const dir = named.success ? plainPagesDir(named.data.pages) : null;
    if (dir) return dir;
  }
  return null;
}

/**
 * The pages among a build's files: its HTML files, the site's own front page
 * first, then the shallowest, then by path. `pages` are the first
 * {@link PAGE_CAPTURE_MAX_PAGES}, the ones pictured and looked at; `extra`
 * the rest. A site is every page a reader can land on, and which of them a
 * revision changed is not something a build says.
 */
export function builtPagesAmong(files: readonly string[]) {
  const depth = (file: string): number => file.split("/").length;
  const html = files
    .filter((file) => pageKindOf(file) === "html")
    .sort(
      (a, b) =>
        Number(b === "index.html") - Number(a === "index.html") || depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
  return { pages: html.slice(0, PAGE_CAPTURE_MAX_PAGES), extra: html.slice(PAGE_CAPTURE_MAX_PAGES) };
}

/**
 * The file of a built site a reader means by `asked`: a path from the site's
 * root or relative to it, and a folder's path for its `index.html`. Null for
 * a path that is none (an empty or dotted segment, a backslash).
 */
export function sitePath(asked: string): string | null {
  const trimmed = asked.trim().replace(/^\/+/, "");
  const wanted = trimmed === "" || trimmed.endsWith("/") ? `${trimmed}index.html` : trimmed;
  const plain = wanted.split("/").every((segment) => segment !== "" && !segment.startsWith(".") && !/[\\\0]/.test(segment));
  return plain ? wanted : null;
}

/** The folder that holds the kept build of `revisionId`, or null for an id
 *  that cannot be one. Whether it exists is the reader's to find out. */
export function keptBuildDir(slug: string, key: string, revisionId: string, dataRoot?: string): string | null {
  return REVISION_ID.test(revisionId) ? path.join(buildsDir(slug, key, dataRoot), revisionId) : null;
}

/** A name a build keeps: no dot name (a tool's own folder, never a page's
 *  file) and nothing a path is built from. */
function keepable(name: string): boolean {
  return name !== "" && !name.startsWith(".") && !/[/\\\0]/.test(name) && name !== "node_modules";
}

/** The entries of a folder that is a folder and no link; none otherwise. */
function entriesOf(dir: string): Dirent[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The files of a kept build, as paths relative to it with `/` between
 * segments, in code-point order; none when it is not there. The tree is the
 * server's own, so it is walked as it stands.
 */
export function keptBuildFiles(dir: string | null): string[] {
  if (!dir) return [];
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of entriesOf(path.join(dir, rel))) {
      const at = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(at);
      else if (entry.isFile()) files.push(at);
    }
  };
  walk("");
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** What a keep did. */
export interface KeptBuild {
  files: number;
  bytes: number;
  /** Files of the built folder that were not kept: past the limits. */
  leftOut: number;
}

/** Copy one regular file, by descriptor at both ends and never through a
 *  link; null when the source is anything else, or grew past `room`. */
async function copyFile(source: string, copy: string, room: number): Promise<number | null> {
  let from: Awaited<ReturnType<typeof open>>;
  try {
    from = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await from.stat();
    if (!stat.isFile() || stat.size > room) return null;
    const to = await open(copy, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let bytes = 0;
    try {
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(COPY_CHUNK_BYTES, stat.size)));
      for (;;) {
        const { bytesRead } = await from.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > room) break;
        for (let written = 0; written < bytesRead; ) {
          written += (await to.write(buffer, written, bytesRead - written)).bytesWritten;
        }
      }
    } finally {
      await to.close();
    }
    if (bytes > room) {
      rmSync(copy, { force: true });
      return null;
    }
    return bytes;
  } finally {
    await from.close();
  }
}

/** `folder` under `checkout` when every level on the way down is a folder
 *  and no link; null otherwise. */
function plainFolderUnder(checkout: string, folder: string): string | null {
  let dir = checkout;
  for (const segment of folder.split("/")) {
    dir = path.join(dir, segment);
    try {
      if (!lstatSync(dir).isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return dir;
}

/**
 * Keep `folder` of `checkout` (the pages a gate built, in the gate's own
 * checkout) as the build of `revisionId`. The checkout is the agents' to
 * write, so nothing is read through a link: each folder on the way, from the
 * checkout's root down, is checked to be a folder, each file is opened
 * without following one, and dot names and `node_modules` are left where
 * they are. Checked, not held: the gates' commands have ended by now, and
 * nothing else writes their checkout. Replaces a build kept for the same
 * revision, and removes all but the newest {@link KEPT_BUILDS}.
 *
 * Throws when the revision's id is no folder name or the build's own folder
 * cannot be made; a file that cannot be copied is left out and counted.
 */
export async function keepBuild(
  slug: string,
  key: string,
  revisionId: string,
  checkout: string,
  folder: string,
  dataRoot?: string,
): Promise<KeptBuild> {
  const into = keptBuildDir(slug, key, revisionId, dataRoot);
  if (!into) throw new Error(`"${revisionId}" is not a revision's id`);
  const root = buildsDir(slug, key, dataRoot);
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true, mode: 0o700 });
  const kept: KeptBuild = { files: 0, bytes: 0, leftOut: 0 };
  const from = plainFolderUnder(checkout, folder) ?? "";
  const folders = from === "" ? [] : [""];
  while (folders.length > 0) {
    const rel = folders.shift() ?? "";
    const entries = entriesOf(path.join(from, rel)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (!keepable(entry.name)) continue;
      const at = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        folders.push(at);
        continue;
      }
      if (!entry.isFile()) continue;
      const room = Math.min(KEPT_BUILD_FILE_MAX_BYTES, KEPT_BUILD_MAX_BYTES - kept.bytes);
      if (kept.files >= KEPT_BUILD_MAX_FILES) {
        kept.leftOut += 1;
        continue;
      }
      mkdirSync(path.dirname(path.join(into, at)), { recursive: true, mode: 0o700 });
      const bytes = await copyFile(path.join(from, at), path.join(into, at), room);
      if (bytes === null) {
        kept.leftOut += 1;
        continue;
      }
      kept.files += 1;
      kept.bytes += bytes;
    }
  }
  // The builds before the last two go: a verdict on an older revision is
  // stale, and nothing reads its pages again.
  const others = entriesOf(root)
    .filter((entry) => entry.isDirectory() && entry.name !== revisionId)
    .map((entry) => {
      let at = 0;
      try {
        at = statSync(path.join(root, entry.name)).mtimeMs;
      } catch {
        at = 0;
      }
      return { name: entry.name, at };
    })
    .sort((a, b) => b.at - a.at);
  for (const old of others.slice(KEPT_BUILDS - 1)) rmSync(path.join(root, old.name), { recursive: true, force: true });
  return kept;
}
