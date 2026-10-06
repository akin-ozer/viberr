import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  PACKET_OPTION_KINDS,
  taskPacketSchema,
  type PacketOption,
  type PacketOptionKind,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import { deleteSetting, getSetting, setSetting } from "~/server/settings/instance-settings.server";
import { isRepositoryAskCause } from "~/shared/repository-ask";
import type { TaskActor } from "./task-mutation.server";

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
  // Ruling 672: the repository question is asked about the BOARD, on whichever
  // task met the need first, so both of its answers reach every task on the
  // board that asked. Neither writes anything on a sibling: the repository is
  // attached, or the ruling written, once, on the task the person answered.
  "connect_repository",
  "keep_without_repository",
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
function joinKeys(keys: readonly string[]): string {
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
export function causeFanOutDisclosure(
  siblings: readonly CauseSibling[],
  cause?: string,
): string | null {
  if (siblings.length === 0) return null;
  const keys = joinKeys(siblings.map((s) => s.taskKey));
  const them = siblings.length === 1 ? "one other task" : `${siblings.length} other tasks`;
  // Ruling 672: the repository question shares a cause too, and nothing
  // failed: the same question stands on each task.
  if (isRepositoryAskCause(cause)) {
    return (
      `The same question is open on ${them}: ${keys}. ` +
      "Answering here answers each of them the same way: you are deciding about the board, " +
      "not about this task alone. A directive you write yourself applies only here."
    );
  }
  return (
    `The same failure stopped ${them}: ${keys}. ` +
    "Answering here answers each of them the same way, wherever that task's packet offers " +
    "the option you pick: you are deciding about the account, not about this task alone. " +
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
export function fanOutOutcomeText(
  outcomes: readonly FanOutOutcome[],
  cause?: string,
): string | null {
  if (outcomes.length === 0) return null;
  const applied = outcomes.filter((o) => o.applied).map((o) => o.taskKey);
  const missed = outcomes.flatMap((o) => (o.applied ? [] : [o]));
  const parts: string[] = [];
  if (applied.length > 0) {
    parts.push(
      isRepositoryAskCause(cause)
        ? `The same answer was applied to ${joinKeys(applied)}, where the same question was open.`
        : `The same answer was applied to ${joinKeys(applied)}, stopped by the same failure.`,
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
  cause?: string | undefined;
}): string {
  if (isRepositoryAskCause(input.cause)) {
    return (
      `Answered from ${input.fromTaskKey}: ${input.byName} chose "${input.optionTitle}" there for ` +
      "the board, and the same question was open here."
    );
  }
  return (
    `Answered from ${input.fromTaskKey}: ${input.byName} chose "${input.optionTitle}" there for ` +
    "the account failure that stopped both tasks, and the same choice was applied here."
  );
}

/**
 * Ruling 602: one account window, one decision, for the rest of the window.
 *
 * Ruling 319 answers the siblings that are open when a person decides. A run
 * already in flight when the window closed is refused later, at its next
 * model call, and opens its own packet after the decision was made. Live on
 * AWSC-52 at 13:20 a Judge run was refused two minutes after Arda had chosen to
 * wait out the same Codex window on AWSC-51, and the owner answered the same
 * question a third time.
 *
 * So a person's answer to a quota packet whose window is known stands until
 * that window reopens, for every later packet with the same cause and the same
 * window. Only answers that run nothing on the refused account inside the
 * window may stand: waiting, retrying on the other backend, holding.
 * "Send back now" and "redirect" re-run the agent on the account that just
 * refused it; standing, they would answer their own next refusal, in a loop.
 */
export const STANDING_OPTION_KINDS: ReadonlySet<PacketOptionKind> = new Set([
  "wait_for_window",
  "retry_other_backend",
  "hold_runtime_debug",
]);

const STANDING_KEY_PREFIX = "packetCauseDecision:";

const standingDecisionSchema = z.object({
  optionKind: z.enum(PACKET_OPTION_KINDS),
  optionTitle: z.string(),
  optionBackend: z.enum(["codex", "claude"]).nullable(),
  byUserId: z.string(),
  byLabel: z.string(),
  fromTaskKey: z.string(),
  decidedAt: z.string(),
  /** The window's reopen instant: the packet's `wait_for_window` `dueAt`. */
  until: z.string(),
});
export type StandingDecision = z.infer<typeof standingDecisionSchema>;

/** The reopen instant a QUOTA packet names (its wait option's `dueAt`); null
 *  for any other cause, and for a quota whose reset the provider never named. */
export function quotaWindowEnd(packet: TaskPacket): string | null {
  if (!packet.cause || !/^backend:[^:]+:quota:/.test(packet.cause)) return null;
  return packet.options.find((o) => o.kind === "wait_for_window" && o.dueAt)?.dueAt ?? null;
}

/** Keep a person's answer to a quota packet standing for the rest of its window. */
export function recordStandingDecision(
  db: DatabaseSync,
  input: { packet: TaskPacket; option: PacketOption; actor: TaskActor; fromTaskKey: string; nowMs: number },
): void {
  const until = quotaWindowEnd(input.packet);
  if (!until || !input.packet.cause || !STANDING_OPTION_KINDS.has(input.option.kind)) return;
  if (!(Date.parse(until) > input.nowMs)) return;
  const decision: StandingDecision = {
    optionKind: input.option.kind,
    optionTitle: input.option.t,
    optionBackend: input.option.backend ?? null,
    byUserId: input.actor.userId,
    byLabel: input.actor.label,
    fromTaskKey: input.fromTaskKey,
    decidedAt: new Date(input.nowMs).toISOString(),
    until,
  };
  setSetting(db, `${STANDING_KEY_PREFIX}${input.packet.cause}`, decision);
}

/** The standing answer for this packet: same cause, same window, still closed. */
export function standingDecisionFor(
  db: DatabaseSync,
  packet: TaskPacket,
  nowMs: number,
): StandingDecision | null {
  const until = quotaWindowEnd(packet);
  if (!until || !packet.cause) return null;
  const key = `${STANDING_KEY_PREFIX}${packet.cause}`;
  const decision = getSetting(db, key, standingDecisionSchema);
  if (!decision) return null;
  if (!(Date.parse(decision.until) > nowMs)) {
    deleteSetting(db, key);
    return null;
  }
  // A new reset instant is a new window, and a new question.
  return decision.until === until ? decision : null;
}

/** The note left on a packet a standing decision answered. */
export function standingArrivalText(decision: StandingDecision): string {
  return (
    `Answered from ${decision.fromTaskKey}: ${decision.byLabel} chose "${decision.optionTitle}" there ` +
    `at ${decision.decidedAt.slice(11, 16)} UTC for this account's usage window, which stays closed ` +
    `until ${decision.until.slice(11, 16)} UTC, and the same choice was applied here.`
  );
}

/** The option a standing decision chose, in the shape `siblingOptionIndex` matches. */
export function standingOption(decision: StandingDecision): PacketOption {
  const option: PacketOption = { kind: decision.optionKind, t: decision.optionTitle, d: "", rec: false };
  if (decision.optionBackend) option.backend = decision.optionBackend;
  return option;
}
