import type { ReactNode } from "react";
import type { PacketRender } from "~/shared/mapping/task.server";
import { Icon } from "~/ui/icon";
import { usePacketChoice, type PacketChoice } from "./decision-packet-actions";
import {
  PacketArchiveConfirm,
  PacketCollisionConfirm,
  PacketDiscardConfirm,
} from "./decision-packet-ceremonies";
import {
  blockReasonShown,
  branchDiscardOffered,
  observationLabel,
  observationValue,
  packetStanding,
  packetTone,
  type PacketTierGrants,
} from "./decision-packet-derive";
import {
  BlockReasonNote,
  ChoiceRefusal,
  CreateTaskEchoes,
  DecidedPacketContent,
  DirectiveField,
  EscalationNote,
  PacketActions,
  PacketBody,
  PacketNoteField,
  PacketOptions,
  ResolveRefusalNote,
} from "./decision-packet-regions";

/**
 * Decision packet card — 1:1 port of DecisionPacket (task.jsx, spec §4.2).
 * Rendered only when the task has an open packet. The primary button's
 * label is the SELECTED option's title; resolution dispatches by option
 * INDEX (the server re-reads the packet and dispatches on the option's
 * stable `kind` — ruling 7, never the English title).
 *
 * F19-7: `onResolve` is NOT always a submit. An `accept_completion` option runs
 * the full acceptance contract including the real, irreversible PR merge, so the
 * page interposes the shared `AcceptConfirm` ceremony (ruling 20) on that one
 * kind and replays this call's index + note only if the human confirms. Nothing
 * on this card should assume the click wrote anything.
 *
 * Port additions (sanctioned): arrow-key roving on the radiogroup
 * (spec §7 accessibility inventory), busy-disable while the resolve action
 * is in flight (no optimistic governed state).
 *
 * The packet body renders inline `code` spans (a real operator writes branch
 * names / scopes like `pull_request:write` inline) — the mock's plain-text-with-
 * visible-backticks was corrected so the model's markdown reads as intended.
 */

/*
 * Ruling 700(e) split the card along the task-page recipe: its choice is one
 * hook (`usePacketChoice`, decision-packet-actions.ts), what it reads off the
 * packet and the viewer's tiers is pure functions (decision-packet-derive.ts),
 * and its regions and its three ask-first ceremonies are hook-free components
 * (decision-packet-regions.tsx, decision-packet-ceremonies.tsx) that each take
 * the slot their markup held here. The card still decides which of them
 * stand, in the slots they always held, so its markup and every id React
 * derives from its place in the tree are what they were.
 */

/**
 * UX19-4 — the exact label of the GitHub panel's delivery button
 * (`task-side-panels.tsx`). The note below points a human at a control BY NAME,
 * so it is exported and the co-located test renders `GithubTrace` beside this
 * card and asserts the panel's button carries this very string — two files that
 * cannot drift apart into a note pointing at a control nobody can find.
 */
export const DELIVER_LABEL = "Deliver branch & open PR";

/**
 * What an `archive_task` resolution destroys, for its confirm
 * (`PacketArchiveConfirm`, decision-packet-ceremonies.tsx). The packet
 * render carries none of it (it is the operator's authored prose plus option
 * kinds), so the task page supplies it — the same way `ArchiveConfirm` is handed
 * `task` and `pendingRecommendations` for the Current-state Archive button.
 */
