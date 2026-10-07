import type { PacketOptionKind } from "~/schemas/task-file.schema";
import { isRepositoryOptionKind } from "~/shared/repository-ask";
import type { PacketRender } from "~/shared/mapping/task.server";
import type { IconName } from "~/ui/icon";
import type { PacketArchiveDisclosure } from "./decision-packet";

/**
 * What the decision packet card reads off its packet, its viewer's authority
 * and the person's choice before it draws (ruling 689(e), the split of
 * `decision-packet.tsx` along the task-page recipe): the authority gate table,
 * the choice the card opens on, the refusals a Confirm can meet, who may
 * answer at all, and the words of the archive ceremony. Pure functions of the
 * packet, the viewer's grants and the person's choice, no React; the card, its
 * choice hook (decision-packet-actions.ts) and its regions call them.
 */

type PacketOption = PacketRender["options"][number];

/**
 * P13: the operator authors observation KEYS itself, and it writes machine-ish
 * ones (`prompt_agent error`, `open packet`). The row uppercases them, so a
 * live packet rendered "PROMPT_AGENT ERROR" at a human. Underscores become
 * spaces; the CSS still does the uppercasing.
 *
 * C7: two further shapes leaked into the field labels — a camelCase-derived key
 * printed as one screaming token ("NOCHANGES FLAG"), and a file PATH used as a
 * label ("ORIGIN/MAIN TEST-ARTIFACTS/…"). Split camelCase into words so the
 * uppercase render stays readable, cap an over-long key, and reject a
 * path-shaped key outright — a path is not a field name, so it renders a
 * neutral label rather than masquerading as one.
 */
export function observationLabel(key: string): string {
  const raw = key.trim();
  // Ruling 470: a path-shaped key (`origin/main`, `CI/CD`, `src/pages`) is the
  // agent's own label and is shown as written, only capped. It used to be
  // replaced with "detail" on the theory that it was a mis-slotted value, and a
  // live packet lost the one word saying what its row was about.
  if (/[\\/]/.test(raw)) return capLabel(raw);
  const words = raw
    .replace(/_/g, " ")
    // camelCase / PascalCase word boundary: a lower/digit followed by an upper.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return capLabel(words);
}

/** An observation key is capped so it cannot blow out its row. */
function capLabel(label: string): string {
  return label.length > 40 ? label.slice(0, 39).trimEnd() + "…" : label;
}

/**
 * LV-09: packet observations are written by the operator, which serializes an
 * absent value as the literal string "null" — a blocked packet printed
 * `OWNER null` at the human it was asking for a decision. Render the empty
 * cases as English; anything else passes through verbatim.
 */
export function observationValue(key: string, value: string): string {
  const empty =
    value.trim() === "" ||
    value.trim().toLowerCase() === "null" ||
    value.trim().toLowerCase() === "undefined" ||
    value.trim().toLowerCase() === "none";
  if (!empty) return value;
  return /owner|assignee/i.test(key) ? "unassigned" : "none";
}

/** The card's authority flags, as the gate table reads them. */
export interface PacketTierGrants {
  canResolveCompletion: boolean;
  canEditGoal: boolean;
  canArchive: boolean;
  canDiscardBranch: boolean;
  /** Ruling 164: `force-accept-completion` is admin-only, the tier the task
   *  page's own Force accept button holds. */
  canForceAccept: boolean;
  /** Ruling 164: `approve-transition`, the tier the stage picker holds. */
  canMoveStage: boolean;
  /** Ruling 672: `edit-policy`, the tier the project's repository setting
   *  holds. Both answers to the repository question decide the board. */
  canEditPolicy: boolean;
}

/** One gated option kind: the grant it needs and how a refusal is stated. */
export interface PacketTierGate {
  /** The grant this kind needs, which `resolvePacket` re-checks server-side. */
  held: (grants: PacketTierGrants) => boolean;
  /** Card-level refusal beside Confirm, when this kind is the SELECTED option. */
  denyNote: string;
  /**
   * Per-option treatment: the option itself goes inert, carries this hover
   * title, and appends this clause to its description.
   *
   * `accept_completion` has none on purpose. A packet addressed to someone
   * else's task keeps that option selectable and blocks the Confirm button
   * instead of 403ing on click (adversarial-review #15).
   *
   * The repository question's two kinds have neither a title nor a note
   * (ruling 673): they stand together, on a card whose one note under the
   * options says who answers, and each inert option is described by that
   * note. Their `denyNote` is printed only on a packet that is not that
   * card, which no writer in the app makes.
   */
  option: { title?: string; note?: string } | null;
}

