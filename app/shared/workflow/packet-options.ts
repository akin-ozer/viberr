import type { PacketOptionKind } from "~/schemas/task-file.schema";
import { escapeRegExp } from "~/shared/text/regexp";

/**
 * Ruling 164 (pass 35, F35-14) — an option title is a promise the resolution
 * keeps.
 *
 * The operator authors a packet's options; `resolvePacket` dispatches on the
 * option's KIND and never on its English title (ruling 7). Two live decisions
 * proved what happens when the two disagree:
 *
 *  - KNC-3, 2026-09-07 06:06:57Z: a `custom` option titled "Force-accept as
 *    admin without a fresh verdict". The resolution recorded the decision and
 *    re-ran the operator, whose `accept_completion` returned a no-op behind the
 *    verdict gate; the operator then posted a comment asking the owner to press
 *    Force accept by hand.
 *  - KNC-16, 2026-09-06 20:53:26Z: a `redirect` titled "Move KNC-16 back to
 *    Review so the Reviewer can verdict 701b5b3". The task stayed at Merge.
 *
 * Two halves fix it, and both live here so the authoring guard and the
 * resolution read one definition:
 *
 *  1. `force_accept` and `move_stage` are real kinds now, so the promise is
 *     expressible and the resolution performs it.
 *  2. `misdirectedOptionPromise` refuses the authoring of a send-back option
 *     (custom / redirect / request_edit, whose resolution only re-engages the
 *     agent side) whose own words promise a force-accept, a stage move or an
 *     agent-profile edit, and names the kind to use instead.
 *
 * Both functions are pure and shape-only, so the packet writer, the resolver
 * and their tests share them without a server import.
 */

/** The stage facts these helpers read: a project's ordered stage list. */
export interface PacketStage {
  readonly id: string;
  readonly name: string;
}

/** The option kinds whose resolution is the send-back default arm: they record
 *  the decision and hand the task back to the agent side. Nothing they do can
 *  accept, move or reconfigure anything, so their titles are the ones the
 *  authoring guard reads. */
const SEND_BACK_OPTION_KINDS: readonly PacketOptionKind[] = [
  "request_edit",
  "redirect",
  "custom",
];

/** What a send-back option's own words promised. */
export type MisdirectedPromise =
  | { readonly act: "force_accept" }
  | { readonly act: "move_stage"; readonly stage: PacketStage }
  | { readonly act: "agent_profile" };

/** A stage-move promise: a movement verb (or a bare "back to") binding
 *  directly to one of the project's own stage names. The preposition has to sit
 *  immediately before the stage word, which is what keeps "send it back to the
 *  specialist to fix the merge conflict" out of the net.
 *
 *  `send` and `advance` are deliberately NOT here. They are the DELIVERY
 *  idioms, and a redirect is exactly the option that asks an agent to do work
 *  and let the delivery carry it onward: "have the developer send the fix to
 *  review", "advance the work to review after the fix" describe what the agent
 *  and the server do next, not what the resolution does. Reading them as
 *  misdirection refused an operator's ordinary vocabulary and prescribed
 *  `move_stage`, which moves the card and builds nothing. Every phrasing that
 *  really promises the move keeps a verb that is here (move / return /
 *  transition / reopen / promote / demote), or the bare "back to <stage>"
 *  alternative below. */
const MOVE_VERBS =
  "move|moves|moved|moving|return|returns|returned|returning|put|puts|transition|transitions|transitioned|reopen|reopens|promote|promotes|demote|demotes";

/** An agent-profile edit: an edit verb binding to an AGENT's profile. The
 *  qualifier is required so a task about the product's own profile screen is
 *  not read as a request to reconfigure an agent. */