export interface PacketArchiveDisclosure {
  /** Task key, for the dialog's subject line. */
  taskKey: string;
  /** The task's delivery branch (`task.branch`) — null before any delivery. */
  branch: string | null;
  /** Pending operator recommendations this archive withdraws. */
  pendingRecommendations: number;
  /**
   * F31-6: the unrelated PR recorded on this task's branch name (R15-15) —
   * what the `resolve_remote_collision` ceremony says it closes.
   *
   * V1: REQUIRED, not optional. The one production producer (the task page)
   * wrote the other three fields as an object literal and left this one out, so
   * the "and closes its pull request #N" clause was unreachable outside tests —
   * `task.unownedPr` was sitting right there on the same task. An optional field
   * is a slot a literal can silently skip; a required one fails typecheck.
   */
  unownedPr: number | null;
  /**
   * C3 (pass 34, U34-8): this task's OWN open review pull request, when one
   * stands — the exact state `deleteTaskRemoteBranch` refuses on ("a PR is
   * open on the branch"), which both remote-branch ceremonies reach. Null when
   * no PR of this task's own is open. Both dialogs warn with it BEFORE the
   * button, instead of letting a person confirm a deletion the server will
   * refuse (live: JC-6 and JC-3, both confirmed, both refused).
   */
  openPr: number | null;
  /**
   * Ruling 161 (pass 35, U35-8): origin's copy of the branch carries commits
   * this task did not author, as the reconciler last recorded it
   * (`task.foreignHead`): the head sha when GitHub named one and the unowned
   * PR when one stands. The delete-branch dialog says so BEFORE the button:
   * live (KNC-21) the archive deleted a remote `knc-21` whose head was a
   * foreign fixture commit the packet itself called "not ours", and the
   * dialog never said the remote held someone else's work. Required for the
   * same reason `unownedPr` is (V1). Null when the head is this task's.
   */
  foreignHead: { sha: string | null; prNumber: number | null } | null;
}

/**
 * Ruling 500 (AICSS's Approval Card): the packet's head. A tile in the packet's
 * tone (amber for a question, coral for a block) with its glyph, the kind as
 * the card's title, and the attribution at the right. Attribution is a
 * whisper, not a badge: the boxed `.agent-glyph.op` (a filled 26px square) was
 * the brightest object on a card whose content is the options (owner
 * 2026-08-21). The bare shield at text size carries the same identity in the
 * header's own voice.
 */
function PacketHead({ kind, from, blocked }: { kind: string; from: string; blocked: boolean }) {
  return (
    <div className="packet-top">
      <span className="packet-tile" aria-hidden="true">
        <Icon name={blocked ? "alert" : "hand"} />
      </span>
      <span className="packet-kind">{kind}</span>
      <span className="from">
        from <Icon name="shield" /> <strong className="from-name">{from}</strong>
      </span>
    </div>
  );
}

