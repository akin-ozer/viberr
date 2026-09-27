import { useRef, useState, type ReactNode } from "react";
import { PACKET_NOTE_MAX, type PacketOptionKind } from "~/schemas/task-file.schema";
import type { PacketRender } from "~/shared/mapping/task.server";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon, type IconName } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { useDialog } from "~/ui/use-dialog";
import { useRefusalShake } from "~/ui/use-refusal-shake";

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

/** Ties the Confirm button to its visible refusal reason (E4). */
const BLOCK_REASON_ID = "pkt-block-reason";
/** Ruling 147: where a refused Confirm says the directive is still empty. */
const CUSTOM_ERR_ID = "pkt-custom-err";
/** Ruling 478(e): where a refused Confirm says no answer is chosen yet. */
const CHOICE_ERR_ID = "pkt-choice-err";
/** Ruling 478(e): where a refused Confirm says the chosen answer needs text. */
const REPLY_ERR_ID = "pkt-reply-err";
/**
 * UX19-4 — the exact label of the GitHub panel's delivery button
 * (`task-side-panels.tsx`). The note below points a human at a control BY NAME,
 * so it is exported and the co-located test renders `GithubTrace` beside this
 * card and asserts the panel's button carries this very string — two files that
 * cannot drift apart into a note pointing at a control nobody can find.
 */
export const DELIVER_LABEL = "Deliver branch & open PR";

