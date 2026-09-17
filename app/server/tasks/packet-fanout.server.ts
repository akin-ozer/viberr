import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  taskPacketSchema,
  type PacketOption,
  type PacketOptionKind,
  type TaskPacket,
} from "~/schemas/task-file.schema";

/**
 * Ruling 319 — one account failure, one decision.
 *
 * Ruling 315 stamped `packet.cause` on every packet a BACKEND failure raises:
 * `backend:<backend>:<kind>:<credentialUserId>`, the thing that actually
 * failed. Its own field comment promised what the stamp was for — "packets that
 * share a cause resolve together: answering one applies the same option to
 * every sibling still carrying it" — and nothing read the field. The sentence
 * was true about the intent and false about the product, which is the shape
 * this whole pass has been chasing: a confident line standing in front of
 * behaviour that does not exist.
 *
 * This module is the half that was missing. It finds the siblings and decides
 * which of their options is the SAME option, in a form that is testable without
 * a resolution; `resolvePacket` runs the loop, because a sibling is resolved by
 * the real resolution path (authority, events, notifications, dispatch) and by
 * nothing cheaper.
 */

/** A projected row carrying an open packet that shares a cause. */
const siblingRow = z.object({
  project_slug: z.string(),
  task_key: z.string(),
  title: z.string(),
  packet_json: z.string(),
});

export interface CauseSibling {
  projectSlug: string;
  taskKey: string;
  title: string;
  packet: TaskPacket;
}

/**
 * The option kinds a shared CAUSE may answer for more than one task.
 *
 * A packet keyed to an account can only ever be asking a coordination
 * question — every kind here is one `describeRunFailure` (plus the stock hold)
 * actually writes onto a backend-failure packet. The list is an ALLOW-list
 * rather than a deny-list of the dangerous kinds, because the danger is
 * asymmetric: a kind that leaks in later and should not have would fan a
 * one-way write (a merge, an archive, a branch deletion) across tasks whose
 * human never saw them, and a kind wrongly left out only leaves a sibling
 * packet open with a note saying so.
 *
 * `custom` is deliberately absent though the resolver offers it on every
 * packet: a directive a person types is about the task in front of them, and
 * re-aiming that sentence at four other tasks is exactly the kind of confident
 * guess this ruling exists to stop.
 */
export const FANNED_OUT_OPTION_KINDS: ReadonlySet<PacketOptionKind> = new Set([
  "retry_other_backend",
  "wait_for_window",
  "request_edit",
  "redirect",
  "hold_runtime_debug",
  "block_on_policy",
]);

/**
 * Every OTHER task carrying an open, undecided packet with this exact cause.
 *
 * Cross-project on purpose: the cause names a credential, and a quota that runs
 * out takes out every task that account is paying for wherever it sits. The
 * authority to answer each one is re-checked per sibling by the resolution
 * itself — this read is a search, not a grant.
 *
 * Read from the projection (the index that can answer it without opening every
 * task file) and re-checked against the file by the caller before anything is
 * written: a projection can lag a resolution by the width of one reproject.
 */
export function siblingPacketsSharingCause(
  db: DatabaseSync,
  cause: string,
  origin: { projectSlug: string; taskKey: string },
): CauseSibling[] {
  const rows = db
    .prepare(
      `SELECT project_slug, task_key, title, packet_json
         FROM task_projections
        WHERE archived = 0
          AND packet_json IS NOT NULL
          AND packet_json <> ''
          AND json_extract(packet_json, '$.cause') = ?
          AND NOT (project_slug = ? AND task_key = ?)
        ORDER BY project_slug, task_key`,
    )
    .all(cause, origin.projectSlug, origin.taskKey);

  return rows.flatMap((row) => {
    const parsedRow = siblingRow.safeParse(row);
    if (!parsedRow.success) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(parsedRow.data.packet_json);
    } catch {
      return [];
    }
    const packet = taskPacketSchema.safeParse(raw);
    if (!packet.success) return [];
    // A packet already answered is not a sibling waiting on this answer.
    if (packet.data.awaiting || packet.data.decided) return [];
    return [
      {
        projectSlug: parsedRow.data.project_slug,
        taskKey: parsedRow.data.task_key,
        title: parsedRow.data.title,
        packet: packet.data,
      },
    ];
  });
}

