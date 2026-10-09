import { pluralNoun } from "~/shared/text/plural";

/**
 * Ruling 222: which repositories a GitHub connection's token reaches, in the
 * shape every surface renders (the Instance settings card, the controller's
 * `list_github_connections`). The server reads and stores it
 * (`app/server/org/connection-reach.server.ts`); this module is the
 * client-safe half, so the card and the controller say one sentence.
 */

/** The most repositories one read records (three pages of 100). */
export const REACH_CAP = 300;

/** One repository the token reaches. `canPush` is null when GitHub sent no
 *  permission block to judge by. */
export interface ReachedRepo {
  fullName: string;
  private: boolean;
  canPush: boolean | null;
}

/** The reach as read: the list with its counts, or why it could not be read.
 *  A connection whose token has not been read since the read existed has no
 *  reach at all (null on the record), which is neither of these. */
export type ConnectionReach =
  | {
      status: "read";
      readAt: string;
      repos: ReachedRepo[];
      /** The read stopped at its cap; more repositories may exist. */
      capped: boolean;
      total: number;
      privateCount: number;
    }
  | { status: "unknown"; readAt: string; reason: string };

/** "3 repositories · 1 private", or "300+ repositories · 12 private" when the
 *  read stopped at its cap. */
export function reachSummary(
  reach: Extract<ConnectionReach, { status: "read" }>,
): string {
  const count = reach.capped ? `${reach.total}+` : String(reach.total);
  const noun = pluralNoun(reach.capped ? 2 : reach.total, "repository", "repositories");
  return `${count} ${noun} · ${reach.privateCount} private`;
}
