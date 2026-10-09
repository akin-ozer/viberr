import { describe, expect, it } from "vitest";
import { buildReviewDeadlockPacket } from "./review-deadlock.server";

/**
 * Ruling 64 — an option's description BECOMES the contract, so it may only
 * contain what binds.
 *
 * `resolvePacket` appends `${option.t}: ${option.d}` to the task's goal for
 * every option kind outside `PROCESS_ONLY_OPTION_KINDS` (and not ending the
 * task). The deadlock card's "Let the rework continue" is one of the very few
 * SERVER-AUTHORED options on that side of the line, and its description ended
 * with "Anything you type below is recorded on the task's contract and every
 * later run reads it (ruling 64), so say why rather than just yes."
 *
 * That sentence is what landed in the goal — five times, across SHOP-5,
 * SHOP-25 and SHOP-76 (twice) — while the reasoning the person actually typed
 * went to the timeline. It was false in both directions: the note box under a
 * listed option posts `note`, which has never amended a goal, before ruling 64
 * or after it. So the card asked for reasoning on the highest-stakes decision it
 * raises, promised the reasoning would bind, filed it elsewhere, and wrote its
 * own dialog instruction into the permanent record instead — telling every
 * later run to type in a textarea it will never see.
 */
describe("ruling 64: what a deadlock option writes into the goal", () => {
  const packet = buildReviewDeadlockPacket({
    taskKey: "VIB-1",
    packetId: "pkt_1",
    deadlock: {
      profileId: "reviewer",
      rounds: 2,
      latestReason: "Still three files.",
      answeredOn: null,
      answeredHow: null,
    },
    reviewerName: "Code Reviewer",
    delivererName: "Developer",
    heldBy: [],
  });

  it("holds every goal-amending option to contract language, not dialog language", async () => {
    const { PROCESS_ONLY_OPTION_KINDS } = await import("./packet-resolution.server");
    // The kinds that END the task never amend either (`acceptsInto`, force_accept).
    const amends = packet.options.filter(
      (o) => !PROCESS_ONLY_OPTION_KINDS.has(o.kind) && o.kind !== "force_accept",
    );
    // If this is empty the test proves nothing — the card's shape changed and
    // the guard has to be re-aimed rather than quietly passing.
    expect(amends.length, "no option on this card amends the goal any more").toBeGreaterThan(0);
    for (const o of amends) {
      const contract = `${o.t} — ${o.d}`;
      // CANARY: put the "Anything you type below…" sentence back on the option.
      expect(contract, `"${o.t}" writes dialog copy into the goal`).not.toMatch(
        /\b(type|typed) below\b|\bthe (note )?box below\b|\bbelow this\b|\bclick\b|\bthis card\b|recorded on the task's contract/i,
      );
      // A bare ruling citation is for the source, not for a permanent record a
      // person and four agents will re-read.
      expect(contract, `"${o.t}" cites a ruling number at the reader`).not.toMatch(
        /\(ruling \d+\)/i,
      );
    }
  });
});