/** The decision packet card's props. */
interface DecisionPacketProps {
  packet: PacketRender;
  busy: boolean;
  /** Ruling 529: a question asked while an agent keeps working on the task,
   *  which the work does not wait on. The card takes a quieter surface and
   *  says so in its first line. */
  aside?: boolean;
  /** Ruling 521: the completion packet, drawn between the evidence and the
   *  options when one of them offers the task for acceptance. */
  completion?: ReactNode;
  /** Whether the viewer may RESOLVE this packet (admin|maintainer, or the task
   *  owner for non-completion options — M2). "Ask operator" stays open to all
   *  (commenting is app-wide). */
  canResolve: boolean;
  /** Whether the viewer may resolve the ACCEPT_COMPLETION option specifically —
   *  admin|maintainer, or this task's own human owner (R6-2, widened by R14-2).
   *  A viewer with canResolve but not this (e.g. a packet addressed to someone
   *  else's task) has the button blocked while that option is selected rather
   *  than 403ing on click (adversarial-review #15). */
  canResolveCompletion: boolean;
  /** UI-42: whether the viewer may actually EDIT the goal. `edit_goal` is
   *  offered to any packet resolver (which includes the task owner), but
   *  `update-goal` is admin|maintainer — so a contributor-owner picked "a human
   *  refines the task goal", got "type the new goal", and found no editor and no
   *  Edit button, with the packet open forever. */
  canEditGoal: boolean;
  /** Whether the viewer holds `approve-transition` — the R14-3 archive tier an
   *  `archive_task` option re-checks server-side. Same block-with-reason
   *  treatment as the two flags above. */
  canArchive: boolean;
  /** F20-6 (R20-2): whether the viewer holds `approve-transition` — the tier a
   *  `discard_branch` option re-checks server-side (it destroys commits, same
   *  authority the archive-with-branch-deletion needs). Same block-with-reason
   *  treatment as `canArchive`. */
  canDiscardBranch?: boolean;
  /** Ruling 164 (pass 35, F35-14): whether the viewer holds
   *  `force-accept-completion` (admin), the tier a `force_accept` option
   *  re-checks server-side with the Force accept button's own sentence. */
  canForceAccept?: boolean;
  /** Ruling 164: whether the viewer holds `approve-transition`, the tier a
   *  `move_stage` option re-checks (it is the stage picker's own move). */
  canMoveStage?: boolean;
  /** Ruling 672: whether the viewer holds `edit-policy`, the tier both
   *  answers to the repository question re-check. */
  canEditPolicy?: boolean;
  /** UX19-9: what an `archive_task` resolution destroys, for its confirm. */
  archiveDisclosure?: PacketArchiveDisclosure;
  /**
   * Ruling 319: the other tasks this confirm also answers, in one sentence, or
   * null when it answers only this one.
   *
   * A packet raised by a backend failure carries a `cause` naming the ACCOUNT
   * that failed, and resolving it applies the same option to every sibling
   * packet that cause raised. That is what the person wants — one quota outage
   * should not be five identical decisions — but a confirm whose reach is wider
   * than its card is an undisclosed write, and this card is the only place the
   * reach can be stated before the click rather than reported after it.
   */
  alsoAnswers?: string | null;
  /**
   * Ruling 324: per `create_task` option index, the tasks on this project whose
   * title already looks like the one that option would create.
   *
   * A confirm here makes a real task under the person's own authority, and the
   * card discloses what it will create while saying nothing about what already
   * exists. Twice on one board that confirm was a click away from standing up a
   * second owner for work a live task already held — caught both times only
   * because a person read the packet and recognised it.
   *
   * Shown under the option it belongs to and only while that option is
   * selected: it is information about THAT choice, not about the packet.
   */
  createTaskEchoes?: Record<number, { key: string; title: string; stage: string }[]>;
  onResolve: (optionIndex: number, note: string) => void;
  /** Ruling 138: a DECIDED `edit_goal` packet has one way out — the goal
   *  editor, opened prefilled with the chosen option's draft. */
  onEditGoal?: (draft: string) => void;
  /** Questionnaire packets (owner request 2026-08-20): resolve with the
   *  human's OWN directive instead of a canned option. The server runs it as
   *  the un-gated `custom` kind — sent back to an asking agent, requeued to
   *  the operator with the text as its note. */
  onResolveCustom: (text: string) => void;
  /** F20-18: hand this decision UP to a maintainer/admin. Present only for a
   *  contributor-OWNER who may resolve the packet but for whom EVERY option
   *  needs a tier above theirs — the one case `requestPacketMaintainerDecision`
   *  exists for. Absent hides the affordance (a maintainer/admin already holds
   *  every tier, and a non-owner has no standing to route another's task).
   *  Ruling 672: also present for a maintainer on the repository question,
   *  whose two answers are a project admin's. */
  onRequestMaintainer?: () => void;
  /** Ruling 368: the escalation {@link onRequestMaintainer} sent is in flight,
   *  so its button says so instead of staying live and silent. */
  escalating?: boolean;
  onAsk: () => void;
}
export function DecisionPacket({
  packet,
  busy,
  canResolve,
  canResolveCompletion,
  canEditGoal,
  canArchive,
  canDiscardBranch = false,
  canForceAccept = false,
  canMoveStage = false,
  canEditPolicy = false,
  archiveDisclosure,
  alsoAnswers = null,
  createTaskEchoes = {},
  onResolve,
  onResolveCustom,
  onRequestMaintainer,
  escalating = false,
  onAsk,
  onEditGoal,
  completion = null,
  aside = false,
}: DecisionPacketProps) {
  const p = packet;
  // The one place the card reads its own authority flags. Every refusal — the
  // selected option's, each row's, and the every-option scan — comes back
  // through `gateFor` (decision-packet-derive.ts), so a kind cannot be gated
  // on one surface and open on another (V16).
  const grants: PacketTierGrants = {
    canResolveCompletion,
    canEditGoal,
    canArchive,
    canDiscardBranch,
    canForceAccept,
    canMoveStage,
    canEditPolicy,
  };
  const choice = usePacketChoice(p, canResolve, grants, onResolve, onResolveCustom);
  const isBlocked = p.type === "blocked";
  const tone = packetTone(p);

  // Ruling 138: a decided `edit_goal` packet reads as decided after a reload —
  // the chosen option locked, no Confirm, and one control that opens the goal
  // editor exactly as the confirm did. A packet stamped `awaiting` before the
  // decision was recorded renders nothing special.
  const decided = p.awaiting === "goal_edit" ? p.decided : undefined;
  if (decided) {
    return (
      <div className={"packet " + tone} data-decided="">
        <PacketHead kind={p.kind} from={p.from} blocked={isBlocked} />
        <div className="packet-body">
          <DecidedPacketContent
            packet={p}
            decided={decided}
            busy={busy}
            canEditGoal={canEditGoal}
            onAsk={onAsk}
            onEditGoal={onEditGoal}
          />
        </div>
      </div>
    );
  }
  const { pendingOption, cancelConfirm, commitConfirm } = choice;
  return (
    <div className={"packet " + tone} data-aside={aside ? "" : undefined}>
      <PacketHead kind={p.kind} from={p.from} blocked={isBlocked} />
      <div className="packet-body">
        <OpenPacketContent
          packet={p}
          choice={choice}
          grants={grants}
          busy={busy}
          canResolve={canResolve}
          archiveDisclosure={archiveDisclosure}
          alsoAnswers={alsoAnswers}
          createTaskEchoes={createTaskEchoes}
          onRequestMaintainer={onRequestMaintainer}
          escalating={escalating}
          onAsk={onAsk}
          completion={completion}
          aside={aside}
        />
      </div>

      {/* The open ask-first ceremony, chosen by the pending option's own
          `kind` (decision-packet-ceremonies.tsx). */}
      {pendingOption?.kind === "archive_task" && (
        <PacketArchiveConfirm
          option={pendingOption}
          packetTitle={p.title}
          disclosure={archiveDisclosure}
          busy={busy}
          onCancel={cancelConfirm}
          onConfirm={commitConfirm}
        />
      )}

      {pendingOption?.kind === "discard_branch" && (
        <PacketDiscardConfirm
          option={pendingOption}
          disclosure={archiveDisclosure}
          busy={busy}
          onCancel={cancelConfirm}
          onConfirm={commitConfirm}
        />
      )}

      {pendingOption?.kind === "resolve_remote_collision" && (
        <PacketCollisionConfirm
          option={pendingOption}
          disclosure={archiveDisclosure}
          busy={busy}
          onCancel={cancelConfirm}
          onConfirm={commitConfirm}
        />
      )}
    </div>
  );
}