/**
 * V16 — the authority tier each packet-option kind re-checks, in ONE table.
 *
 * Five kinds are gated, and each gate used to be threaded as its own
 * `o.kind === "…"` chain through six sites in the card below: the selected
 * option's refusal, the refusal SENTENCE, the every-option-above-tier scan, the
 * per-option inert flag, its hover title and its description suffix. Six chains
 * is five chances to add a kind to only five of them, and that is exactly what
 * happened: `resolve_remote_collision` shipped inert and hover-titled with NO
 * description clause, so the one reason a keyboard or touch user can actually
 * reach (a `title` needs a pointer) said nothing at all. One row per kind,
 * consulted from every site, is what keeps them together.
 */
const PACKET_TIER_GATES = new Map<PacketOptionKind, PacketTierGate>([
  [
    "accept_completion",
    {
      held: (grants) => grants.canResolveCompletion,
      // N20-8: one phrasing for the same [A,M] tier. The sibling notes read
      // "reserved for maintainers" and "reserved for maintainers and admins",
      // and the first misread as excluding admins.
      denyNote:
        "Accepting completion is reserved for maintainers and this task's owner.",
      option: null,
    },
  ],
  [
    "edit_goal",
    {
      held: (grants) => grants.canEditGoal,
      denyNote: "Editing the goal is reserved for maintainers and admins.",
      option: {
        title:
          "Editing the goal is reserved for maintainers and admins. Ask one to refine it",
        note: " · your role can't edit the goal (a maintainer or admin must)",
      },
    },
  ],
  [
    "archive_task",
    {
      held: (grants) => grants.canArchive,
      denyNote: "Archiving is reserved for maintainers and admins.",
      option: {
        title: "Archiving is reserved for maintainers and admins",
        note: " · your role can't archive (a maintainer or admin must)",
      },
    },
  ],
  [
    "discard_branch",
    {
      held: (grants) => grants.canDiscardBranch,
      denyNote: "Discarding the branch is reserved for maintainers and admins.",
      option: {
        title: "Discarding the branch is reserved for maintainers and admins",
        note: " · your role can't discard the branch (a maintainer or admin must)",
      },
    },
  ],
  [
    "force_accept",
    {
      // Ruling 164 (pass 35, F35-14): the resolution runs the admin override
      // itself, so the option carries the Force accept button's own tier.
      held: (grants) => grants.canForceAccept,
      denyNote: "Force-accepting past the review gate is reserved for admins.",
      option: {
        title: "Force-accepting past the review gate is reserved for admins",
        note: " · your role can't force-accept (an admin must)",
      },
    },
  ],
  [
    "move_stage",
    {
      // Ruling 164: the move runs on the stage picker's path, which takes the
      // same `approve-transition` tier the picker itself takes.
      held: (grants) => grants.canMoveStage,
      denyNote: "Moving the task to another stage is reserved for maintainers and admins.",
      option: {
        title: "Moving the task to another stage is reserved for maintainers and admins",
        note: " · your role can't move the task (a maintainer or admin must)",
      },
    },
  ],
  [
    "resolve_remote_collision",
    {
      // F31-6: deleting a remote ref takes the same `approve-transition` tier
      // the archive-with-branch-deletion and the local discard take.
      held: (grants) => grants.canDiscardBranch,
      denyNote:
        "Clearing a branch collision is reserved for maintainers and admins.",
      option: {
        title:
          "Clearing a branch collision is reserved for maintainers and admins",
        note: " · your role can't clear the collision (a maintainer or admin must)",
      },
    },
  ],
  [
    "connect_repository",
    {
      // Ruling 672: the resolution attaches the repository through the
      // settings door, so the option carries that door's tier.
      held: (grants) => grants.canEditPolicy,
      denyNote: "Connecting a repository to the board is reserved for project admins.",
      option: {},
    },
  ],
  [
    "keep_without_repository",
    {
      // Ruling 672: it writes a standing ruling for the whole board.
      held: (grants) => grants.canEditPolicy,
      denyNote: "Deciding that the board keeps no repository is reserved for project admins.",
      option: {},
    },
  ],
]);

/**
 * The one place the card reads its own authority flags. Every refusal — the
 * selected option's, each row's, and the every-option scan — comes back
 * through here, so a kind cannot be gated on one surface and open on another
 * (V16). The gate a kind TRIPS, or null when this viewer holds its tier (or it
 * has no tier at all: `custom`, `request_edit`, the rest).
 */
