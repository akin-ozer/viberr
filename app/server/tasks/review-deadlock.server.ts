/**
 * Ruling 94 (pass 37, F37-57): a reviewer that objects twice in a row is a
 * decision for a person, and viberr raises it itself.
 *
 * Ruling 201 already held that a second consecutive `request_changes` from the
 * same reviewer is the point where another rework stops being the move, and
 * wrote that as a paragraph in the operator's turn instruction ending "Do not
 * send the deliverer back into another round until the reviewer has answered."
 * Ruling 92 gave that paragraph a counter it could read. Live on SHOP-5 the
 * whole apparatus worked and changed nothing: three `request_changes` verdicts
 * from one reviewer, `consecutiveRequestChanges` reading 3, and the operator
 * moving Review to Build forty six seconds after the third verdict and
 * re-dispatching the deliverer sixteen seconds after that, with no question put
 * to the reviewer on any round. SHOP-6 took seven rounds and SHOP-10 five.
 *
 * The same construction ruling 56 refused: a request in a prompt, with nothing
 * that notices when the model does something else.
 *
 * The owner's call on the remedy was ESCALATE, not gate. The operator keeps
 * every move it had, and nothing here inspects or refuses its dispatches: a
 * fresh class of finding on round three is sometimes exactly right, and a gate
 * would block that. What changes is that the second objection now reaches a
 * person by itself, and the completion that raises it does NOT then hand the
 * task to the operator.
 *
 * That last clause is load-bearing and was nearly missed. Ruling 115 records
 * that "a packet opened mid-work does NOT stop the machine triggers", and the
 * react at the end of an agent completion is one (`agent-reply`). Live on
 * SHOP-24 the packet's audit row landed at 13:52:53.488Z and an operator run
 * started at 13:52:53.585Z — 97 milliseconds later — on a card telling a person
 * the task was waiting for them. The card's copy states what HAPPENED rather
 * than promising a future: the other machine triggers keep ruling 115's
 * carve-out, and a packet is not a lock.
 *
 * Written by the POLICY ENGINE, not through `operatorOpenPacket`, and for
 * ruling 243's reason: that door checks the operator's own `generate-packets`
 * grant, and this packet is not the operator's judgement — it is a condition a
 * counter noticed. A project that has told its operator to stop opening packets
 * has said nothing about whether a person should hear that their reviewer has
 * blocked the same work twice. The packet's `from` says `policy-engine` so the
 * card never attributes it to a model that did not author it.
 *
 * The threshold is per reviewer and resets on that reviewer's own approve,
 * which is what `consecutiveRequestChanges` already computes: it filters the
 * verdict list to one `profileId`, so another reviewer's objections never count
 * toward this one's total and never keep it alive.
 */
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import {
  deliveringEngagement,
  type TaskFrontmatter,
  type TaskPacket,
} from "~/schemas/task-file.schema";

/**
 * Consecutive `request_changes` rounds from ONE reviewer that raise the packet.
 *
 * THREE, on the owner's call of 2026-09-22 (ruling 93). It was two, on the
 * owner's earlier call, and that was right about where a rework stops being
 * the obvious move -- but wrong about whose move it is. Measured on ax-clone:
 * the "ask the reviewer for its complete blocking set instead of reworking
 * again" call was made five times in one afternoon (AX-4, AX-19, AX-20, AX-18,
 * AX-22) and every one of them was made by the OWNER, because Viberr raised
 * the packet on the second verdict and the operator's turn found `waiting:
 * human` with the decision already taken out of its hands. Its own response to
 * a second request-changes, every time, was the same mechanical loop: move
 * Review to Verify, post a rework directive, start the deliverer.
 *
 * So round two is now the OPERATOR's: it puts the completeness question to the
 * reviewer itself, one run with no rework behind it. Viberr escalates to a
 * person at three, which means the loop survived that question -- which is the
 * decision a person should actually be given, instead of the one the operator
 * could have taken.
 */
const REVIEW_DEADLOCK_ROUNDS = 3;

