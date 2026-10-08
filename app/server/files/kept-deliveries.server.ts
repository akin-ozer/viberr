/**
 * Ruling 597: a delivery that is not a commit is kept as it was delivered.
 *
 * A files delivery is reviewed as `files:<deliveredAt>` (ruling 388) and moves
 * when a delivered file is saved again (ruling 587), but the attachments folder
 * holds only the newest bytes under each name. A commit stays readable after
 * the branch moves on; a rework that saves `mapping.md` again left every
 * verdict on the earlier delivery pointing at content that no longer existed.
 * Live in round 4 the Estimate Judge re-reviewing AWSC-43 scored the first
 * delivery "a reconstruction from the surviving first-delivery exports", and
 * on AWSC-46 it "could not independently diff it against the prior version".
 *
 * So the files are copied, as they stand, into `deliveries/<stamp>/` beside the
 * task's attachments whenever a delivery is stamped. The folder sits outside
 * `attachments/`, so the attachments panel, the browser's output folder and
 * the working-file prune never see it, and it moves with the task directory.
 */
import {
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pageCapturesAmong } from "~/shared/page-capture";
import {
  resolveStoreSegment,
  resolveStoredSegment,
  taskAttachmentsDir,
  taskDir,
} from "./file-store-root.server";

/** A `deliveredAt` stamp: an ISO instant in UTC, as Viberr writes it. */
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d{1,9})?)Z$/;
/** Its folder: the time's colons as dashes, a name every file system takes. */
const STAMP_DIR = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d{1,9})?)Z$/;

export function taskDeliveriesDir(slug: string, key: string, dataRoot?: string): string {
  return path.join(taskDir(slug, key, dataRoot), "deliveries");
}

function stampDir(stamp: string): string | null {
  const m = STAMP.exec(stamp.trim());
  return m ? `${m[1]}T${m[2]}-${m[3]}-${m[4]}Z` : null;
}

function dirStamp(dir: string): string | null {
  const m = STAMP_DIR.exec(dir);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null;
}

/** Ruling 691: the folder that holds the kept delivery `stamp`, or null for a
 *  stamp that cannot be one. Whether it exists is the reader's to find out. */
export function keptDeliveryDir(slug: string, key: string, stamp: string, dataRoot?: string): string | null {
  const dir = stampDir(stamp);
  return dir ? path.join(taskDeliveriesDir(slug, key, dataRoot), dir) : null;
}

/**
 * Copy a delivery's files, as the attachments folder holds them now, into the
 * kept delivery `stamp`. A name the folder no longer holds is skipped. Returns
 * the names kept.
 */
export function keepDelivery(
  slug: string,
  key: string,
  stamp: string,
  names: Iterable<string>,
  dataRoot?: string,
): string[] {
  const dir = stampDir(stamp);
  if (!dir) return [];
  const into = path.join(taskDeliveriesDir(slug, key, dataRoot), dir);
  const kept: string[] = [];
  for (const name of names) {
    let from: string;
    try {
      from = resolveStoreSegment(taskAttachmentsDir(slug, key, dataRoot), name);
      if (!statSync(from).isFile()) continue;
    } catch {
      continue;
    }
    mkdirSync(into, { recursive: true });
    copyFileSync(from, resolveStoreSegment(into, name), constants.COPYFILE_FICLONE);
    kept.push(name);
  }
  return kept.sort();
}

export interface KeptDelivery {
  deliveredAt: string;
  files: string[];
}

/** A task's kept deliveries, newest first, each with its files. */
export function listKeptDeliveries(slug: string, key: string, dataRoot?: string): KeptDelivery[] {
  const root = taskDeliveriesDir(slug, key, dataRoot);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const kept: KeptDelivery[] = [];
  for (const dir of dirs) {
    const deliveredAt = dirStamp(dir);
    if (!deliveredAt) continue;
    let files: string[];
    try {
      files = readdirSync(path.join(root, dir)).sort();
    } catch {
      continue;
    }
    if (files.length > 0) kept.push({ deliveredAt, files });
  }
  return kept.sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
}

/** What differs between a kept delivery and the task's files now, by name. */
export interface KeptDeliveryChanges {
  changed: string[];
  added: string[];
  removed: string[];
  same: string[];
}

/** Two files are read side by side in pieces of this size, so a large
 *  delivery is never held in memory twice. */
const COMPARE_CHUNK_BYTES = 64 * 1024;