export function gateFor(kind: PacketOptionKind, grants: PacketTierGrants): PacketTierGate | null {
  const gate = PACKET_TIER_GATES.get(kind);
  return gate && !gate.held(grants) ? gate : null;
}

/**
 * The option kinds whose ask-first ceremony interposes before the resolve is
 * dispatched (rulings 20/53: a one-way write states what it destroys and offers
 * a way out). `archive_task` with `deleteBranch` performs the product's ONLY
 * remote-branch deletion (ruling 17), `discard_branch` destroys local commits,
 * and `resolve_remote_collision` deletes a remote ref and closes a PR.
 */
export const CONFIRM_FIRST_KINDS: ReadonlySet<PacketOptionKind> = new Set([
  "archive_task",
  "discard_branch",
  "resolve_remote_collision",
]);

/**
 * Ruling 478(e) (F40-31, F40-57): the choice a card opens on. With no authored
 * option, the composed directive (index 0) is the one choice there is, and it
 * asks for the words itself. Nothing is preselected on an agent's question,
 * whose answer only the person can give (WEB-3's "Connected; the first build
 * succeeded" was one Confirm from telling the agent a build had passed), nor
 * on a packet that recommends nothing. -1 is "no choice yet"; Confirm then
 * refuses in place (ruling 147).
 */
export function initialChoice(p: PacketRender): number {
  if (p.options.length === 0) return 0;
  return p.answerTo ? -1 : p.options.findIndex((o) => o.rec);
}

/** Ruling 672: a `connect_repository` answer's box opens with the repository
 *  the operator could name. */
export function initialRepository(p: PacketRender): string {
  return p.options.find((o) => o.kind === "connect_repository")?.repo ?? "";
}

/**
 * Ruling 625 (B11): a decision that waits on a person is ONE colour, the info
 * blue it wears on Home, Notifications, the board and the queue; the amber
 * stays an agent's question (`answerTo`, ruling 478(e)'s predicate), the coral
 * a block.
 */
export function packetTone(p: PacketRender): "blocked" | "input" | "decision" {
  return p.type === "blocked" ? "blocked" : p.answerTo ? "input" : "decision";
}

/**
 * U36-2 (pass 36): whether the card says how the closed-PR recovery packet's
 * Deliver door behaves (the paragraph in `DecisionPacket`). Keyed on the
 * `archive_task` + `deleteBranch` option because that is the closed-PR
 * signature the schema itself names ("the discard-entirely path for work whose
 * PR a human closed without merging"), the operator only authors it when the
 * task HAS a branch (so there is something to push), and branch deletion is
 * refused while a PR is open (`deleteTaskRemoteBranch`) — so its presence also
 * means no live PR stands in the button's way.
 *
 * The option shape alone was the proxy — an `input` packet on a branchless
 * task rendered the closed-PR recovery paragraph about a Deliver refusal that
 * could not exist. The task's branch is the fact the paragraph describes, and
 * the card already receives it.
 */
export function branchDiscardOffered(
  p: PacketRender,
  archiveDisclosure: PacketArchiveDisclosure | undefined,
): boolean {
  return (
    archiveDisclosure?.branch != null &&
    p.options.some((o) => o.kind === "archive_task" && o.deleteBranch === true)
  );
}

/** Who may answer this card, beyond the selected option's own gate. */
export interface PacketStanding {
  /**
   * F20-17/F20-18: is EVERY option above this viewer's tier? Only meaningful
   * when they can resolve at all (a contributor-OWNER — the owner exception let
   * them open the card, but each option re-checks a higher tier). A single
   * un-gated option (custom / request_edit / …) means they are not stranded.
   */
  everyOptionForbidden: boolean;
  /**
   * Ruling 672: the repository question, whose every answer is a project
   * admin's. A maintainer is stranded on it as a contributor-owner is on a
   * maintainer's, so the note and the way up name the admin.
   */
  boardDecision: boolean;
  /**
   * Ruling 673 (owner, 2026-10-06: "trim the repeated \"project admin\"
   * wording on the card"): that card says who answers ONCE, in the note under
   * the options. Its answers carry no clause and no hover title of their own
   * and the selected one's refusal is not printed beside it; the note takes
   * that line's id, so it describes the refused Confirm and each dimmed
   * option, and a screen reader on one still hears why.
   */
  saidOnce: boolean;
}