/**
 * The question the `question_reviewer` resolution puts to the reviewer.
 *
 * Ruling 201 wrote it as a phrase inside the operator's turn instruction
 * ("name everything you would still block on across your owned surface, now").
 * It lives here now because a person choosing the option is promised exactly
 * this, and a prompt a model composes fresh each time is a promise nobody can
 * check. It asks for no rework and no new verdict: a verdict here would bind to
 * the same revision and count as another objection, which is the loop.
 */
export const REVIEW_DEADLOCK_QUESTION =
  "A person stopped this task to put one question to you, because you have requested changes " +
  "more than once in a row on it. Do NOT review again and do NOT return a verdict: nothing has " +
  "changed since your last one. Answer in a comment instead. Read the revision as it stands and " +
  "name EVERYTHING you would still block on across the surface you own, as one complete list, so " +
  "the next rework can clear all of it at once. If some of it is not something this deliverable " +
  "can give you (a tool that is not installed on this runner, a service or baseline the " +
  "repository does not have yet, a decision nobody has made), say so plainly and say which: that " +
  "is a fact about the environment, and the person deciding needs it separated from the rest. " +
  "Tag the deliverer and @operator so your answer reaches them.";

/** Longest verdict reason quoted onto the packet. The full text is on the
 *  timeline; the packet carries enough to decide without leaving the card. */
const REASON_MAX = 400;

function clipReason(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length <= REASON_MAX ? t : `${t.slice(0, REASON_MAX - 1).trimEnd()}…`;
}

/** "2nd", "3rd", "4th" — the round this objection is, for the packet title. */
function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : n % 10 === 1
        ? "st"
        : n % 10 === 2
          ? "nd"
          : n % 10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
}

export interface ReviewDeadlock {
  /** The reviewer that keeps objecting. */
  profileId: string;
  /** Its consecutive `request_changes` rounds, ruling 92's count. */
  rounds: number;
  /** The latest objection's own reason text, as the verdict stored it. */
  latestReason: string;
  /**
   * Ruling 92: the revision, newest first within this streak, on which the
   * reviewer read unchanged work again and still objected (more `reviews` than
   * `rounds`): its verdict-shaped answer to the completeness question. Null
   * when no such answer is on record. Live on ax-clone AX-24 the operator put
   * the question at round two, the reviewer answered on `78e764c`, one rework
   * followed, and the round-three packet recommended asking again.
   */
  answeredOn: string | null;
  /** How the answer on `answeredOn` was given: the reviewer re-read unchanged
   *  work (`reread`, ruling 92), or the run that returned it put the
   *  question (`asked`, ruling 93). Null with no answer on record. */
  answeredHow: "reread" | "asked" | null;
}

/**
 * Read the deadlock out of a task's own verdicts, or null when there is none.
 *
 * Pure, and takes the count as an argument rather than importing the counter,
 * so the caller can hand it the value it already computed inside its lock.
 */
export function reviewDeadlockOf(
  fm: Pick<TaskFrontmatter, "verdicts">,
  profileId: string,
  rounds: number,
): ReviewDeadlock | null {
  if (rounds < REVIEW_DEADLOCK_ROUNDS) return null;
  const mine = fm.verdicts.filter((v) => v.profileId === profileId);
  const latest = mine[mine.length - 1];
  if (!latest || latest.result !== "request_changes") return null;
  let answeredOn: string | null = null;
  let answeredHow: ReviewDeadlock["answeredHow"] = null;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const v = mine[i]!;
    if (v.result !== "request_changes") break;
    const asked = v.answers === "completeness";
    if (asked || (v.reviews ?? v.rounds) > v.rounds) {
      answeredOn = v.headSha ? v.headSha.slice(0, 7) : v.revisionId;
      answeredHow = asked ? "asked" : "reread";
      break;
    }
  }
  return { profileId, rounds, latestReason: latest.reason, answeredOn, answeredHow };
}

/**
 * The escalation as the verdict writer carries it out of its own lock: the
 * packet that was written, and the deadlock that caused it. A named contract
 * rather than an inline object type, because the writer needs a slot it can
 * assign from inside the mutator and read after it.
 */