/**
 * The open card's `.packet-body`, in the order it always stood: the aside
 * line, the title, the body, the observations, the completion packet, the
 * reach, the options, the choice's refusal, the directive, the closed-PR
 * recovery note, the answer box, the echoes, the refusal notes and the action
 * row. Returned as one list of the sixteen slots the body always held, with
 * `completion` fifth, so the ids React derives from a slot's position (the
 * completion packet's fetchers among them) are unchanged, and each region
 * that shows only some of the time is decided here, in its slot.
 */
function OpenPacketContent({
  packet: p,
  choice,
  grants,
  busy,
  canResolve,
  archiveDisclosure,
  alsoAnswers,
  createTaskEchoes,
  onRequestMaintainer,
  escalating,
  onAsk,
  completion,
  aside,
}: {
  packet: PacketRender;
  choice: PacketChoice;
  grants: PacketTierGrants;
  busy: boolean;
  canResolve: boolean;
  archiveDisclosure: PacketArchiveDisclosure | undefined;
  alsoAnswers: string | null;
  createTaskEchoes: Record<number, { key: string; title: string; stage: string }[]>;
  onRequestMaintainer: (() => void) | undefined;
  escalating: boolean;
  onAsk: () => void;
  completion: ReactNode;
  aside: boolean;
}) {
  /** Ruling 478(e) (F40-31, F40-57): the agent this card's answer goes back
   *  to, when an agent asked. Nothing is preselected on its question
   *  (`initialChoice`). */
  const answerTo = p.answerTo;
  const standing = packetStanding(p, canResolve, grants);
  const echoes = createTaskEchoes[choice.sel] ?? [];

  /**
   * UX19-4, rewritten for ruling 160 (pass 35, F35-11) — the closed-PR recovery
   * packet enumerated rework / archive / archive-and-delete-the-branch and told
   * the reader that reopening the PR on GitHub was "also a valid path", while
   * the GitHub panel's "Deliver branch & open PR" sat directly ABOVE the card.
   * The note named that control, because it then opened a fresh review PR and
   * really did recover a mistaken close.
   *
   * Ruling 160 closed that door on purpose: a pull request a person closed
   * without merging is a decision about the task, and `openTaskPr` answers
   * `closed_by_human` while `pr.closure.answered` is null — which is null for
   * exactly as long as this packet stands, since answering it IS what stamps it
   * (`resolvePacket`). So the note now says what the door does, because naming
   * a control that then refuses is worse than naming none:
   *
   *  - the panel still renders the button whenever no LIVE pr stands
   *    (`prIsTerminal` in `task-side-panels-derive.ts`: `!task.pr || state ===
   *    "closed" | "merged"`),
   *    and disables it with the same refusal while the closure is unanswered;
   *  - authority is `run-agents` OR this task's own owner
   *    (`manualDeliverForReview`), which is exactly the set `canResolve`
   *    carries here (`taskPermissions` in `task-detail-derive.ts`:
   *    `canRunAgents || isOwner`), so the note is shown only to a viewer who
   *    has the button;
   *  - resolving this packet is therefore the precondition, not an aside: a
   *    person's answer stamps `closure.answered`, and the NEXT delivery opens a
   *    fresh review pull request (Viberr never reopens a closed one).
   *  - reopening the pull request on GitHub lifts the block too: the reconciler
   *    drops the closure with the closed state, which is the promise the packet
   *    body (authored from `operator-prompt.server.ts`) already makes.
   *
   * Keyed on the `archive_task` + `deleteBranch` option and on the task's
   * branch: `branchDiscardOffered` (decision-packet-derive.ts) says why.
   */
  const offersBranchDiscard = branchDiscardOffered(p, archiveDisclosure);

  return (
    <>
      {aside && (
        <p className="packet-aside">
          <span className="working" aria-hidden="true" />
          Not blocking: an agent keeps working while you decide.
        </p>
      )}
      <h2>{p.title}</h2>
      <PacketBody text={p.body} />

      <div className="packet-obs">
        {p.observations
          // C7: a live packet doubled its summary sentence — the body lede
          // above and an observation row (the operator's SIGNAL) were
          // byte-identical. Drop the observation that only repeats the body.
          .filter((o) => o.v.trim() !== p.body.trim())
          .map((o, i) => {
            const value = observationValue(o.k, o.v);
            return (
              <div className="obs" key={i}>
                <span className="k">{observationLabel(o.k)}</span>
                <span>{o.code ? <code>{value}</code> : value}</span>
              </div>
            );
          })}
      </div>

      {completion}

      {/* Ruling 319: stated ABOVE the options, because it changes what
          picking one of them means. */}
      {alsoAnswers && (
        <p className="deny-note spaced" data-also-answers="">
          <Icon name="alert" />
          {alsoAnswers}
        </p>
      )}

      <PacketOptions
        packet={p}
        choice={choice}
        grants={grants}
        standing={standing}
      />

      {choice.choiceInvalid && <ChoiceRefusal choice={choice} />}

      {choice.customSelected && <DirectiveField choice={choice} answerTo={answerTo} />}

      {canResolve && offersBranchDiscard && (
        // Body copy, not a footnote: it is a recovery path the options list
        // left out, and the last clause is decision-relevant to the option
        // sitting right above it.
        <p className="packet-lede spaced">
          Not in this list: the GitHub panel on this page still offers{" "}
          <strong>{DELIVER_LABEL}</strong>, and it is refused while this
          decision stands. Answering here is what lifts it: choose the rework
          option and the next delivery opens a new review pull request
          (Viberr never reopens a closed one), so a pull request closed by
          mistake is recovered from here, with no trip to GitHub. Reopening
          the pull request on GitHub lifts the block too, and the archive
          option that deletes the branch ends that path.
        </p>
      )}

      {choice.showsAnswerBox && <PacketNoteField choice={choice} answerTo={answerTo} />}

      {echoes.length > 0 && <CreateTaskEchoes echoes={echoes} sel={choice.sel} />}

      {blockReasonShown(canResolve, choice.blockReason, standing) && (
        <BlockReasonNote blockReason={choice.blockReason} />
      )}

      {!canResolve && <ResolveRefusalNote standing={standing} />}

      {standing.everyOptionForbidden && (
        <EscalationNote
          standing={standing}
          taskKey={archiveDisclosure?.taskKey}
          busy={busy}
          escalating={escalating}
          onRequestMaintainer={onRequestMaintainer}
        />
      )}

      <PacketActions choice={choice} canResolve={canResolve} busy={busy} onAsk={onAsk} />
    </>
  );
}
