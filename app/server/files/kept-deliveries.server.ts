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
import { constants, copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** What differs between two kept deliveries of one task, by file name. */
export interface KeptDeliveryChanges {
  changed: string[];
  added: string[];
  removed: string[];
  same: string[];
}

/**
 * Ruling 703: the files of the kept delivery `to` set against those of the
 * kept delivery `from`, byte for byte, or null when either was not kept.
 *
 * The pictures Viberr makes of a delivered page (ruling 691) are left out:
 * they are remade at every delivery and say nothing the page they picture
 * does not.
 */
export function keptDeliveryChanges(
  slug: string,
  key: string,
  from: string,
  to: string,
  dataRoot?: string,
): KeptDeliveryChanges | null {
  const filesOf = (stamp: string): { dir: string; names: Set<string> } | null => {
    const dir = keptDeliveryDir(slug, key, stamp, dataRoot);
    if (!dir) return null;
    let listed: string[];
    try {
      listed = readdirSync(dir);
    } catch {
      return null;
    }
    const own = pageCapturesAmong(listed);
    return { dir, names: new Set(listed.filter((name) => !own.has(name))) };
  };
  const before = filesOf(from);
  const after = filesOf(to);
  if (!before || !after) return null;
  const sameBytes = (name: string): boolean => {
    const a = path.join(before.dir, name);
    const b = path.join(after.dir, name);
    try {
      if (statSync(a).size !== statSync(b).size) return false;
      return readFileSync(a).equals(readFileSync(b));
    } catch {
      return false;
    }
  };
  const changes: KeptDeliveryChanges = { changed: [], added: [], removed: [], same: [] };
  for (const name of [...after.names].sort()) {
    if (!before.names.has(name)) changes.added.push(name);
    else if (sameBytes(name)) changes.same.push(name);
    else changes.changed.push(name);
  }
  for (const name of [...before.names].sort()) {
    if (!after.names.has(name)) changes.removed.push(name);
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