/** Render a string with `inline code` spans; everything else stays plain text. */
function renderInlineCode(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<code key={i++}>{m[1]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/**
 * Ruling 472: the body is the asking agent's own text, and agents write it as
 * markdown — numbered dashboard steps, bold field names, a heading per part.
 * Rendered through the inline-code pass alone, a 3,500-character Connect guide
 * read as one paragraph with literal `**` and `##` (WEB-3, 2026-09-24). It goes
 * through the same GFM renderer as the timeline's comments; a <div>, because a
 * list cannot sit inside a <p>.
 *
 * Ruling 478(f) (F40-35): the body's headings are parts of the question, so
 * they nest under the packet's own h2 title rather than standing beside it.
 */
function PacketBody({ text }: { text: string }): ReactNode {
  return (
    <div className="packet-lede md-body">
      <Markdown text={text} headingBase={3} />
    </div>
  );
}
/**
 * LV-09: packet observations are written by the operator, which serializes an
 * absent value as the literal string "null" — a blocked packet printed
 * `OWNER null` at the human it was asking for a decision. Render the empty
 * cases as English; anything else passes through verbatim.
 */
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
function observationLabel(key: string): string {
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

function observationValue(key: string, value: string): string {
  const empty =
    value.trim() === "" ||
    value.trim().toLowerCase() === "null" ||
    value.trim().toLowerCase() === "undefined" ||
    value.trim().toLowerCase() === "none";
  if (!empty) return value;
  return /owner|assignee/i.test(key) ? "unassigned" : "none";
}

/**
 * What an `archive_task` resolution destroys, for the confirm below. The packet
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
 * The shell the three ask-first ceremonies below share: an `alertdialog` with a
 * warn glyph and a close, a `packet-obs flush` body of what-happens rows, and a
 * foot of "Not yet" beside one danger commit.
 *
 * Rulings 20 (R15-1) and 53 (R18-7) hold every one-way write to ONE ceremony,
 * and the three that live on this card were three shell-for-shell copies of it:
 * a change to the shared half (the close affordance, the foot layout, the
 * alertdialog contract) landed on whichever copy was open at the time. Each
 * ceremony now supplies only what makes it different — its subject, its rows and
 * its wording — and the standard itself lives here once.
 */
function PacketDestructiveConfirm({
  ariaLabel,
  screenLabel,
  icon,
  heading,
  subhead,
  footHint,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  children,
}: {
  /** Accessible name of the dialog. */
  ariaLabel: string;
  /** `data-screen-label` — the handle the co-located tests select the dialog by. */
  screenLabel: string;
  /** Head glyph AND commit-button icon: one destructiveness cue, stated once. */
  icon: IconName;
  heading: string;
  /** Under the heading: the option title, sometimes prefixed with the task key. */
  subhead: ReactNode;
  footHint: string;
  /** The commit button's visible label, which must name the outcome. */
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** The `.obs` rows stating what this resolution does and does not touch. */
  children: ReactNode;
}) {
  // Ruling 459: the commit leaves the way Cancel does (`commit`); onCancel
  // unmounts it after the exit.
  const { ref: panelRef, close, commit } = useDialog(onCancel);
  return (
    <dialog
      className="modal-card release-card"
      role="alertdialog"
      aria-label={ariaLabel}
      data-screen-label={screenLabel}
      ref={panelRef}
    >
      <div className="modal-head">
        <span className="agent-glyph lg warn">
          <Icon name={icon} />
        </span>
        <div className="mh-main">
          <h2>{heading}</h2>
          <div className="mh-sub">{subhead}</div>
        </div>
        <button
          type="button"
          className="icon-btn modal-close"
          onClick={close}
          aria-label="Close"
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body tight">
        <div className="packet-obs flush">{children}</div>
      </div>
      <div className="modal-foot">
        <span className="foot-hint">{footHint}</span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Not yet
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={() => commit(onConfirm)}
          >
            <Icon name={icon} />
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * UX19-9 — an `archive_task` packet option asks first, like its sibling does.
 *
 * Ruling 17 makes this packet the ONLY place in the product that deletes a
 * remote branch ("Remote-branch deletion exists only as that packet
 * resolution"), and ruling 20 (R15-1) / ruling 53 (R18-7) established the
 * standard the rest of this page already meets: a one-way write states what it
 * destroys and offers a way out, at EVERY entry point — never from a generic
 * button. The task page confirmed the *reversible* archive (`ArchiveConfirm`,
 * which enumerates the open decision and the pending recommendations it
 * withdraws) and not the irreversible one, which committed a permanent GitHub
 * branch deletion from a button whose whole promise is "Confirm decision" and
 * announced the outcome only afterwards, as a timeline note. That inverts the
 * app's own escalation of ceremony with destructiveness.
 *
 * It is a local dialog rather than a second shared `AcceptConfirm`-style
 * ceremony (accept-confirm.tsx — F31-C8: an earlier revision of this comment
 * named an `AcceptDisclosureProvider` context that never shipped): the shared
 * ceremony exists because FOUR surfaces can reach `acceptCompletion` and were
 * drifting apart (F19-3/F19-7). Ruling 17 gives branch deletion exactly one
 * surface — this card — so there is nothing to keep in sync. It still wears the
 * `PacketDestructiveConfirm` shell above; local means "not routed through
 * accept-confirm.tsx", not "its own copy of the ceremony".
 */
function PacketArchiveConfirm({
  option,
  packetTitle,
  disclosure,
  busy,
  onCancel,
  onConfirm,
}: {
  option: PacketRender["options"][number];
  packetTitle: string;
  /** Absent when the page has not wired it: the dialog then names the branch
   *  generically and states no withdrawal it cannot verify. It never invents
   *  facts to fill the slots. */
  disclosure?: PacketArchiveDisclosure;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
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
  return (
    <PacketDestructiveConfirm
      ariaLabel={
        (deletesBranch ? "Archive and delete the branch for " : "Archive ") +
        subject
      }
      screenLabel="Packet archive dialog"
      icon={deletesBranch ? "alert" : "lock"}
      heading={
        deletesBranch
          ? "Archive this task and delete its branch?"
          : "Archive this task?"
      }
      subhead={
        <>
          {disclosure ? (
            <>
              <span className="mono">{disclosure.taskKey}</span> ·{" "}
            </>
          ) : null}
          {option.t}
        </>
      }
      footHint={
        deletesBranch
          ? "The archive is reversible. Deleting the branch on GitHub is not."
          : "Recorded as a timeline note and an audit row."
      }
      confirmLabel={
        deletesBranch
          ? branch
            ? `Archive & delete ${branch}`
            : "Archive & delete the branch"
          : `Archive ${subject}`
      }
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {/* The human pressed "Confirm decision" — a label that names no
          outcome. Say which decision option this dialog is about, the way
          the acceptance dialog names its own entry point (F19-7). */}
      <div className="obs">
        <span className="k">Decision</span>
        <span>Confirming “{option.t}” archives {subject}.</span>
      </div>
      {deletesBranch && (
        <div className="obs warn">
          <span className="k">Deletes</span>
          <span>
            {branch ? (
              <>
                The remote branch <span className="mono">{branch}</span> on
                GitHub,
              </>
            ) : (
              <>This task's remote branch on GitHub,</>
            )}{" "}
            and every commit that exists only there.{" "}
            {disclosure?.foreignHead ? (
              <>
                Origin&rsquo;s{" "}
                <span className="mono">{branch ?? "branch"}</span> carries
                commits this task did not author
                {disclosure.foreignHead.sha ? (
                  <>
                    {" "}
                    (head{" "}
                    <span className="mono">
                      {disclosure.foreignHead.sha.slice(0, 7)}
                    </span>
                    {disclosure.foreignHead.prNumber !== null ? (
                      <>
                        , pull request{" "}
                        <span className="mono">
                          #{disclosure.foreignHead.prNumber}
                        </span>{" "}
                        stands on it
                      </>
                    ) : null}
                    )
                  </>
                ) : disclosure.foreignHead.prNumber !== null ? (
                  <>
                    {" "}
                    (pull request{" "}
                    <span className="mono">#{disclosure.foreignHead.prNumber}</span>{" "}
                    stands on it)
                  </>
                ) : null}
                ; deleting it removes them too.{" "}
              </>
            ) : null}
            <strong>Deleting it cannot be undone.</strong> Restoring the task
            later does not bring the branch back.
          </span>
        </div>
      )}
      {/* C3 (pass 34, U34-8): this dialog reaches the same server refusal the
          collision ceremony does, and used to only INFER that no PR stands
          (from the operator's authoring rule). It says it outright now. */}
      {deletesBranch && <OpenPrRow openPr={disclosure?.openPr ?? null} ceremony="archive" />}
      <div className="obs">
        <span className="k">After</span>
        <span>
          Off the board and out of the review queue. The task file, its
          timeline and its audit trail are kept exactly as they are. The
          archive itself is a disposition, not a delete, and a maintainer can
          restore it.
        </span>
      </div>
      <div className="obs">
        <span className="k">Withdrawn</span>
        <span>
          {withdrawn.join(" and ")}. Restoring brings the task back to a human; run the operator to reopen the decision.
        </span>
      </div>
    </PacketDestructiveConfirm>
  );
}

/**
 * F20-6 (R20-2) — a `discard_branch` packet option deletes the task's LOCAL,
 * never-pushed workspace branch. It destroys commits, so it asks first, exactly
 * like its `archive_task` sibling above — but with a narrower promise: nothing
 * on GitHub changes (resolution refuses the moment the branch exists on the
 * remote, ruling 17). A local dialog for the same reason `PacketArchiveConfirm`
 * is one: this is the only surface that offers the discard.
 */
function PacketDiscardConfirm({
  option,
  branch,
  busy,
  onCancel,
  onConfirm,
}: {
  option: PacketRender["options"][number];
  /** The task's workspace branch (`task.branch`) — named when the page wired it. */
  branch: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <PacketDestructiveConfirm
      ariaLabel="Discard this task's workspace branch"
      screenLabel="Packet discard dialog"
      icon="alert"
      heading="Discard this task’s workspace branch?"
      subhead={option.t}
      footHint="Recorded as a timeline note and an audit row."
      confirmLabel={branch ? `Discard ${branch}` : "Discard the branch"}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="obs">
        <span className="k">Decision</span>
        <span>Confirming &ldquo;{option.t}&rdquo; discards the branch.</span>
      </div>
      <div className="obs warn">
        <span className="k">Deletes</span>
        <span>
          The <strong>local</strong> workspace branch{" "}
          {branch ? (
            <span className="mono">{branch}</span>
          ) : (
            <>for this task</>
          )}{" "}
          and every commit that exists only there.{" "}
          <strong>This cannot be undone.</strong>
        </span>
      </div>
      <div className="obs">
        <span className="k">GitHub</span>
        <span>
          Nothing on GitHub changes: this branch was never pushed. (If it had
          been, the discard is refused and the archive option is the path.)
        </span>
      </div>
      {/* Ruling 161: a reported revision that never left the workspace goes
          with the branch. Its verdicts stay as history, and nothing is under
          review afterwards. */}
      <div className="obs">
        <span className="k">Review</span>
        <span>
          A revision the agent reported on this branch is retired with it: its
          verdicts stay on the record as history, and the task has no revision
          under review until an agent delivers again.
        </span>
      </div>
    </PacketDestructiveConfirm>
  );
}

/**
 * C3 (pass 34, U34-8): what this task's OWN open pull request means for the
 * ceremony about to run, said BEFORE the button rather than after the click.
 * The two ceremonies reach different server rules, so they say different
 * things (pass 34 review found one sentence used for both, and it was wrong
 * on each): an ARCHIVE still archives and only keeps the branch, and a
 * COLLISION resolution is not a deletion at all under ruling 136(b) — it
 * pushes the delivered revision to that PR.
 */
function OpenPrRow({
  openPr,
  ceremony,
}: {
  openPr: number | null;
  ceremony: "archive" | "collision";
}) {
  if (openPr === null) return null;
  const pr = <span className="mono">#{openPr}</span>;
  return (
    <div className="obs warn" data-open-pr-warning="">
      <span className="k">
        {ceremony === "archive" ? "Branch kept" : "No deletion"}
      </span>
      {ceremony === "archive" ? (
        <span>
          This task&rsquo;s own pull request {pr} is still open, and Viberr never
          deletes a branch a pull request is open on. The task is still archived;
          the branch and {pr} stay exactly as they are. Merge or close {pr} on
          GitHub first if you want the branch gone too.
        </span>
      ) : (
        <span>
          The pull request on this branch, {pr}, is this task&rsquo;s OWN review
          pull request, so there is no stranger to clear: nothing is deleted and
          nothing is closed. Confirming pushes this task&rsquo;s delivered
          revision to {pr} and lifts the block; if the remote has diverged from
          it, the block stays and a person reconciles the history.
        </span>
      )}
    </div>
  );
}

/**
 * F31-6 — a `resolve_remote_collision` option asks first, like its destructive
 * siblings: it deletes a REMOTE ref (the stale branch squatting on this task's
 * branch name) and closes the unrelated PR recorded on it, then re-delivers
 * the task's local work. The rows spell out what is removed and — as
 * important — what is KEPT, because this ceremony exists to be the truthful
 * opposite of `discard_branch` (the local delivery survives).
 */
function PacketCollisionConfirm({
  option,
  branch,
  unownedPr,
  openPr,
  busy,
  onCancel,
  onConfirm,
}: {
  option: PacketRender["options"][number];
  /** The task's branch name (`task.branch`) — the ref being reclaimed. */
  branch: string | null;
  /** The unrelated PR recorded on that branch (R15-15), when known. */
  unownedPr: number | null;
  /** C3: this task's own open PR, which refuses the deletion. */
  openPr: number | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const branchLabel = branch ? (
    <span className="mono">{branch}</span>
  ) : (
    <>this task&rsquo;s branch</>
  );
  // C3 (pass 34, U34-8): with NO unowned PR recorded there is no stranger —
  // `resolveRemoteBranchCollision` deletes THIS task's own remote branch and
  // closes nothing. Describing that as "the unrelated one squatting on this
  // task's branch name" asked a person to confirm the deletion of their own
  // pushed branch under somebody else's description.
  const stranger = unownedPr !== null;
  return (
    <PacketDestructiveConfirm
      ariaLabel={
        stranger
          ? "Clear this task's branch collision"
          : "Delete this task's remote branch and redeliver"
      }
      screenLabel="Packet collision dialog"
      icon="alert"
      heading={stranger ? "Clear the branch collision?" : "Delete this task's remote branch?"}
      subhead={option.t}
      footHint="Recorded as timeline events and audit rows."
      confirmLabel={stranger ? "Clear collision & redeliver" : "Delete branch & redeliver"}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="obs">
        <span className="k">Decision</span>
        <span>
          Confirming &ldquo;{option.t}&rdquo;{" "}
          {stranger
            ? "reclaims the branch name for this task."
            : "removes this task's own remote branch and pushes its local work again."}
        </span>
      </div>
      <div className="obs warn">
        <span className="k">Deletes</span>
        {stranger ? (
          <span>
            The stale branch {branchLabel} on GitHub, the unrelated one squatting
            on this task&rsquo;s branch name, and closes its pull request{" "}
            <span className="mono">#{unownedPr}</span>.{" "}
            <strong>Deleting the remote branch cannot be undone.</strong>
          </span>
        ) : (
          <span>
            This task&rsquo;s own remote branch {branchLabel} on GitHub. No
            unrelated pull request is recorded on it, so nothing of anyone
            else&rsquo;s is touched and no pull request is closed.{" "}
            <strong>Deleting the remote branch cannot be undone.</strong>
          </span>
        )}
      </div>
      <OpenPrRow openPr={openPr} ceremony="collision" />
      <div className="obs">
        <span className="k">Keeps</span>
        <span>
          This task&rsquo;s local delivery. After the {stranger ? "stale " : ""}
          ref is gone it is pushed fresh and the real review PR opens.
        </span>
      </div>
    </PacketDestructiveConfirm>
  );
}

/** The card's authority flags, as the gate table reads them. */
interface PacketTierGrants {
  canResolveCompletion: boolean;
  canEditGoal: boolean;
  canArchive: boolean;
  canDiscardBranch: boolean;
  /** Ruling 164: `force-accept-completion` is admin-only, the tier the task
   *  page's own Force accept button holds. */
  canForceAccept: boolean;
  /** Ruling 164: `approve-transition`, the tier the stage picker holds. */
  canMoveStage: boolean;
}

/** One gated option kind: the grant it needs and how a refusal is stated. */
interface PacketTierGate {
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
   */
  option: { title: string; note: string } | null;
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
]);

/**
 * The option kinds whose ask-first ceremony interposes before the resolve is
 * dispatched (rulings 20/53: a one-way write states what it destroys and offers
 * a way out). `archive_task` with `deleteBranch` performs the product's ONLY
 * remote-branch deletion (ruling 17), `discard_branch` destroys local commits,
 * and `resolve_remote_collision` deletes a remote ref and closes a PR.
 */
const CONFIRM_FIRST_KINDS: ReadonlySet<PacketOptionKind> = new Set([
  "archive_task",
  "discard_branch",
  "resolve_remote_collision",
]);

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

/** Ruling 500: an option's key, the digit that selects it (the radiogroup's
 *  shortcut), where the radio circle stood; filled once chosen. Past nine an
 *  option has no digit, and the key stays for the column. */
function OptionKey({ index }: { index: number }) {
  return (
    <span className="opt-key" aria-hidden="true">
      {index < 9 ? index + 1 : ""}
    </span>
  );
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
}: {
  packet: PacketRender;
  busy: boolean;
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
   *  every tier, and a non-owner has no standing to route another's task). */
  onRequestMaintainer?: () => void;
  /** Ruling 368: the escalation {@link onRequestMaintainer} sent is in flight,
   *  so its button says so instead of staying live and silent. */
  escalating?: boolean;
  onAsk: () => void;
}) {
  const p = packet;
  /**
   * Ruling 478(e) (F40-31, F40-57): the agent this card's answer goes back to,
   * when an agent asked. Its question is one only the person can answer, so
   * nothing is preselected on it (WEB-3's "Connected; the first build
   * succeeded" was one Confirm from telling the agent a build had passed), and
   * nothing is preselected on a packet that recommends nothing. -1 is "no
   * choice yet"; Confirm then refuses in place (ruling 147).
   */
  const answerTo = p.answerTo;
  const [sel, setSel] = useState(() => {
    // With no authored option, the composed directive (index 0) is the one
    // choice there is, and it asks for the words itself.
    if (p.options.length === 0) return 0;
    return answerTo ? -1 : p.options.findIndex((o) => o.rec);
  });
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // P11-71: optional free-text so a human can supply the input an option asks
  // for (e.g. "specify the expected behavior") instead of resolving with an
  // unstated reading. Recorded on the decision event. Ruling 478(e): required
  // when the chosen option is one the asking agent marked `reply`.
  const [note, setNote] = useState("");
  // Questionnaire shape (shadcn base/questionnaire): a free-text input composed
  // WITH the fixed choices, as its own last choice. Selecting it reveals the
  // directive input; the note field steps aside (the directive IS the message).
  // Offered only to viewers who can resolve — the choice would otherwise be a
  // control that only exists to 403.
  const customIndex = p.options.length;
  const customOffered = canResolve;
  const choiceCount = p.options.length + (customOffered ? 1 : 0);
  const customSelected = customOffered && sel === customIndex;
  const [customText, setCustomText] = useState("");
  // Ruling 147: Confirm stays enabled with the directive still empty, and the
  // click is refused here. Counted, so a repeated press inserts a fresh alert;
  // reset by every choice change, so returning to the directive is pristine.
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const customRef = useRef<HTMLTextAreaElement>(null);
  const customInvalid =
    refused > 0 && customSelected && customText.trim() === "";
  /** Every choice change goes through here, so a standing refusal is dropped:
   *  a pristine directive is never accused (ruling 147). */
  const selectOption = (i: number) => {
    setSel(i);
    setRefused(0);
  };
  // UX19-9 / F20-6 / F31-6: the option index whose ask-first ceremony is open
  // (null = none). ONE slot, not one per kind: the open ceremony is chosen by
  // the pending option's own `kind`, so two can never stand at once.
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null);
  const isBlocked = p.type === "blocked";
  // N20-16: a packet raised by the operator recommends its own default; one
  // raised by a delivering/reviewing agent (an ask_human question) carries the
  // AGENT's recommendation. Attributing every rec to "operator pick" was a lie
  // on the developer's own question packet — read the real author off `from`.
  const authoredByOperator = p.from === "Operator";

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
   *    (`task-side-panels.tsx`: `!task.pr || state === "closed" | "merged"`),
   *    and disables it with the same refusal while the closure is unanswered;
   *  - authority is `run-agents` OR this task's own owner
   *    (`manualDeliverForReview`), which is exactly the set `canResolve`
   *    carries here (`task-detail-page.tsx`: `canRunAgents || isOwner`), so the
   *    note is shown only to a viewer who has the button;
   *  - resolving this packet is therefore the precondition, not an aside: a
   *    person's answer stamps `closure.answered`, and the NEXT delivery opens a
   *    fresh review pull request (Viberr never reopens a closed one).
   *  - reopening the pull request on GitHub lifts the block too: the reconciler
   *    drops the closure with the closed state, which is the promise the packet
   *    body (authored from `operator-run.server.ts`) already makes.
   *
   * Keyed on the `archive_task` + `deleteBranch` option because that is the
   * closed-PR signature the schema itself names ("the discard-entirely path for
   * work whose PR a human closed without merging"), the operator only authors
   * it when the task HAS a branch (so there is something to push), and branch
   * deletion is refused while a PR is open (`deleteTaskRemoteBranch`) — so its
   * presence also means no live PR stands in the button's way.
   */
  // U36-2 (pass 36): the option shape alone was the proxy — an `input`
  // packet on a branchless task rendered the closed-PR recovery paragraph
  // about a Deliver refusal that could not exist. The task's branch is the
  // fact the paragraph describes, and the card already receives it.
  const branchDiscardOffered =
    archiveDisclosure?.branch != null &&
    p.options.some((o) => o.kind === "archive_task" && o.deleteBranch === true);

  // E4: the reason the Confirm button can't be pressed. It used to live ONLY in
  // `title` on a `disabled` button — the one place a browser guarantees nobody
  // will ever read it: no hover, no focus, and out of the a11y tree entirely.
  // The option radios in this same file already knew better (`aria-disabled`,
  // whose titles DO reach a pointer). So the button stays reachable via
  // `aria-disabled`, refuses the click itself, and the reason renders as the
  // `.deny-note` the sheet defines for exactly this — visible to a sighted
  // keyboard user and announced via `aria-describedby` to a screen reader.
  const selected = customSelected ? undefined : p.options[sel];
  // The one place the card reads its own authority flags. Every refusal below —
  // the selected option's, each row's, and the every-option scan — comes back
  // through `gateFor`, so a kind cannot be gated on one surface and open on
  // another (V16).
  const grants: PacketTierGrants = {
    canResolveCompletion,
    canEditGoal,
    canArchive,
    canDiscardBranch,
    canForceAccept,
    canMoveStage,
  };
  /** The gate a kind TRIPS, or null when this viewer holds its tier (or it has
   *  no tier at all: `custom`, `request_edit`, the rest). */
  const gateFor = (kind: PacketOptionKind): PacketTierGate | null => {
    const gate = PACKET_TIER_GATES.get(kind);
    return gate && !gate.held(grants) ? gate : null;
  };
  // accept_completion is maintainer+ OR this task's own owner (R6-2, widened by
  // R14-2); anyone else gets a server 403, so block the button while it's
  // selected rather than let them click into one. UI-42 gave `edit_goal` the
  // same treatment (`update-goal` is admin|maintainer, so resolving it without
  // that grant leaves the packet open with no way to type the new goal), and
  // R14-3 / F20-6 / F31-6 the three that touch a branch.
  const selectedGate = selected ? gateFor(selected.kind) : null;
  const blockReason = selectedGate?.denyNote ?? null;
  // Ruling 478(e): the two refusals a Confirm can meet before any request.
  // Both clear the moment the person does what they name.
  const noChoice = sel < 0;
  const needsReply = selected?.reply === true;
  const choiceInvalid = refused > 0 && noChoice;
  const replyInvalid = refused > 0 && needsReply && note.trim() === "";
  // Roving tabindex: with nothing chosen yet, the first choice is the group's
  // one tab stop (APG radio group).
  const tabStop = noChoice ? 0 : sel;
  // F20-17/F20-18: is EVERY option above this viewer's tier? Only meaningful
  // when they can resolve at all (a contributor-OWNER — the owner exception let
  // them open the card, but each option re-checks a higher tier). A single
  // un-gated option (custom / request_edit / …) means they are not stranded.
  const everyOptionForbidden =
    canResolve &&
    p.options.length > 0 &&
    p.options.every((o) => gateFor(o.kind) !== null);

  // The open ask-first ceremony, chosen by the pending option's own `kind`. The
  // list is re-read every render rather than captured at click time, so a packet
  // replaced underneath an open dialog re-derives it (or drops it) instead of
  // leaving a ceremony describing an option that is gone.
  const pendingOption =
    pendingConfirm === null ? undefined : p.options[pendingConfirm];
  const cancelConfirm = () => setPendingConfirm(null);
  const commitConfirm = () => {
    if (pendingConfirm === null) return;
    // No setPendingConfirm(null): the dialog plays its exit, then
    // cancelConfirm clears it (ruling 459).
    onResolve(pendingConfirm, note);
  };

  // UI-44: roving tabindex + real focus movement. Every `role="radio"` used to
  // stay tabbable and the arrow handler only changed `sel`, so DOM focus stayed
  // on the previously focused radio while `aria-checked` moved elsewhere — a
  // screen-reader user got no feedback from the app's highest-stakes control,
  // and Tab walked every option.
  const move = (delta: number) => {
    if (choiceCount === 0) return;
    // Keep the focus side effect out of the state updater — updaters can run
    // more than once, which would schedule the frame twice. `sel` is current
    // here (this only runs from a keydown handler), matching the click path at
    // the option buttons below.
    // Ruling 478(e): with nothing chosen, an arrow moves from the choice that
    // has focus (the group's tab stop), or enters the list at its nearest end.
    const from =
      sel >= 0 ? sel : optionRefs.current.findIndex((el) => el === document.activeElement);
    const next =
      from < 0
        ? delta > 0
          ? 0
          : choiceCount - 1
        : (from + delta + choiceCount) % choiceCount;
    selectOption(next);
    requestAnimationFrame(() => optionRefs.current[next]?.focus());
  };

  // Ruling 138: a decided `edit_goal` packet reads as decided after a reload —
  // the chosen option locked, no Confirm, and one control that opens the goal
  // editor exactly as the confirm did. A packet stamped `awaiting` before the
  // decision was recorded renders nothing special.
  const decided = p.awaiting === "goal_edit" ? p.decided : undefined;
  if (decided) {
    const chosen = p.options[decided.optionIndex];
    // F35-6: the draft is the mapping's one `goalDraft` (composed by
    // `goalDraftForOption` on the chosen option, `mapPacket`), rendered here
    // so a person who reloads SEES the requested goal, and handed to the
    // editor unchanged so both doors open the same text.
    const draft = p.goalDraft;
    return (
      <div className={"packet " + (isBlocked ? "blocked" : "input")} data-decided="">
        <PacketHead kind={p.kind} from={p.from} blocked={isBlocked} />
        <div className="packet-body">
          <h2>{p.title}</h2>
          <PacketBody text={p.body} />
          <div className="options" data-decided="">
            {p.options.map((o, i) => (
              <button
                key={i}
                type="button"
                disabled
                aria-disabled="true"
                className={"opt" + (i === decided.optionIndex ? " sel" : "")}
                data-chosen={i === decided.optionIndex ? "" : undefined}
              >
                <OptionKey index={i} />
                <span>
                  {/* U39-21: an option is written like the body, with `code`. */}
                  <div className="ot">{renderInlineCode(o.t)}</div>
                  <div className="od">{renderInlineCode(o.d)}</div>
                </span>
                {i === decided.optionIndex && (
                  <span className="rec-tag">
                    <Pill kind="info" sm>
                      chosen
                    </Pill>
                  </span>
                )}
              </button>
            ))}
          </div>
          <p className="deny-note spaced" data-decided-note="">
            <Icon name="check" />
            Decision made · save the edited goal to clear this packet
          </p>
          {draft && (
            <figure className="goal-draft">
              <figcaption className="fine xs dim">
                Requested goal (opens in the editor)
              </figcaption>
              <pre className="goal-draft-text">{draft}</pre>
            </figure>
          )}
          <div className="packet-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={onAsk}
              title="Starts a comment mentioning @operator below. Send it to pull the operator in"
            >
              <Icon name="message" />
              Ask operator
            </button>
            {canEditGoal && chosen && draft && onEditGoal && (
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => onEditGoal(draft)}
              >
                Edit the goal
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={"packet " + (isBlocked ? "blocked" : "input")}>
      <PacketHead kind={p.kind} from={p.from} blocked={isBlocked} />
      <div className="packet-body">
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

        <div
          className="options"
          role="radiogroup"
          aria-label="Decision options"
          aria-invalid={choiceInvalid || undefined}
          aria-describedby={choiceInvalid ? CHOICE_ERR_ID : undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            } else if (/^[1-9]$/.test(e.key)) {
              // Questionnaire shortcut: a digit jumps to that choice (the
              // chips on each row advertise the mapping). Fires only inside
              // the radiogroup — the directive textarea lives outside it.
              const target = Number(e.key) - 1;
              if (target < choiceCount) {
                e.preventDefault();
                selectOption(target);
                requestAnimationFrame(() => optionRefs.current[target]?.focus());
              }
            }
          }}
        >
          {p.options.map((o, i) => {
            // UI-42 / R14-3 / F20-6 / F31-6: an option the viewer cannot carry
            // out is inert and says why, instead of recording a decision that
            // dead-ends at the server's own re-check (LV-08 — no control that
            // only exists to 403).
            const refusal = gateFor(o.kind)?.option ?? null;
            // F20-17: a viewer who cannot resolve this packet at ALL used to see
            // every option fully interactive with no Confirm and no reason — the
            // un-gated ones read as "yours". Mark them all inert; the one
            // card-level deny note below names who can decide.
            const blocked = refusal !== null || !canResolve;
            return (
              <button
                key={i}
                type="button"
                role="radio"
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                aria-checked={sel === i}
                // Ruling 459: `aria-disabled` alone dims a blocked option and
                // stills its hover and press (`.opt[aria-disabled="true"]`
                // in app.css); the inline .55 it wore is gone.
                aria-disabled={blocked || undefined}
                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                tabIndex={tabStop === i ? 0 : -1}
                className={
                  "opt" + (sel === i ? " sel" : "") + (o.rec ? " recommend" : "")
                }
                title={refusal?.title}
                onClick={() => {
                  if (blocked) return;
                  selectOption(i);
                }}
              >
                <OptionKey index={i} />
                <span>
                  {/* U39-21: an option is written like the body, with `code`,
                      and printed its backticks ("It answered this on
                      \`7920943\` in this streak"). */}
                  <div className="ot">{renderInlineCode(o.t)}</div>
                  {/* The refusal belongs in the DESCRIPTION, not only in the
                      `title`: a title needs a pointer, and a keyboard or touch
                      user reading a dimmed option has nothing else to go on. */}
                  <div className="od">
                    {renderInlineCode(o.d)}
                    {refusal ? refusal.note : ""}
                  </div>
                  {/* Ruling 269: a create_task option writes a NEW task, and
                    until it is confirmed that task exists only inside the
                    option's payload. Show what is about to be created — the
                    title and the goal it will be worked to — so the person is
                    confirming the task rather than the sentence describing it.
                    Selected only: unselected, four options each carrying a
                    goal would bury the choice. */}
                  {o.kind === "create_task" && o.newTask && sel === i && (
                    <span className="od pkt-new-task">
                      <strong>Creates {o.newTask.title}</strong>
                      {/* A task goal is a contract, and a good one runs to
                          paragraphs — it scrolls in place rather than pushing
                          the other choices off the card. */}
                      <span className="fine pkt-new-task-goal">{o.newTask.goal}</span>
                      {o.newTask.blockedBy && o.newTask.blockedBy.length > 0 && (
                        <span className="fine dim">
                          waits on {o.newTask.blockedBy.join(", ")}
                        </span>
                      )}
                      {/* Ruling 287: confirming this option also edits tasks
                          that are NOT on this page — it adds the new key to
                          each of these tasks' own waits. That is the one part
                          of a create_task decision a person cannot see the
                          consequence of anywhere else, so it is shown before
                          the confirm rather than discovered on another board
                          card afterwards. */}
                      {o.newTask.blocks && o.newTask.blocks.length > 0 && (
                        <span className="fine dim">
                          {o.newTask.blocks.join(", ")} will wait on it
                        </span>
                      )}
                    </span>
                  )}
                </span>
                {/* The destructive half of archive_task is loud: this option
                    doesn't just file the task away, it deletes the remote
                    branch. */}
                {o.kind === "archive_task" && o.deleteBranch && (
                  <span className="rec-tag">
                    <Pill kind="blocked" sm>
                      deletes branch
                    </Pill>
                  </span>
                )}
                {o.rec && (
                  <span className="rec-tag">
                    {/* N20-16: attribute the recommendation to whoever RAISED
                        the packet — "operator pick" was printed on a developer's
                        own ask_human question, crediting the operator for a rec
                        the developer made. */}
                    <Pill kind="info" sm>
                      {authoredByOperator ? "operator pick" : "recommended"}
                    </Pill>
                  </span>
                )}
              </button>
            );
          })}
          {customOffered && (
            // The questionnaire's composed free-text choice: an answer in the
            // human's own words, resolved server-side as the un-gated `custom`
            // kind. Its input renders below the group when selected.
            <button
              type="button"
              role="radio"
              ref={(el) => {
                optionRefs.current[customIndex] = el;
              }}
              aria-checked={customSelected}
              aria-keyshortcuts={customIndex < 9 ? String(customIndex + 1) : undefined}
              tabIndex={tabStop === customIndex ? 0 : -1}
              className={"opt opt-custom" + (customSelected ? " sel" : "")}
              onClick={() => selectOption(customIndex)}
            >
              <OptionKey index={customIndex} />
              <span>
                {/* Ruling 478(e) (F40-31): on an agent's question the words go
                    back to that agent (`resolvePacket`), not to the operator.
                    The title stays: the controller's briefing names this
                    choice by it. */}
                <div className="ot">Write your own directive</div>
                <div className="od">
                  {answerTo
                    ? `Answer in your own words. It goes back to ${answerTo}, which carries on from where it stopped.`
                    : "Answer in your own words. The operator re-engages with exactly what you type."}
                </div>
              </span>
            </button>
          )}
        </div>

        {choiceInvalid && (
          // Ruling 478(e) under ruling 147: a Confirm with nothing chosen is
          // refused here, a fresh alert per press, focus on the first choice.
          <p
            key={`choice-${refused}`}
            id={CHOICE_ERR_ID}
            className={"deny-note spaced" + (refusalShake.shake ? " refused" : "")}
            onAnimationEnd={refusalShake.onAnimationEnd}
            role="alert"
          >
            <Icon name="alert" />
            Choose an answer above first.
          </p>
        )}

        {customSelected && (
          <div className="field packet-note-field">
            <label className="flabel" htmlFor="pkt-custom">
              Your directive<span className="req">*</span>
              <span className="fhint">
                resolves this decision ·{" "}
                {answerTo ? `goes back to ${answerTo}` : "handed to the operator"}
              </span>
            </label>
            <textarea
              id="pkt-custom"
              ref={customRef}
              className="packet-note"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              aria-invalid={customInvalid || undefined}
              aria-describedby={customInvalid ? CUSTOM_ERR_ID : undefined}
              // Ruling 291: the placeholder is Viberr TEACHING what a good
              // directive looks like, at the moment a person is writing one —
              // so it must not model the operation the product forbids. It
              // used to model the very operation the product forbids.
              placeholder="e.g. Hold the merge, bring the branch up to date with main first, and re-run the reviewer on the new head."
              rows={2}
              data-autofocus=""
            />
            {customInvalid && (
              <p
                key={`refused-${refused}`}
                id={CUSTOM_ERR_ID}
                className={"deny-note spaced" + (refusalShake.shake ? " refused" : "")}
                onAnimationEnd={refusalShake.onAnimationEnd}
                role="alert"
              >
                <Icon name="alert" />
                Write the directive first.
              </p>
            )}
          </div>
        )}

        {canResolve && branchDiscardOffered && (
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

        {canResolve && !customSelected && (
          // The one input on the app's highest-stakes card wears the same
          // form language as every other input: `.field` + uppercase label +
          // hint (owner feedback 2026-07-26 — it was a bare textarea outside
          // `.field`, so none of the border/focus/typography tokens applied).
          // Hidden while the custom choice is selected: the directive IS the
          // message, and two competing textareas would ask which one counts.
          <div className="field packet-note-field">
            <label className="flabel" htmlFor="pkt-note">
              {/* Ruling 478(e) (F40-31): on an agent's question this box is the
                  person's answer to THAT agent, which `resolvePacket` sends it
                  back to. "Note for the operator · optional" told them their
                  reply was a side note for someone else, and a note that named
                  the operator, as the label invited, re-routed the answer away
                  from the agent that asked (ruling 447). */}
              {answerTo ? `Your answer to ${answerTo}` : "Note for the operator"}
              {needsReply && <span className="req">*</span>}
              <span className="fhint">
                {/* Ruling 315: the length is stated BEFORE it matters. The route
                    used to cut this to 2,000 characters with nothing on the box
                    saying so, and the server now refuses instead — a refusal a
                    person could not see coming is a worse trade than the cut it
                    replaced unless the box says the number. */}
                {needsReply ? "required" : "optional"} ·{" "}
                {answerTo ? `goes back to ${answerTo} with your choice` : "recorded on the decision"} ·{" "}
                {PACKET_NOTE_MAX.toLocaleString("en-US")} characters max
              </span>
            </label>
            <textarea
              id="pkt-note"
              ref={noteRef}
              className="packet-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={replyInvalid || undefined}
              aria-describedby={replyInvalid ? REPLY_ERR_ID : undefined}
              // U39-7: this box sits under every packet, and "before
              // reopening" fitted only the closed-pull-request one.
              placeholder={
                answerTo
                  ? needsReply
                    ? "e.g. what it asked for, exactly as you see it"
                    : `e.g. anything ${answerTo} should also know`
                  : "e.g. anything the operator should also know"
              }
              rows={1}
              // The browser stops the paste at the cap rather than letting the
              // server refuse a confirm the person has already committed to.
              maxLength={PACKET_NOTE_MAX}
            />
            {replyInvalid && (
              <p
                key={`reply-${refused}`}
                id={REPLY_ERR_ID}
                className={"deny-note spaced" + (refusalShake.shake ? " refused" : "")}
                onAnimationEnd={refusalShake.onAnimationEnd}
                role="alert"
              >
                <Icon name="alert" />
                {answerTo ? `Write your answer to ${answerTo} first.` : "Write your answer first."}
              </p>
            )}
            {note.length > PACKET_NOTE_MAX - 200 && (
              <p className="fine xs dim">
                {note.length.toLocaleString("en-US")} of{" "}
                {PACKET_NOTE_MAX.toLocaleString("en-US")} characters.
              </p>
            )}
          </div>
        )}

        {/* Ruling 324: the echoes of the SELECTED option, under the choice they
            are about. Silent when the selection creates nothing, and silent
            when nothing on the board resembles it — a disclosure a person
            learns to skip is worse than no disclosure. */}
        {(createTaskEchoes[sel] ?? []).length > 0 && (
          <div className="deny-note spaced" data-create-task-echoes={sel}>
            <Icon name="board" />
            <span>
              This project already has{" "}
              {(createTaskEchoes[sel] ?? []).length === 1 ? "a task" : "tasks"} that look like
              this:{" "}
              {(createTaskEchoes[sel] ?? []).map((t, i, all) => (
                <span key={t.key}>
                  <strong>{t.key}</strong> &ldquo;{t.title}&rdquo; ({t.stage})
                  {i < all.length - 1 ? ", " : ""}
                </span>
              ))}
              . Confirming still creates a new one &mdash; check it is not a second owner for
              work one of these already holds.
            </span>
          </div>
        )}

        {canResolve && blockReason && (
          <p className="deny-note spaced" id={BLOCK_REASON_ID}>
            <Icon name="lock" />
            {blockReason}
          </p>
        )}

        {/* F20-17: the viewer cannot resolve this packet at all — say who can,
            once, instead of leaving a live-looking radiogroup with no Confirm. */}
        {!canResolve && (
          <p className="deny-note spaced">
            <Icon name="lock" />
            You can&rsquo;t resolve this decision: a maintainer, an admin, or
            this task&rsquo;s owner can. You can still comment or ask the operator
            below.
          </p>
        )}

        {/* F20-18: a contributor-OWNER may open this card (owner exception) but
            EVERY option re-checks a higher tier, so there is nothing they can
            settle. Name that, and hand the decision UP to a maintainer instead
            of leaving them stranded (server: requestPacketMaintainerDecision). */}
        {everyOptionForbidden && (
          <div className="deny-note spaced">
            <Icon name="lock" />
            <span>
              Every listed option needs maintainer or admin authority. You own{" "}
              {archiveDisclosure?.taskKey ?? "this task"} and raised this
              decision, but settling it with one of them is above your role. You
              can still answer with your own directive above.
              {onRequestMaintainer && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy || escalating}
                    aria-busy={escalating || undefined}
                    onClick={onRequestMaintainer}
                  >
                    <GlyphSwap rest="message" alt="loader" on={escalating} spinAlt />
                    {escalating ? "Sending…" : "Send to a maintainer"}
                  </button>
                </>
              )}
            </span>
          </div>
        )}

        <div className="packet-actions">
          {/* N20-15: not inert — drops `@operator` into the comment composer
              below and focuses it; sending that comment starts a real operator
              run (the mention path). The title says so, because a click that
              only scrolls to an already-focused composer looked like a no-op.
              Open to everyone, resolver or not (commenting is app-wide).
              FIRST in the row: actions end on the primary commit (flex-end). */}
          <button
            type="button"
            className="btn ghost"
            onClick={onAsk}
            title="Starts a comment mentioning @operator below. Send it to pull the operator in"
          >
            <Icon name="message" />
            Ask operator
          </button>
          {canResolve && (
            <button
              type="button"
              className="btn primary"
              // Ruling 147: only a request in flight is a real `disabled` here.
              // An empty directive is REFUSED below instead, in a sentence; a
              // ROLE refusal stays focusable so its reason is reachable. The
              // sheet dims it (`.btn[aria-disabled="true"]`, ruling 459) and
              // keeps it from hovering or pressing like a live button.
              disabled={busy}
              aria-disabled={blockReason !== null || undefined}
              aria-describedby={blockReason ? BLOCK_REASON_ID : undefined}
              aria-busy={busy}
              // F17-L8: the visible label stays concise (echoing a multi-line
              // option title overflowed the flex button — F-UI1), but the
              // accessible name states WHAT is being confirmed, so a screen-reader
              // user hears the chosen option, not a bare "Confirm decision".
              aria-label={
                selected
                  ? `Confirm decision: ${selected.t}`
                  : customSelected
                    ? "Confirm decision: your custom directive"
                    : "Confirm decision"
              }
              onClick={() => {
                if (blockReason) return;
                // The custom choice resolves with the typed directive — it
                // never accepts, archives or merges, so no ceremony interposes.
                if (customSelected) {
                  if (customText.trim()) {
                    onResolveCustom(customText);
                  } else {
                    // Ruling 147: refuse in place, name the field, and never
                    // let the attempt become a request.
                    setRefused((n) => n + 1);
                    customRef.current?.focus();
                  }
                  return;
                }
                // Ruling 478(e) under ruling 147: nothing chosen, or a choice
                // the asking agent marked as needing a typed answer with the
                // box still empty, is refused in place: the alert names it and
                // focus lands where the person must act. Never a request.
                if (noChoice) {
                  setRefused((n) => n + 1);
                  optionRefs.current[tabStop]?.focus();
                  return;
                }
                if (needsReply && note.trim() === "") {
                  setRefused((n) => n + 1);
                  noteRef.current?.focus();
                  return;
                }
                // The packet's one-way halves ask first (rulings 20/53), each
                // through its own ceremony below. They used to commit from this
                // generic "Confirm decision" while the *reversible* Archive
                // button beside them asked.
                if (selected && CONFIRM_FIRST_KINDS.has(selected.kind)) {
                  setPendingConfirm(sel);
                  return;
                }
                onResolve(sel, note);
              }}
            >
              <Icon name="check" />
              {/* A concise, stable label — echoing the full (often multi-line)
                  option title here overflowed the flex button and rendered the
                  text overlapping itself (F-UI1). The chosen option is already
                  highlighted in the radiogroup above, and the accessible name
                  (aria-label) states the selection for non-visual users. */}
              Confirm decision
            </button>
          )}
        </div>
      </div>

      {pendingOption?.kind === "archive_task" && (
        <PacketArchiveConfirm
          option={pendingOption}
          packetTitle={p.title}
          {...(archiveDisclosure ? { disclosure: archiveDisclosure } : {})}
          busy={busy}
          onCancel={cancelConfirm}
          onConfirm={commitConfirm}
        />
      )}

      {pendingOption?.kind === "discard_branch" && (
        <PacketDiscardConfirm
          option={pendingOption}
          branch={archiveDisclosure?.branch ?? null}
          busy={busy}
          onCancel={cancelConfirm}
          onConfirm={commitConfirm}
        />
      )}

      {pendingOption?.kind === "resolve_remote_collision" && (
        <PacketCollisionConfirm
          option={pendingOption}
          branch={archiveDisclosure?.branch ?? null}
          unownedPr={archiveDisclosure?.unownedPr ?? null}
          openPr={archiveDisclosure?.openPr ?? null}
          busy={busy}
          onCancel={cancelConfirm}
          onConfirm={commitConfirm}
        />
      )}
    </div>
  );
}
