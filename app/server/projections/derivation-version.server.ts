import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getSetting, setSetting } from "~/server/settings/instance-settings.server";
import { rescanProjections } from "./rescan.server";
import type { RescanSummary } from "./rebuilder.server";

/**
 * The projection DERIVATION version — bump it whenever the rebuilder starts
 * deriving a projected column differently from the same file content.
 *
 * The boot rescan is a content-hash short-circuit: an unchanged task.md is
 * never re-projected, which is exactly right for offline drift and exactly
 * wrong for a derivation change — the rows written under the old rule keep
 * the old shape forever, on every existing instance, with no migration to say
 * so (the store has none by ruling: files are canonical, projections are
 * rebuilt). D32-14 (pass 32) was the first such change: `task_events.actor_ref`
 * for agents went from `<backend>/<profileId>` to `agent/<profileId>`, so an
 * instance that only rescanned would list one profile's old Codex-leg ref and
 * new ref side by side in the Activity actor filter. This stamp makes a
 * derivation change self-applying: a stored version behind the current one
 * forces ONE full rebuild at boot, then records the version.
 *
 * History: 1 = pre-pass-32 (implicit); 2 = D32-14 actor_ref keyed by profile;
 * 3 = ruling 131 (pass 34) put `blockedBy` on every goal LINK, and
 * `goal_projections.links_json` is only rewritten when the goal file's content
 * hash changes — an existing store's rows carry links with no such key, which
 * the Controller page reads. This stamp forces the one rebuild that fills them.
 * 4 = ruling 225 (pass 37) derives a FOURTH `waiting` value, `schedule`, from
 * the same task file: a task resting on a pending occurrence with nothing
 * pending on a person. Every row written under the old rule says `human`
 * forever otherwise — which is exactly what happened. Ruling 225 deployed at
 * 03:32 UTC, the boot rescan reported `changed=0` because no file had changed,
 * and SHOP-21's card and rail went on reading "waiting on a human" over a
 * schedule pending for 07:29. This file's whole first paragraph describes that
 * failure, and I shipped the ruling without bumping the stamp it describes.
 */
export const PROJECTION_DERIVATION_VERSION = 4;

const SETTING_KEY = "projection.derivationVersion";

export interface DerivationCheck {
  /** The version the store was projected under before this call (1 when the
   *  stamp was absent — every pre-stamp instance). */
  previous: number;
  /** Set when a full forced rebuild ran because the stamp was behind. */
  rebuilt: RescanSummary | null;
  /** False when the rebuild ran but a file failed to project: the stamp stays
   *  behind so the NEXT boot retries (review F5, pass 32) — otherwise the rows
   *  of an unreadable task would keep the old derivation forever under a stamp
   *  that claims otherwise. */
  stamped: boolean;
}

/** Boot: force a full rebuild when the derivation moved on, then stamp. */
export function ensureProjectionDerivation(
  db: DatabaseSync,
  options: { dataRoot?: string } = {},
): DerivationCheck {
  const previous = getSetting(db, SETTING_KEY, z.number().int().positive()) ?? 1;
  if (previous === PROJECTION_DERIVATION_VERSION) {
    return { previous, rebuilt: null, stamped: true };
  }
  const rebuilt = rescanProjections(db, { dataRoot: options.dataRoot, force: true });
  // `rebuildAll` counts a file it could not project into `errors` rather than
  // throwing; only a clean pass earns the stamp.
  const stamped = rebuilt.errors === 0;
  if (stamped) setSetting(db, SETTING_KEY, PROJECTION_DERIVATION_VERSION);
  return { previous, rebuilt, stamped };
}