/**
 * Where the SAME option sits on a sibling's packet, or null if it offers none.
 *
 * By kind, never by index: `describeRunFailure` composes the option set from
 * the failure AND from what the task's own owner has connected, so "retry on
 * the other backend" is present on one task and absent on the next, and the
 * indexes behind it all shift. Resolving a sibling by the origin's index is how
 * "wait for the window to reopen" becomes "send the agent back to continue" on
 * the task nobody was looking at.
 *
 * `backend` is matched too, because two `retry_other_backend` options are only
 * the same answer when they name the same backend. `profileId` is deliberately
 * NOT matched: it names each task's own agent, and requiring it to agree would
 * mean no sibling ever matches.
 */
export function siblingOptionIndex(
  sibling: TaskPacket,
  chosen: PacketOption,
): number | null {
  if (!FANNED_OUT_OPTION_KINDS.has(chosen.kind)) return null;
  const at = sibling.options.findIndex(
    (o) => o.kind === chosen.kind && (chosen.backend ? o.backend === chosen.backend : true),
  );
  return at >= 0 ? at : null;
}

/** An English list: "SHOP-3", "SHOP-3 and SHOP-9", "SHOP-3, SHOP-9 and SHOP-24". */
export function joinKeys(keys: readonly string[]): string {
  if (keys.length <= 1) return keys[0] ?? "";
  return `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;
}

/**
 * What the card says BEFORE the confirm, when this decision reaches past the
 * task it is drawn on.
 *
 * Stated as a count and the keys, not as a promise about the specific option
 * the person has not picked yet: which siblings actually take the answer
 * depends on that pick, and the resolution records the real outcome on every
 * task it touched. Overstating it here would be the same failure in a smaller
 * font.
 */
export function causeFanOutDisclosure(siblings: readonly CauseSibling[]): string | null {
  if (siblings.length === 0) return null;
  const keys = joinKeys(siblings.map((s) => s.taskKey));
  const them = siblings.length === 1 ? "one other task" : `${siblings.length} other tasks`;
  return (
    `The same failure stopped ${them}: ${keys}. ` +
    "Answering here answers each of them the same way, wherever that task's packet offers " +
    "the option you pick — you are deciding about the account, not about this task alone. " +
    "A directive you write yourself applies only here."
  );
}

/** One sibling's outcome, for the record written on the task that decided. */
export type FanOutOutcome =
  | { taskKey: string; applied: true }
  | { taskKey: string; applied: false; why: string };

/**
 * The note left on the DECIDING task: what the decision reached, and what it
 * did not.
 *
 * The misses are the point. A sibling that could not take the answer — no such
 * option on its packet, a role the decider does not hold there, a resolution
 * that threw — is still sitting in someone's queue, and the person who thought
 * they had just cleared it is the one who has to know.
 */
export function fanOutOutcomeText(outcomes: readonly FanOutOutcome[]): string | null {
  if (outcomes.length === 0) return null;
  const applied = outcomes.filter((o) => o.applied).map((o) => o.taskKey);
  const missed = outcomes.flatMap((o) => (o.applied ? [] : [o]));
  const parts: string[] = [];
  if (applied.length > 0) {
    parts.push(
      `The same answer was applied to ${joinKeys(applied)}, stopped by the same failure.`,
    );
  }
  for (const miss of missed) {
    parts.push(`${miss.taskKey} was **not** answered: ${miss.why} Its packet is still open.`);
  }
  return parts.join(" ");
}

/** The note left on a sibling: where its answer came from. */
export function fanOutArrivalText(input: {
  fromTaskKey: string;
  byName: string;
  optionTitle: string;
}): string {
  return (
    `Answered from ${input.fromTaskKey}: ${input.byName} chose "${input.optionTitle}" there for ` +
    "the account failure that stopped both tasks, and the same choice was applied here."
  );
}