export interface ReviewDeadlockEscalation {
  packet: TaskPacket | null;
  deadlock: ReviewDeadlock | null;
}

export interface ReviewDeadlockPacketInput {
  taskKey: string;
  /** A fresh packet id, minted by the caller (`newId("pkt")`). */
  packetId: string;
  deadlock: ReviewDeadlock;
  /** The reviewer's display name, for the handle a person reads. */
  reviewerName: string;
  /** The deliverer's display name, when one is engaged. */
  delivererName: string | null;
  /**
   * Ruling 66: what the task waits on (`blockedBy`), because a hold changes
   * what the recommended option DOES. Ruling 56 refuses every agent dispatch
   * on a held task, so on SHOP-5 the card promised a question it could not put
   * — the option's own description has to say what will really happen.
   */
  heldBy: readonly string[];
  /**
   * Ruling 92 (F39-42): the objection has NO rework behind it. The reviewer
   * read the same revision again with no delivered round in between, so this
   * verdict is its answer on work that has not moved: exactly what round two's
   * completeness question asks for. Live on ax-clone AX-19 the operator put
   * that question, the reviewer answered with three concrete blockers on the
   * untouched revision, and the packet recommended asking it again. Absent in
   * callers that predate it, which reads as false.
   */
  noReworkBehind?: boolean;
  /** The short sha the objection was made on, for the sentence that names it. */
  revisionLabel?: string | null;
  /**
   * Ruling 93 (F39-43): the run that returned THIS objection put ruling 93's
   * completeness question, so the list in it is the reviewer's complete set.
   * Live on ax-clone AX-20, AX-22 and AX-24 the operator folded the question
   * into the review of a fresh rework three times in 25 minutes, and each
   * packet recommended asking it again. Absent reads as false.
   */
  askedWithThisReview?: boolean;
}

/**
 * The packet's title, which raising it also writes onto the timeline. It names
 * the reviewer and the count, and the retry reads it back to tell an
 * escalation already made from one still owed (ruling 94).
 */
export function reviewDeadlockTitle(reviewerName: string, rounds: number): string {
  return `${reviewerName} has requested changes ${rounds} times running`;
}

/**
 * Build the packet. Pure, so the caller can write it inside the SAME locked
 * write that records the verdict: the objection and the escalation it triggers
 * land together or not at all, and no second lock can fail between them.
 */