const PROFILE_EDIT =
  /\b(add|adds|grant|grants|give|gives|edit|edits|change|changes|update|updates|set|sets|remove|removes|enable|enables|configure|configures|reconfigure|assign|assigns)\b[^.!?;\n]{0,80}?\b(agent|agents|reviewer|reviewers|specialist|specialists|operator)['’]?s?\s+profiles?\b/i;

const FORCE_ACCEPT = /\bforce[\s-]*accept/i;

function promisesMoveTo(text: string, stage: PacketStage): boolean {
  const target = [stage.name, stage.id]
    .filter((value) => value.trim().length > 1)
    .map(escapeRegExp)
    .join("|");
  if (!target) return false;
  const bound = `(?:back\\s+)?(?:to|into)\\s+(?:the\\s+)?(?:stage\\s+)?(?:${target})\\b`;
  return (
    new RegExp(`\\b(?:${MOVE_VERBS})\\b[^.!?;\\n]{0,80}?\\b${bound}`, "i").test(text) ||
    new RegExp(`\\bback\\s+(?:to|into)\\s+(?:the\\s+)?(?:${target})\\b`, "i").test(text)
  );
}

/**
 * What this option's title and detail promise that its resolution cannot do,
 * or null when the words match the kind. Only the send-back kinds are read:
 * every other kind performs its own act, and `force_accept` / `move_stage`
 * describe themselves.
 */
export function misdirectedOptionPromise(
  option: {
    readonly kind: PacketOptionKind;
    readonly title: string;
    readonly detail?: string;
    /** Ruling 163: a redirect the branch-conflict packet marked `rework` DOES
     *  return the task to the review stage when the resolution lands, so its
     *  own "the task returns to Review" sentence is a promise it keeps. */
    readonly rework?: boolean;
  },
  stages: readonly PacketStage[],
): MisdirectedPromise | null {
  if (!SEND_BACK_OPTION_KINDS.includes(option.kind)) return null;
  const text = `${option.title} ${option.detail ?? ""}`;
  if (FORCE_ACCEPT.test(text)) return { act: "force_accept" };
  const moves = option.kind === "redirect" && option.rework === true;
  const stage = moves ? undefined : stages.find((s) => promisesMoveTo(text, s));
  if (stage) return { act: "move_stage", stage };
  if (PROFILE_EDIT.test(text)) return { act: "agent_profile" };
  return null;
}

/** The refusal the authoring door answers with, naming the kind that keeps the
 *  promise (or, for an agent profile, the surface a person uses: nothing a
 *  human confirms on a packet edits an agent's configuration, ruling 85). */
export function misdirectedPromiseRefusal(
  promise: MisdirectedPromise,
  option: { readonly kind: PacketOptionKind; readonly title: string },
  taskKey: string,
): string {
  const lede =
    `"${option.title}" is a ${option.kind} option, and a ${option.kind} resolution ` +
    `records the decision and hands ${taskKey} back to the agent side. ` +
    "An option title is a promise the resolution keeps, so ";
  switch (promise.act) {
    case "force_accept":
      return (
        lede +
        "it cannot force-accept anything: the operator run it starts meets the same " +
        "verdict gate, and the person is told to press the button by hand. " +
        "Use kind 'force_accept', whose confirm runs the admin override itself, on the " +
        "same disclosure and the same audited bypass record as the task page's Force " +
        "accept button. Only an admin may resolve it."
      );
    case "move_stage":
      return (
        lede +
        `it cannot move ${taskKey} to ${promise.stage.name}. ` +
        `Use kind 'move_stage' with toStage: '${promise.stage.id}', whose confirm performs ` +
        "the move on the stage picker's own path and writes the transition. " +
        "A maintainer or admin may resolve it."
      );
    case "agent_profile":
      return (
        lede +
        "it cannot edit an agent profile, and no option kind can: an agent's stages, " +
        "grants and model are configuration a person changes on the project's Agents " +
        "surface. State the gap as an observation and name that remedy (ruling 85), " +
        "then offer the options that act on this task."
      );
  }
}

/** Where a `move_stage` option moves the task, or the refusal that says why it
 *  cannot. Read by the authoring guard (before the option is written) and by
 *  the resolution (before the packet clears), so one sentence covers both. */
export type MoveStageTarget =
  | { readonly ok: true; readonly stage: PacketStage }
  | { readonly ok: false; readonly refusal: string };

export function moveStageTarget(
  option: { readonly toStage?: string },
  stages: readonly PacketStage[],
  taskKey: string,
): MoveStageTarget {
  const toStage = (option.toStage ?? "").trim();
  if (!toStage) {
    return {
      ok: false,
      refusal:
        `A move_stage option has to name the stage it moves ${taskKey} to. ` +
        `Set toStage to one of: ${stages.map((s) => s.id).join(", ")}.`,
    };
  }
  const stage = stages.find((s) => s.id === toStage);
  if (!stage) {
    return {
      ok: false,
      refusal:
        `"${toStage}" is not a stage of this project, so there is nothing to move ` +
        `${taskKey} to. The stages are: ${stages.map((s) => s.id).join(", ")}.`,
    };
  }
  // The terminal stage is the acceptance, not a board move: a person moving a
  // task there accepts the completion (and merges the pull request), which is
  // its own ceremony and its own two kinds. A move_stage option that named it
  // would promise a quiet reshuffle and perform an irreversible merge.
  const terminal = stages[stages.length - 1];
  if (terminal && stage.id === terminal.id) {
    return {
      ok: false,
      refusal:
        `Moving a task to ${stage.name} accepts its completion and merges the pull request, ` +
        "so it is not a stage move. Offer accept_completion at the acceptance boundary, or " +
        "force_accept for the admin override.",
    };
  }
  return { ok: true, stage };
}

/**
 * Ruling 164, the half `misdirectedOptionPromise` cannot cover: a `move_stage`
 * option does NOT describe itself. It carries a free-text title AND a separate
 * `toStage`, the card renders only the words, and the resolution reads only the
 * id — so "Move VIB-1 back to Review so the reviewer can verdict" with
 * `toStage: 'triage'` is authored, read and confirmed with the mismatch
 * invisible, and the task lands at Triage. Returns the refusal when the
 * option's own words name a stage of this project other than the one it moves
 * to, or null when they name that stage or none at all.
 */
export function moveStagePromiseMismatch(
  option: { readonly title: string; readonly detail?: string },
  target: PacketStage,
  stages: readonly PacketStage[],
  taskKey: string,
): string | null {
  const text = `${option.title} ${option.detail ?? ""}`;
  // The words name the target: the promise is kept, whatever else they say.
  if (promisesMoveTo(text, target)) return null;
  const named = stages.find((s) => s.id !== target.id && promisesMoveTo(text, s));
  if (!named) return null;
  return (
    `"${option.title}" says ${named.name}, but toStage is '${target.id}', so confirming it ` +
    `would move ${taskKey} to ${target.name}. An option title is a promise the resolution ` +
    `keeps: set toStage to '${named.id}', or write the words for the stage you mean.`
  );
}