export function packetStanding(
  p: PacketRender,
  canResolve: boolean,
  grants: PacketTierGrants,
): PacketStanding {
  const everyOptionForbidden =
    canResolve &&
    p.options.length > 0 &&
    p.options.every((o) => gateFor(o.kind, grants) !== null);
  const boardDecision = p.options.length > 0 && p.options.every((o) => isRepositoryOptionKind(o.kind));
  const saidOnce = boardDecision && (everyOptionForbidden || !canResolve);
  return { everyOptionForbidden, boardDecision, saidOnce };
}

/** What the person has chosen and typed so far (`usePacketChoice`'s state). */
export interface PacketChoiceState {
  sel: number;
  note: string;
  repository: string;
  customText: string;
  refused: number;
}

/** What the card reads off that choice. */
export interface PacketChoiceView {
  customIndex: number;
  customOffered: boolean;
  choiceCount: number;
  customSelected: boolean;
  customInvalid: boolean;
  selected: PacketOption | undefined;
  blockReason: string | null;
  noChoice: boolean;
  needsReply: boolean;
  choiceInvalid: boolean;
  connectsRepository: boolean;
  answer: string;
  replyInvalid: boolean;
  /** Whether the answer box under the options stands (`PacketNoteField`). */
  showsAnswerBox: boolean;
  tabStop: number;
}

export function packetChoiceView(
  p: PacketRender,
  state: PacketChoiceState,
  canResolve: boolean,
  grants: PacketTierGrants,
): PacketChoiceView {
  const { sel, refused } = state;
  // Questionnaire shape (shadcn base/questionnaire): a free-text input composed
  // WITH the fixed choices, as its own last choice. Selecting it reveals the
  // directive input; the note field steps aside (the directive IS the message).
  // Offered only to viewers who can resolve — the choice would otherwise be a
  // control that only exists to 403.
  const customIndex = p.options.length;
  const customOffered = canResolve;
  const choiceCount = p.options.length + (customOffered ? 1 : 0);
  const customSelected = customOffered && sel === customIndex;
  const customInvalid =
    refused > 0 && customSelected && state.customText.trim() === "";
  // E4: the reason the Confirm button can't be pressed. It used to live ONLY in
  // `title` on a `disabled` button — the one place a browser guarantees nobody
  // will ever read it: no hover, no focus, and out of the a11y tree entirely.
  // The option radios in this same card already knew better (`aria-disabled`,
  // whose titles DO reach a pointer). So the button stays reachable via
  // `aria-disabled`, refuses the click itself, and the reason renders as the
  // `.deny-note` the sheet defines for exactly this — visible to a sighted
  // keyboard user and announced via `aria-describedby` to a screen reader.
  const selected = customSelected ? undefined : p.options[sel];
  // accept_completion is maintainer+ OR this task's own owner (R6-2, widened by
  // R14-2); anyone else gets a server 403, so block the button while it's
  // selected rather than let them click into one. UI-42 gave `edit_goal` the
  // same treatment (`update-goal` is admin|maintainer, so resolving it without
  // that grant leaves the packet open with no way to type the new goal), and
  // R14-3 / F20-6 / F31-6 the three that touch a branch.
  const selectedGate = selected ? gateFor(selected.kind, grants) : null;
  const blockReason = selectedGate?.denyNote ?? null;
  // Ruling 478(e): the two refusals a Confirm can meet before any request.
  // Both clear the moment the person does what they name.
  const noChoice = sel < 0;
  const needsReply = selected?.reply === true;
  const choiceInvalid = refused > 0 && noChoice;
  // Ruling 672: which text the box under the options holds, and sends.
  const connectsRepository = selected?.kind === "connect_repository";
  const answer = connectsRepository ? state.repository : state.note;
  const replyInvalid = refused > 0 && needsReply && answer.trim() === "";
  // Hidden while the custom choice is selected: the directive IS the message,
  // and two competing textareas would ask which one counts. Ruling 674 (owner,
  // 2026-10-06: "hide the repository box too"): and hidden under "Connect a
  // repository" for a person who cannot connect one, where it asked for a
  // required value nothing reads.
  const showsAnswerBox = canResolve && !customSelected && (!connectsRepository || !blockReason);
  // Roving tabindex: with nothing chosen yet, the first choice is the group's
  // one tab stop (APG radio group).
  const tabStop = noChoice ? 0 : sel;
  return {
    customIndex,
    customOffered,
    choiceCount,
    customSelected,
    customInvalid,
    selected,
    blockReason,
    noChoice,
    needsReply,
    choiceInvalid,
    connectsRepository,
    answer,
    replyInvalid,
    showsAnswerBox,
    tabStop,
  };
}