export function buildReviewDeadlockPacket(input: ReviewDeadlockPacketInput): TaskPacket {
  const handle = `@${input.reviewerName}`;
  const held = input.heldBy.length > 0 ? input.heldBy.join(", ") : "";
  // Two ways the objection itself is the answer: the reviewer re-read work
  // that had not moved (ruling 92), or the run that returned it put the
  // question (ruling 93).
  const rereadNow = input.noReworkBehind === true;
  const askedNow = !rereadNow && input.askedWithThisReview === true;
  const answered = rereadNow || askedNow;
  const answeredEarlier = !answered && input.deadlock.answeredOn !== null;
  const questionSpent = answered || answeredEarlier;
  const revision = input.revisionLabel ? `\`${input.revisionLabel}\`` : "the same revision";
  const observations: TaskPacket["observations"] = [
    { k: "Reviewer", v: handle, code: false },
    {
      k: "Rounds",
      v: `${input.deadlock.rounds} consecutive request-changes verdicts, no approve between them`,
      code: false,
    },
  ];
  if (input.delivererName) {
    observations.push({ k: "Deliverer", v: `@${input.delivererName}`, code: false });
  }
  const reason = input.deadlock.latestReason.trim();
  if (reason) {
    observations.push({ k: "Latest objection", v: clipReason(reason), code: false });
  }
  return {
    id: input.packetId,
    // `input`, not `blocked`: nothing failed. A person is being asked to
    // decide, and `blocked` sets `readiness: "blocked"` over a task whose
    // review is working exactly as designed and disagreeing.
    type: "input",
    kind: "Decision required",
    from: "policy-engine",
    title: reviewDeadlockTitle(input.reviewerName, input.deadlock.rounds),
    body:
      `${handle} returned its ${ordinal(input.deadlock.rounds)} consecutive request for changes on ` +
      `${input.taskKey}, with no approve in between` +
      (input.delivererName ? `, and @${input.delivererName} has reworked against each one` : "") +
      ". " +
      "Three rounds is past where another rework stops being the obvious move: either the " +
      "reviewer is paying out its findings one at a time, or it is asking for something this " +
      "deliverable cannot give it. Nothing was dispatched on this objection: the task is on " +
      "you.\n\n" +
      // Ruling 93: the operator owns round two, so this packet means one of
      // two things and the timeline says which. Stated rather than implied,
      // because the option below is the same one the operator was told to use
      // and a person should know whether it has already been spent.
      (rereadNow
        ? // Ruling 92: Viberr knows which, so it says which.
          `This objection has no rework behind it: ${handle} read ${revision} again with nothing ` +
          "delivered since its last verdict, so what it returned is its answer on work that has " +
          "not moved. That is what the completeness question asks for, and asking again would get " +
          "the same list. The move it leaves is one rework against exactly this verdict.\n\n"
        : askedNow
          ? // Ruling 93: the question was put with this very review.
            `This objection is ${handle}'s answer to the completeness question: the run that returned ` +
            `it was asked for everything ${handle} would still block on, on ${revision}, and this is ` +
            "the list. Asking again would get the same list. The move it leaves is one rework against " +
            "exactly this verdict.\n\n"
          : answeredEarlier
            ? // Ruling 92 and 93: the same fact, one step removed.
              `The completeness question has been answered in this streak: ${handle} ` +
              (input.deadlock.answeredHow === "asked"
                ? `was asked for everything it would block on with its review of \`${input.deadlock.answeredOn}\` and returned the list, `
                : `read \`${input.deadlock.answeredOn}\` again with nothing reworked behind it and returned the list it would block on, `) +
              "and this objection has outlived that answer and the rework against it. " +
              "Asking again would repeat it. What is left is whether this objection is real work the " +
              "deliverable owes, or one it cannot give.\n\n"
          : "Round two was the operator's: it was told to put the completeness question to this " +
            "reviewer itself, one run with no rework behind it. So either it did and the objection " +
            "outlived the answer, or it did not and this is the first time the question has been " +
            "asked. The reviewer's own verdicts on the timeline say which.\n\n") +
      // Ruling 64: this ask lives in the BODY, which is read on the card and
      // nowhere else. It used to sit on an option's `d`, which `resolvePacket`
      // appends to the GOAL verbatim — so a sentence about a textarea became
      // permanent contract, addressed to agents who have no textarea.
      "Whichever you pick, say why in the note box: it reaches the operator with your decision " +
      "and stays on this task's timeline. A reason here is worth more than the choice itself, " +
      "because the next round is judged against it.\n\n" +
      "If this reviewer can never pass the work at all, the door is on THIS task, not in project " +
      "settings: `validation` is derived from the verdict-capable ENGAGEMENTS the task carries " +
      "(`deriveValidation`), so dropping the project's required-reviewer rule would leave this " +
      "task exactly as blocked. Remove the engagement here, or force-accept.",
    observations,
    options: [
      {
        kind: "question_reviewer",
        t: `Ask ${input.reviewerName} what else it would block on`,
        d:
          `${held ? "Queues" : "Starts"} ${input.reviewerName} with one question and no rework ` +
          "behind it: name everything you would still block on across your own surface, on the " +
          "revision as it stands. " +
          // Ruling 92: never recommended on top of the answer it would ask for.
          (rereadNow
            ? `It has just read ${revision} again, unchanged, and answered; asking again repeats that.`
            : askedNow
              ? `It was asked this with its review of ${revision} and answered; asking again repeats that.`
              : answeredEarlier
              ? `It answered this on \`${input.deadlock.answeredOn}\` in this streak; asking again repeats that.`
              : "A verdict is supposed to be the complete set, so the answer either ends the loop or " +
                "shows it cannot be ended by reworking.") +
          // Ruling 66: said BEFORE the choice, not discovered after it.
          (held
            ? ` ${input.taskKey} waits on ${held}, and Viberr refuses every agent run while it ` +
              "does, so the question is held with the task and put the moment the wait clears."
            : ""),
        rec: !questionSpent,
        profileId: input.deadlock.profileId,
      },
      {
        kind: "custom",
        t: answered ? "Rework once against this verdict" : "Let the rework continue",
        /**
         * Ruling 64: an option's `d` BECOMES the contract.
         *
         * `resolvePacket` appends `${option.t}: ${option.d}` to the task's
         * goal, so every word here is permanent text that every later run
         * reads. This one ended with "Anything you type below is recorded on
         * the task's contract and every later run reads it (ruling 64), so say
         * why rather than just yes" — and that is the sentence that landed in
         * the goal, five times across three tasks, twice on SHOP-76.
         *
         * It was false in both directions at once. The note box under a listed
         * option posts `note`, which `resolvePacket` sends to the timeline and
         * to the operator's summon note and never to the goal — it has never
         * amended the contract, before ruling 64 or after it; 284 only closed
         * the last route by which any typed words reached a goal. So the card
         * asked a person for their reasoning on the highest-stakes decision it
         * raises, promised that reasoning would bind, filed the reasoning in
         * the timeline, and wrote its own UI instruction into the contract
         * instead — complete with a bare "(ruling 64)" citation and an
         * instruction to type in a box no agent reading the goal will ever see.
         *
         * Whether a person's typed reasoning SHOULD bind the goal is ruling
         * 64's question and stays answered as 284 answered it. What this fixes
         * is a promise the product never kept and a decision record that
         * describes a dialog.
         */
        d: rereadNow
          ? `Rework once against ${handle}'s latest verdict: it read ${revision} again with ` +
            "nothing delivered in between, so that verdict is its complete set, and the next " +
            "review is judged against it. Hands the task back to the operator to carry on."
          : askedNow
            ? `Rework once against ${handle}'s latest verdict: it was asked for everything it would ` +
              "block on and this is its list, so the next review is judged against it. Hands the " +
              "task back to the operator to carry on."
            : "Each round has found something real and the work is converging on it. Hands the task " +
            "back to the operator to carry on.",
        rec: questionSpent,
      },
      {
        kind: "force_accept",
        t: `Accept the work past ${input.reviewerName}`,
        d:
          "Completes the task without a passing verdict from this reviewer, recorded as the " +
          "bypass it is. Admin only: `force-accept-completion` is the one action in the RBAC " +
          "table granted to admins alone, so a maintainer reading this is looking at a door " +
          "that will refuse them.",
        rec: false,
      },
    ],
  };
}

/**
 * Every deployed profile's display NAME, keyed by profile id.
 *
 * The project file, not `agentNamesByProfile` (which reads `agent_runs`): a
 * name that only exists once an agent has run is absent exactly when a reviewer
 * objects on a project whose run rows were pruned, and the card would then
 * write the ROLE as a handle. "@Review & validation" names nobody.
 */
export function agentNamesOf(project: Pick<ProjectFrontmatter, "agents">): Map<string, string> {
  const named: [string, string][] = [];
  // `definition` is optional on the stored shape: a profile row can outlive the
  // definition it pointed at. Such a row contributes no name rather than an
  // empty handle.
  for (const a of project.agents) {
    if (a.definition?.name) named.push([a.profileId, a.definition.name]);
  }
  return new Map(named);
}

/** The deliverer's display name for a task, or null when nobody is delivering. */
export function delivererNameOf(
  fm: Pick<TaskFrontmatter, "engagements">,
  names: ReadonlyMap<string, string>,
): string | null {
  const delivering = deliveringEngagement(fm);
  if (!delivering) return null;
  return names.get(delivering.profileId) ?? null;
}