/** True when two files hold the same bytes. A file that cannot be read, or
 *  is not a regular file, is not the same as anything: it is told as changed,
 *  which sends a reader to look. */
function sameBytes(a: string, b: string): boolean {
  let fa: number | null = null;
  let fb: number | null = null;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    fa = openSync(a, "r");
    fb = openSync(b, "r");
    const ba = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
    const bb = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
    for (;;) {
      const na = readSync(fa, ba, 0, COMPARE_CHUNK_BYTES, null);
      const nb = readSync(fb, bb, 0, COMPARE_CHUNK_BYTES, null);
      if (na !== nb) return false;
      if (na === 0) return true;
      if (!ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
    }
  } catch {
    return false;
  } finally {
    if (fa !== null) closeSync(fa);
    if (fb !== null) closeSync(fb);
  }
}

/**
 * Ruling 703: the task's files as they stand now set against the kept
 * delivery `judged`, byte for byte, or null when that delivery was not kept.
 *
 * `now` is the names in the task's attachments folder that the caller counts
 * as the task's files. It is the folder that is read, not the kept copy of
 * the newest delivery: a reviewer opens the folder, and a file can change
 * there without the delivery moving (a supporting agent's first save of a
 * name, a person's upload or removal). `leftOut` is the caller's rule for a
 * name of the kept delivery that is not one of the task's files either.
 *
 * The pictures Viberr makes of a delivered page (ruling 691) are left out of
 * the kept side here as the caller leaves them out of `now`: they are remade
 * at every delivery, and the note is about the files, not about Viberr's own
 * pictures of them.
 *
 * One file stored under two Unicode forms of its name is one file (ruling
 * 675), named as the folder has it now.
 */
export function changesSinceKeptDelivery(
  slug: string,
  key: string,
  judged: string,
  now: readonly string[],
  leftOut: (name: string) => boolean,
  dataRoot?: string,
): KeptDeliveryChanges | null {
  const dir = keptDeliveryDir(slug, key, judged, dataRoot);
  if (!dir) return null;
  let listed: string[];
  try {
    listed = readdirSync(dir);
  } catch {
    return null;
  }
  const own = pageCapturesAmong(listed);
  const composed = (name: string) => name.normalize("NFC");
  const before = new Map(
    listed.filter((name) => !own.has(name) && !leftOut(name)).map((name) => [composed(name), name]),
  );
  const after = new Map(now.map((name) => [composed(name), name]));
  const attachments = taskAttachmentsDir(slug, key, dataRoot);
  const changes: KeptDeliveryChanges = { changed: [], added: [], removed: [], same: [] };
  for (const [id, name] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    const kept = before.get(id);
    if (kept === undefined) changes.added.push(name);
    else if (sameBytes(path.join(dir, kept), path.join(attachments, name))) changes.same.push(name);
    else changes.changed.push(name);
  }
  for (const [id, name] of [...before].sort(([a], [b]) => a.localeCompare(b))) {
    if (!after.has(id)) changes.removed.push(name);
  }
  return changes;
}

/** Where a kept delivery holds `name`, or null for a stamp or a name that
 *  cannot be one. Whether the file exists is the reader's to find out. */
export function resolveKeptDeliveryFile(
  slug: string,
  key: string,
  stamp: string,
  name: string,
  dataRoot?: string,
): string | null {
  const dir = stampDir(stamp);
  if (!dir) return null;
  try {
    return resolveStoredSegment(path.join(taskDeliveriesDir(slug, key, dataRoot), dir), name.trim());
  } catch {
    return null;
  }
}

/** What a reader answers when a kept delivery does not hold the file asked
 *  for: the deliveries the task kept, or the files that delivery held. */
export function keptDeliveryMiss(
  slug: string,
  key: string,
  stamp: string,
  name: string,
  dataRoot?: string,
): string {
  const kept = listKeptDeliveries(slug, key, dataRoot);
  const held = kept.find((d) => d.deliveredAt === stamp.trim());
  if (held) {
    return `[noop] ${key}'s delivery of ${held.deliveredAt} held no \`${name.trim()}\`. It held: ${held.files.join(", ")}.`;
  }
  return (
    `[noop] ${key} kept no delivery at \`${stamp.trim()}\`. ` +
    (kept.length > 0
      ? `Its kept deliveries, newest first: ${kept.map((d) => d.deliveredAt).join(", ")}.`
      : "It has kept none: its deliveries are commits, or it has not delivered files yet.")
  );
}