/**
 * E4 / ruling 673: whether the selected option's refusal is printed beside
 * Confirm. Only for a viewer who can resolve, and not on the card that says
 * who answers once (`saidOnce`), whose note under the options describes the
 * refused Confirm instead.
 */
export function blockReasonShown(
  canResolve: boolean,
  blockReason: string | null,
  standing: PacketStanding,
): blockReason is string {
  return canResolve && blockReason !== null && !standing.saidOnce;
}

/**
 * F17-L8: the Confirm button's visible label stays concise (echoing a
 * multi-line option title overflowed the flex button — F-UI1), but the
 * accessible name states WHAT is being confirmed, so a screen-reader user
 * hears the chosen option, not a bare "Confirm decision".
 */
export function confirmName(selected: PacketOption | undefined, customSelected: boolean): string {
  return selected
    ? `Confirm decision: ${selected.t}`
    : customSelected
      ? "Confirm decision: your custom directive"
      : "Confirm decision";
}

/** The answer box's label, placeholder and empty-answer refusal. */
export interface AnswerBoxCopy {
  label: string;
  placeholder: string | undefined;
  refusal: string;
}

export function answerBoxCopy(
  connectsRepository: boolean,
  answerTo: string | undefined,
  needsReply: boolean,
): AnswerBoxCopy {
  return {
    // Ruling 478(e) (F40-31): on an agent's question this box is the
    // person's answer to THAT agent, which `resolvePacket` sends it
    // back to. "Note for the operator · optional" told them their
    // reply was a side note for someone else, and a note that named
    // the operator, as the label invited, re-routed the answer away
    // from the agent that asked (ruling 447).
    label: connectsRepository
      ? "Repository to connect"
      : answerTo
        ? `Your answer to ${answerTo}`
        : "Note for the operator",
    // U39-7: this box sits under every packet, and "before
    // reopening" fitted only the closed-pull-request one. Ruling
    // 643: a required answer has no example; its label already says
    // whose answer it is, and the one example ("what it asked for,
    // exactly as you see it") fitted only a question about a value
    // on the person's screen.
    placeholder: connectsRepository
      ? "owner/name"
      : answerTo
        ? needsReply
          ? undefined
          : `e.g. anything ${answerTo} should also know`
        : "e.g. anything the operator should also know",
    refusal: connectsRepository
      ? "Enter the repository as owner/name first."
      : answerTo
        ? `Write your answer to ${answerTo} first.`
        : "Write your answer first.",
  };
}

/** The archive ceremony's subject and wording (`PacketArchiveConfirm`). */
export interface ArchiveCeremonyCopy {
  deletesBranch: boolean;
  branch: string | null;
  subject: string;
  /** What the archive withdraws, joined into one sentence by the dialog. */
  withdrawn: string[];
  ariaLabel: string;
  icon: IconName;
  heading: string;
  footHint: string;
  confirmLabel: string;
}

/**
 * Absent a disclosure (the page has not wired it), the dialog names the branch
 * generically and states no withdrawal it cannot verify. It never invents facts
 * to fill the slots.
 */
export function archiveCeremonyCopy(
  option: PacketOption,
  packetTitle: string,
  disclosure: PacketArchiveDisclosure | undefined,
): ArchiveCeremonyCopy {
  const deletesBranch = option.deleteBranch === true;
  const branch = disclosure?.branch ?? null;
  const pending = disclosure?.pendingRecommendations ?? 0;
  const subject = disclosure?.taskKey ?? "this task";
  const withdrawn = [
    `the open “${packetTitle}” decision`,
    ...(pending > 0
      ? [
          // Inline plural, not `countLabel`: ruling 457 (shared/text/plural.ts).
          `${pending} pending operator recommendation${
            pending === 1 ? "" : "s"
          }`,
        ]
      : []),
  ];
  return {
    deletesBranch,
    branch,
    subject,
    withdrawn,
    ariaLabel:
      (deletesBranch ? "Archive and delete the branch for " : "Archive ") +
      subject,
    icon: deletesBranch ? "alert" : "lock",
    heading: deletesBranch
      ? "Archive this task and delete its branch?"
      : "Archive this task?",
    footHint: deletesBranch
      ? "The archive is reversible. Deleting the branch on GitHub is not."
      : "Recorded as a timeline note and an audit row.",
    confirmLabel: deletesBranch
      ? branch
        ? `Archive & delete ${branch}`
        : "Archive & delete the branch"
      : `Archive ${subject}`,
  };
}
