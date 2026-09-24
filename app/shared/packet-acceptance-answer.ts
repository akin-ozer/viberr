import type { PacketOption, PacketOptionKind } from "~/schemas/task-file.schema";

/**
 * Ruling 471: which option of the open decision a DIRECT human acceptance
 * answers, or null when it answers none. Client-safe, because the server's
 * write and the loader's view of the accept dialog both read it.
 *
 * Live on WEB-1 the operator asked "ready to accept?" and recommended
 * `accept_completion`, the owner pressed the task page's Accept, and the record
 * said the decision was "never answered" (F32-11's withdrawal). The packet door
 * resolving that same option recorded an answer. Two identical buttons, two
 * records. So an acceptance answers the decision whenever the decision offers
 * the option the acceptance performs:
 *
 * - a plain acceptance (the Accept button, a stage move into the terminal
 *   stage, an applied acceptance card) performs `accept_completion`;
 * - a forced acceptance performs `force_accept`, and when the decision offers
 *   no `force_accept` it performs `accept_completion`: the person accepted the
 *   completion, which is the answer that option gives, and the override is on
 *   the record as its own row (`task.acceptance.forced`).
 *
 * A plain acceptance never answers a `force_accept` option: that option
 * promises an override, and a plain acceptance overrode nothing.
 *
 * Among several options of the kind, the recommended one wins, then the first.
 * A decision already decided (`awaiting`, an `edit_goal` waiting for its goal)
 * takes no second answer, the same refusal the packet door makes, so it is
 * withdrawn as before.
 */
export type AcceptanceDoor = "accept" | "force";

export interface AcceptanceAnswer {
  /** The option's index in the packet's `options`. */
  index: number;
  option: PacketOption;
}

const KINDS_BY_DOOR = {
  accept: ["accept_completion"],
  force: ["force_accept", "accept_completion"],
} as const satisfies Record<AcceptanceDoor, readonly PacketOptionKind[]>;

export function acceptanceAnswerOf(
  packet: { options: readonly PacketOption[]; awaiting?: string | undefined } | null,
  door: AcceptanceDoor,
): AcceptanceAnswer | null {
  if (!packet || packet.awaiting) return null;
  for (const kind of KINDS_BY_DOOR[door]) {
    let first: AcceptanceAnswer | null = null;
    for (const [index, option] of packet.options.entries()) {
      if (option.kind !== kind) continue;
      if (option.rec) return { index, option };
      first ??= { index, option };
    }
    if (first) return first;
  }
  return null;
}
