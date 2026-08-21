import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { useDismiss } from "~/ui/use-dismiss";
import { type ProjectRole, roleCan } from "~/shared/rbac";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { Avatar } from "~/ui/avatar";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill } from "~/ui/pill";

/** Client-safe view of a deployed specialist the assign menu offers (mirrors
 * the loader's DeployedSpecialistView — kept here to avoid a server import). */
export interface DeployedSpecialistView {
  id: string;
  name: string;
  role: string;
  backend: "codex" | "claude";
  model: string;
  /**
   * UI-39: the loader has always shipped these (specialist-run.server.ts builds
   * them from the deployment's real capability grants) and the client type
   * simply didn't declare them — so "Assign delivering agent" offered agents
   * with NO repo-write grant (the run starts, streams, and delivers nothing),
   * and the reviewer menu gave no hint which reviewers actually gate acceptance.
   */
  capabilities?: {
    /** Holds a repo-write grant in `direct` mode — can own branch/PR delivery. */
    delivery: boolean;
    /** Holds `report-validation-verdict` — its verdict gates acceptance. */
    verdict: boolean;
    /** May raise ask-human question packets. */
    askHuman: boolean;
    /** D8/R19-19: holds `use-browser` — its runs save screenshots/downloads into
     *  the task's `attachments/`, so the attachments panel is meaningful even
     *  before any file lands. */
    browser: boolean;
  };
}

/**
 * Execution profile panel + OwnerControl — 1:1 port of task.jsx §4.3/§4.4.
 *
 * Deviations from the mock (documented in the phase report):
 *   - all identity comparisons are by user id (ruling 6), never name;
 *   - members come from the layout loader, not window.VIBERR.policy.members
 *     (project.md membership has no status field — every member is active);
 *   - the "operator active" head pill renders only when an operator is
 *     actually attached (mock showed it unconditionally; real runtime state
 *     drives it now);
 *   - Manage menu closes on Escape too (spec §4.4 port note).
 */

export type OwnerAction = "take" | "assign" | "release";

/**
 * UC-13 — what the engagements cell is actually holding. "Reviewing agents"
 * unless EVERY engaged agent is known to hold no verdict capability, in which
 * case they are supporting the work, not gating it.
 */
export function reviewingAgentsLabel(
  engaged: readonly { profileId: string }[],
  deployed: readonly DeployedSpecialistView[],
): "Reviewing agents" | "Supporting agents" {
  if (engaged.length === 0) return "Reviewing agents";
  const allSupporting = engaged.every((e) => {
    const profile = deployed.find((s) => s.id === e.profileId);
    return profile?.capabilities?.verdict === false;
  });
  return allSupporting ? "Supporting agents" : "Reviewing agents";
}

/**
 * The vocabulary the whole engagements cell speaks.
 *
 * UX19-4: UC-13 renamed the cell heading to "Supporting agents" when nothing
 * engaged holds a verdict grant, and stopped there — every control inside kept
 * saying "reviewer". The add button read "Engage reviewer", its panel was
 * labelled "Engage a reviewer", the release control "Release reviewer", and the
 * empty state flatly contradicted the heading: a cell headed "Supporting
 * agents" also said *"All deployed agents are already reviewing."* "Supporting
 * agents" is the only place in the product that uses that word, so the reader
 * had no way to map it back to any control on the page.
 *
 * One predicate, one vocabulary: the heading and the verbs are derived together
 * and passed down, so they cannot drift apart again.
 */
export interface EngagementVocabulary {
  heading: "Reviewing agents" | "Supporting agents";
  /** The add button's label. */
  add: string;
  /** The add panel's aria-label. */
  panel: string;
  /** Empty state inside the add panel. */
  allEngaged: string;
  /** What the cell says instead of the add control on a closed task. */
  closed: string;
  /** The release (×) control's tooltip. */
  release: string;
  /** The release (×) control's aria-label, per engagement. */
  releaseOf: (role: string) => string;
}

export function engagementVocabulary(
  engaged: readonly { profileId: string }[],
  deployed: readonly DeployedSpecialistView[],
): EngagementVocabulary {
  const heading = reviewingAgentsLabel(engaged, deployed);
  return heading === "Supporting agents"
    ? {
        heading,
        add: "Engage agent",
        panel: "Engage an agent",
        allEngaged: "All deployed agents are already engaged.",
        closed: "Task closed. No new engagements.",
        release: "Release agent",
        releaseOf: (role) => `Release ${role} agent`,
      }
    : {
        heading,
        add: "Engage reviewer",
        panel: "Engage a reviewer",
        allEngaged: "All deployed agents are already reviewing.",
        closed: "Task closed. No new reviewer engagements.",
        release: "Release reviewer",
        releaseOf: (role) => `Release ${role} reviewer`,
      };
}

/**
 * UX19-12 — an engagement whose profile is no longer deployed.
 *
 * The name is the Agents live table's own wording (`agents-page.tsx:927`), used
 * verbatim so one state does not read two ways on two surfaces, and the note
 * states the consequence R15-7 (ruling 26) imposes on such a run: it may read
 * and validate, and it is withheld from delivering, commenting, asking or
 * recording evidence. It is rendered copy, not a `title`, because the control it
 * explains is DISABLED — the P14 ruling this file already applies to the closed
 * operator control (`:513-519`).
 */
const GHOST_NAME = "profile no longer here";
const GHOST_DELIVERING_NOTE =
  "Not deployed on this project any more. A run would start and produce no branch, PR, comment or verdict.";
const GHOST_REVIEWING_NOTE =
  "Not deployed on this project any more. A run would start and record no verdict, comment or evidence.";

/**
 * UX19-18 — the keyboard contract for this panel's three popovers.
 *
 * "Manage" (ownership), "Assign delivering agent" and "Engage reviewer" all
 * declared `role="menu"` with `role="menuitem"` children and implemented none
 * of what those roles promise: no Arrow/Home/End traversal, and no focus
 * management, so activating an item (or Escape) unmounted the focused element
 * and dropped the keyboard user at `<body>` mid-workflow.
 *
 * The product has already ruled on this exact shape twice, in opposite but
 * equally acceptable directions: implement the contract (`ui/stage-menu.tsx`,
 * `project-settings/settings-page.tsx`) or DROP the roles (`shell/user-menu.tsx`,
 * UI-45). These three take UI-45's path for UI-45's reason — they are small
 * groups of buttons interleaved with group labels, separators and a disabled
 * empty-state line, and plain Tab order is a contract the code actually
 * honours. What the roles were papering over is fixed either way: focus moves
 * into the panel on open, and Escape or picking an item returns it to the
 * trigger (F10-25's rule, which `stage-menu.tsx:90-95` states).
 */
function usePopoverFocus(open: boolean, setOpen: (open: boolean) => void) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The shared dismiss hook still owns outside-press and document-level Escape.
  // It deliberately does NOT reclaim focus: on an outside press the press
  // itself decides where focus lands, and stealing it back to the trigger would
  // fight the user.
  const wrapRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const closeAndReturnFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Escape from anywhere inside the popover (the trigger included — the handler
  // sits on the wrapper both live in).
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    closeAndReturnFocus();
  };

  return { wrapRef, triggerRef, panelRef, closeAndReturnFocus, onKeyDown };
}

export interface TaskMemberView {
  userId: string;
  role: string;
  user: { name: string; initials?: string | null; tone?: string | null };
}

function OwnerControl({
  task,
  myRole,
  busy,
  onOwner,
}: {
  task: TaskSummary;
  myRole: string | null;
  busy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
}) {
  const o = task.owner && task.owner.kind === "human" ? task.owner : null;
  // Q5 tiering (XS-12): only contributor+ may take ownership — a viewer is
  // read + comment only, so its take button would just 403. Gate the control
  // the same way the server does rather than render a button that fails.
  //
  // SAFETY: `myRole` is the project layout loader's own value (routes/project.tsx
  // — `project_members.role`, which 0001_baseline CHECK-constrains to exactly the
  // four project roles, or "admin" for the org-admin override, or null); the prop
  // chain down to here is what widens it to `string`. `roleCan` denies any value
  // outside the four regardless, so the widening can only ever under-grant.
  const canOwn = roleCan(myRole as ProjectRole | null, "own-task");

  if (!o) {
    // Only contributor+ may take ownership (Q5) — hide from viewers/non-members.
    // F19-11: the eligibility sentence now lives in the cell's VALUE (it was
    // the half that misdescribed the matrix), stated once for every role — so
    // this control renders the affordance or nothing, never a second copy.
    return canOwn ? (
      <button
        type="button"
        className="rev-add"
        disabled={busy}
        onClick={() => onOwner("take")}
        title="Take ownership: review & acceptance, this task only"
      >
        <Icon name="plus" />
        Assign me
      </button>
    ) : null;
  }

  // OWNED: the cell shows the owner chip alone (owner request 2026-08-21) —
  // the Manage popover (take-over / hand-off / release) is gone. Release stays
  // one panel away on the Current-state Owner row (`own-x`, self or the
  // release-any-ownership tier), and a hand-off is release + take. The chip
  // itself is rendered by the cell beside this control.
  return null;
}

/**
 * Assign-specialist affordance — mirrors OwnerControl's menu (spec §4.4): a
 * button opening a menu that lists the project's deployed specialists by
 * name/role/backend-glyph; picking one submits the `assign-specialist` intent.
 * When the project has zero deployed specialists, a hint links to the Agents
 * page. Only rendered for admin|maintainer (the caller gates on canRunAgents).
 */
function SpecialistControl({
  projectSlug,
  specialists,
  busy,
  closed = false,
  onAssign,
}: {
  projectSlug: string;
  specialists: DeployedSpecialistView[];
  busy: boolean;
  /** G9/P14-WL-07: the task is at the terminal stage. */
  closed?: boolean;
  onAssign: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { wrapRef, triggerRef, panelRef, closeAndReturnFocus, onKeyDown } =
    usePopoverFocus(open, setOpen);

  // P14-WL-07: G9 disabled the RUN buttons on a closed task but left the two
  // engage menus fully live, so a Done+merged task still offered to assign a
  // delivering agent — an engagement that lands and then has nothing to run.
  if (closed) {
    return (
      <span className="sub">
        Task closed. Reopen it from Current state to assign a delivering agent.
      </span>
    );
  }

  if (specialists.length === 0) {
    return (
      <span className="sub">
        No agents deployed.{" "}
        <Link to={`/projects/${projectSlug}/agents`}>Deploy one on the Agents page</Link>
        .
      </span>
    );
  }

  return (
    <div className="own-wrap" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className={"own-btn" + (open ? " open" : "")}
        disabled={busy}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Assign delivering agent
        <Icon name="chevron" />
      </button>
      {open && (
        <div
          className="own-menu"
          ref={panelRef}
          tabIndex={-1}
          aria-label="Assign a delivering agent"
        >
          <div className="own-lbl">Deployed agents</div>
          {/* UI-39: an agent with no repo-write grant cannot deliver — its run
              starts, streams, and produces no branch or PR. Say so on the chip
              rather than silently offering a dead end. */}
          {specialists.map((s) => {
            const cannotDeliver = s.capabilities?.delivery === false;
            return (
              <button
                type="button"
                className="menu-item"
                key={s.id}
                title={
                  cannotDeliver
                    ? `${s.name} has no repo-write grant. It can analyse and comment, but it can't produce a branch or PR. Grant one on the Agents page.`
                    : undefined
                }
                onClick={() => {
                  closeAndReturnFocus();
                  onAssign(s.id);
                }}
              >
                <AgentGlyph backend={s.backend} />
                {s.name}
                <span className="own-role">
                  {s.role}
                  {cannotDeliver ? " · no repo write" : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Assign-reviewer affordance — the reviewer counterpart of SpecialistControl.
 * Offers the deployed specialists NOT already engaged as reviewers on this
 * task; picking one submits `assign-reviewer`. When every deployed specialist
 * is already a reviewer the menu says so; when none are deployed it links to
 * the Agents page. Only rendered for admin|maintainer (caller gates).
 *
 * UX19-4: every string here comes from the cell's own `EngagementVocabulary`,
 * so the control never says "reviewer" under a heading that says "Supporting
 * agents" — one predicate decides for the whole cell.
 */
function ReviewerControl({
  projectSlug,
  specialists,
  hasAnyDeployed,
  busy,
  closed = false,
  vocab,
  onAssign,
}: {
  projectSlug: string;
  /** Deployed specialists available to add (already-engaged ones filtered out). */
  specialists: DeployedSpecialistView[];
  /** Whether the project has any deployed specialist at all (empty-state copy). */
  hasAnyDeployed: boolean;
  busy: boolean;
  /** G9/P14-WL-07: the task is at the terminal stage. */
  closed?: boolean;
  /** The vocabulary the whole engagements cell speaks (UX19-4). */
  vocab: EngagementVocabulary;
  onAssign: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { wrapRef, triggerRef, panelRef, closeAndReturnFocus, onKeyDown } =
    usePopoverFocus(open, setOpen);

  // P14-WL-07: same reason as SpecialistControl — a closed task must not offer
  // to engage a reviewer whose Run button would then render disabled.
  if (closed) {
    return <span className="sub">{vocab.closed}</span>;
  }

  if (!hasAnyDeployed) {
    return (
      <span className="sub">
        No agents deployed.{" "}
        <Link to={`/projects/${projectSlug}/agents`}>Deploy one on the Agents page</Link>
        .
      </span>
    );
  }

  return (
    <div className="own-wrap" ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className={"rev-add" + (open ? " open" : "")}
        disabled={busy}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="plus" />
        {vocab.add}
      </button>
      {open && (
        <div
          className="own-menu"
          ref={panelRef}
          tabIndex={-1}
          aria-label={vocab.panel}
        >
          <div className="own-lbl">Deployed agents</div>
          {specialists.length === 0 ? (
            <div className="menu-item" aria-disabled>
              <span className="sub">{vocab.allEngaged}</span>
            </div>
          ) : (
            // UI-39: badge the reviewers whose verdict actually GATES
            // acceptance (`report-validation-verdict`, snapshotted at engage
            // time) — the menu gave no way to tell them apart.
            specialists.map((s) => (
              <button
                type="button"
                className="menu-item"
                key={s.id}
                title={
                  s.capabilities?.verdict
                    ? `${s.name} reports validation verdicts. Engaging it makes its approval required before acceptance.`
                    : s.capabilities
                      ? `${s.name} has no verdict grant. It can review and comment, but its opinion does not gate acceptance.`
                      : undefined
                }
                onClick={() => {
                  closeAndReturnFocus();
                  onAssign(s.id);
                }}
              >
                <AgentGlyph backend={s.backend} />
                {s.name}
                <span className="own-role">
                  {s.role}
                  {s.capabilities?.verdict ? " · gates acceptance" : ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Operator run control — pick a backend (Claude Code / Codex) and an autonomy
 * level (supervised / full), then run the operator to coordinate the task.
 * Full autonomy lets the operator drive stages and accept completion itself;
 * supervised has it recommend at governed boundaries. Server re-checks RBAC.
 */
function OperatorRunControl({
  busy,
  disabled,
  blockedReason,
  defaultBackend,
  configuredAutonomy,
  backendAvailable,
  onRun,
}: {
  busy: boolean;
  /** Task is closed (terminal stage) — controls render disabled (G9). */
  disabled?: boolean;
  /** F20-5 (R20-1): a non-structural reason the manual run is refused — an open
   *  decision packet pauses coordination, so `runOperator` returns
   *  `refused: "open-packet"` for a manual trigger and this button would be a
   *  paid no-op. The reason is rendered copy (a `title` never opens on a
   *  disabled control — the same P14 reason the closed state renders text). */
  blockedReason?: string;
  /** The operator profile's configured backend — the picker's default (P11-76). */
  defaultBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy — the CEILING a run may
   *  not exceed. The selector offers only what will actually run: a dropdown
   *  that lists an option the server silently clamps is the dishonest
   *  affordance this ruling exists to remove. */
  configuredAutonomy: "supervised" | "full";
  /** Which backends are configured — unavailable ones are disabled (P11-41). */
  backendAvailable: { claude: boolean; codex: boolean };
  onRun: (backend: string, autonomy: string) => void;
}) {
  // P11-41: default to the configured backend, but if it isn't actually
  // available fall back to one that is, so the picker never starts on an option
  // that would fail fast.
  const initialBackend =
    backendAvailable[defaultBackend]
      ? defaultBackend
      : backendAvailable.claude
        ? "claude"
        : backendAvailable.codex
          ? "codex"
          : defaultBackend;
  const [backend, setBackend] = useState<string>(initialBackend);
  const [autonomy, setAutonomy] = useState<string>(configuredAutonomy);
  // F20-5: an open decision packet is refused server-side just like a closed
  // task is, so it joins `disabled` in switching the control off.
  const off = busy || disabled || !!blockedReason;
  return (
    <span className="op-run">
      <select
        className="op-sel"
        aria-label="Operator backend"
        value={backend}
        onChange={(e) => setBackend(e.target.value)}
        disabled={off}
      >
        <option value="claude" disabled={!backendAvailable.claude}>
          Claude Code{backendAvailable.claude ? "" : " (not configured)"}
        </option>
        <option value="codex" disabled={!backendAvailable.codex}>
          Codex{backendAvailable.codex ? "" : " (not configured)"}
        </option>
      </select>
      <select
        className="op-sel"
        aria-label="Operator autonomy"
        value={autonomy}
        onChange={(e) => setAutonomy(e.target.value)}
        disabled={off}
      >
        <option value="supervised">Supervised</option>
        {configuredAutonomy === "full" && (
          <option value="full">Full autonomy</option>
        )}
      </select>
      {configuredAutonomy === "supervised" && (
        // Explain the option that is NOT there. An absent control with no
        // reason reads as a bug; naming the policy makes it a decision.
        <span className="sub xs dim">
          Project policy: supervised. Raise it on the operator profile.
        </span>
      )}
      {/* The operator coordinates ongoing work, so it stays runnable even while
          a specialist run streams — only its own in-flight run disables it.
          A closed (terminal-stage) task disables it too (G9). */}
      <button
        type="button"
        className="btn primary sm"
        disabled={off}
        onClick={() => onRun(backend, autonomy)}
        title={
          blockedReason ??
          (disabled
            ? "Task is closed (terminal stage). Reopen it to run the operator"
            : "Run the operator to coordinate this task")
        }
      >
        <Icon name="shield" />
        {busy ? "Running…" : "Run operator"}
      </button>
      {/* P14 ruling: a `title` is unreachable on a DISABLED control (no hover
          target for keyboard or touch), so the reason a control is dead has to
          be rendered copy — the reviewer panel already says this for its own
          closed state. F20-5's open-packet reason wins over the closed copy. */}
      {blockedReason ? (
        <span className="sub">{blockedReason}</span>
      ) : disabled ? (
        // N20-17: the explicit Run-operator button is off on a closed task, but
        // an @operator comment still starts a full operator run (the comment
        // handler dispatches on the mention) — say so, or the two run paths read
        // as silently inconsistent (one blocked, one open).
        <span className="sub">
          Task closed. Reopen it to run the operator. Mentioning{" "}
          <code>@operator</code> in a comment still runs it.
        </span>
      ) : null}
    </span>
  );
}

export function ExecutionProfile({
  task,
  meId,
  myRole,
  busy,
  onOwner,
  deployedSpecialists,
  operatorBackend,
  operatorAutonomy,
  backendAvailable,
  canRunAgents,
  deliveringActive,
  activeReviewerIds,
  runBusy,
  onAssignSpecialist,
  onRunSpecialist,
  reviewerBusy,
  onAssignReviewer,
  onRunReviewer,
  onRemoveReviewer,
  operatorBusy,
  onRunOperator,
  operatorRunActive,
}: {
  task: TaskSummary;
  meId: string;
  myRole: string | null;
  busy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  /** Deployed specialists the assign menu offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** The operator's configured backend — the run picker's default (P11-76). */
  operatorBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy (the run ceiling). */
  operatorAutonomy: "supervised" | "full";
  /** Which backends are configured — unavailable ones are disabled (P11-41). */
  backendAvailable: { claude: boolean; codex: boolean };
  /** admin|maintainer — gates the assign/run affordances (server re-checks). */
  canRunAgents: boolean;
  /** A DELIVERING run is active (queued/running) — disables the delivering Run
   *  button (server single-flights delivering). F10-04. */
  deliveringActive: boolean;
  /** Profile ids of reviewing engagements with an active run — disables only
   *  that reviewer's Run button; supporting runs are read-only and concurrent. */
  activeReviewerIds: string[];
  /** A LIVE operator run (queued/running) exists — the only state honest
   * enough for the "operator active" pill (F7-UI1: attachment ≠ activity). */
  operatorRunActive: boolean;
  /** The assign/run fetcher is in flight. */
  runBusy: boolean;
  onAssignSpecialist: (profileId: string) => void;
  onRunSpecialist: () => void;
  /** The reviewer assign/run/remove fetcher is in flight. */
  reviewerBusy: boolean;
  onAssignReviewer: (profileId: string) => void;
  onRunReviewer: (profileId: string) => void;
  onRemoveReviewer: (profileId: string) => void;
  /** The operator-run fetcher is in flight. */
  operatorBusy: boolean;
  /** Run the operator agent with a chosen backend + autonomy. */
  onRunOperator: (backend: string, autonomy: string) => void;
}) {
  // Deployed specialists not already engaged as reviewers — what "Add reviewer"
  // offers. F10-13: also exclude the current DELIVERING profile. Engaging it as
  // a reviewer is a server no-op that returned a misleading "is already a
  // reviewer" toast; the deliverer is already engaged (as the deliverer).
  const availableReviewers = deployedSpecialists.filter(
    (s) =>
      !task.reviewers.some((r) => r.profileId === s.id) &&
      s.id !== task.specialist?.profileId,
  );
  // Resolve an agent's display NAME by profile id. The AgentRef stored on the
  // task carries only profileId/backend/role (its `name` is the backend label),
  // so the real name comes from the deployed profile.
  //
  // UX19-12: when the profile is NOT deployed any more this fell back to the
  // engagement's `role`, which printed the row as "Implementation" over
  // "Implementation · Codex" — undisclosed, not merely terse. The engagement had
  // outlived its profile (deleted, or deployed on another project), and the run
  // its still-live "Run" button would start takes the fully-withheld posture
  // (R15-7 / ruling 26): it streams and produces no branch, PR, comment or
  // verdict. The Agents live table already names this exact condition rather
  // than printing the raw id (`agents-page.tsx:924-927`); the surface that
  // OFFERS the action was the one still hiding it.
  const deployedById = new Map(deployedSpecialists.map((s) => [s.id, s]));
  const agentNameOf = (profileId: string) => deployedById.get(profileId)?.name;
  // UC-13: the cell was headed "Reviewing agents" whatever was engaged, so a
  // task whose only engagements are SUPPORTING agents (no
  // `report-validation-verdict` grant — they can read, validate and comment but
  // their opinion gates nothing) read as if it had reviewers holding the
  // acceptance gate. Label by what the engagements actually are, and only
  // downgrade on positive evidence: an engaged profile whose capabilities are
  // unknown here (no longer deployed, older loader payload) keeps the
  // review framing rather than being silently demoted. UX19-4: the cell's
  // controls take their words from the same call, so heading and verbs agree.
  const vocab = engagementVocabulary(task.reviewers, deployedSpecialists);
  const sp = task.specialist;
  const spGhost = !!sp && !deployedById.has(sp.profileId);
  const o = task.owner && task.owner.kind === "human" ? task.owner : null;
  const mine = !!(o && o.userId === meId);
  // G9: a task at the terminal (Done) stage is closed — its runtime action
  // buttons (Run operator / Run specialist / Run reviewer) are disabled so a
  // closed task doesn't advertise live controls. F15-11: an ARCHIVED task is
  // out of the flow too — it must not advertise them either.
  const closed =
    task.displayReadiness === "accepted" ||
    task.displayReadiness === "merged" ||
    task.archived;
  // F20-5 (R20-1): the server refuses a MANUAL operator run while a decision
  // packet is open — coordination is paused by the packet, so a run would burn
  // several turns and take no action. Derived from the same `task.packet` the
  // DecisionPacket card renders (one fact, no prop threaded through the
  // section). A closed task keeps its own "reopen it" copy.
  const packetOpen = !!task.packet;
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Execution profile</h2>
        {(closed || operatorRunActive) && (
          <span className="right">
            {closed && (
              <Pill kind="done" sm>
                task closed
              </Pill>
            )}
            {/* F7-UI1: "operator active" means a LIVE operator run, not mere
                attachment — an attached-but-idle operator shows nothing. */}
            {operatorRunActive && (
              <Pill kind="agent" dot>
                operator active
              </Pill>
            )}
          </span>
        )}
      </div>
      <div className="profile-grid">
        <div className="profile-cell">
          <div className="lbl">Operator</div>
          <div className="val op-val">
            <div className="op-id">
              <span className="agent-glyph">
                <Icon name="shield" />
              </span>
              <span>
                <div className="nm">Operator</div>
                <div className="sub">
                  {task.operator
                    ? `coordinator · ${task.operator.sinceLabel}`
                    : "coordinator"}
                </div>
              </span>
            </div>
            {canRunAgents && (
              <OperatorRunControl
                busy={operatorBusy}
                disabled={closed}
                {...(packetOpen && !closed
                  ? {
                      blockedReason:
                        "Open decision. Resolve it before running the operator.",
                    }
                  : {})}
                defaultBackend={operatorBackend}
                configuredAutonomy={operatorAutonomy}
                backendAvailable={backendAvailable}
                onRun={onRunOperator}
              />
            )}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Delivering agent</div>
          <div className="val">
            {sp ? (
              <>
                <AgentGlyph backend={sp.backend} />
                <span>
                  <div className="nm">
                    {spGhost ? GHOST_NAME : agentNameOf(sp.profileId)}
                  </div>
                  <div className="sub">
                    {sp.role} · {sp.backend === "claude" ? "Claude Code" : "Codex"}
                  </div>
                  {/* UX19-12: the row that offers the action names the state. */}
                  {spGhost && <div className="sub">{GHOST_DELIVERING_NOTE}</div>}
                </span>
                {canRunAgents && (
                  <span className="right">
                    <button
                      type="button"
                      className="btn primary sm"
                      disabled={runBusy || deliveringActive || closed || spGhost}
                      onClick={onRunSpecialist}
                      title={
                        spGhost
                          ? GHOST_DELIVERING_NOTE
                          : closed
                            ? "Task is closed (terminal stage). No runs needed"
                            : deliveringActive
                              ? "A delivering run is already streaming for this task"
                              : "Start an agent run for the delivering agent"
                      }
                    >
                      <Icon name="bolt" />
                      {deliveringActive ? "Running…" : "Run"}
                    </button>
                  </span>
                )}
              </>
            ) : canRunAgents ? (
              <div className="rev-row">
                <span className="sub">
                  None yet. Assign a deployed agent to deliver it
                </span>
                <SpecialistControl
                  projectSlug={task.projectSlug}
                  specialists={deployedSpecialists}
                  busy={runBusy}
                  closed={closed}
                  onAssign={onAssignSpecialist}
                />
              </div>
            ) : (
              <span className="sub">
                None yet. The operator assigns one when execution starts
              </span>
            )}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">{vocab.heading}</div>
          {/* Each reviewer renders as a row identical to the delivering agent
              above (glyph · name / role·backend · Run), with a release (×). */}
          <div className="val revs">
            {task.reviewers.length ? (
              task.reviewers.map((c) => {
                const running = activeReviewerIds.includes(c.profileId);
                const ghost = !deployedById.has(c.profileId);
                return (
                  <div className="rev-agent" key={c.profileId}>
                    <AgentGlyph backend={c.backend} />
                    <span>
                      <div className="nm">
                        {ghost ? GHOST_NAME : agentNameOf(c.profileId)}
                      </div>
                      <div className="sub">
                        {c.role} · {c.backend === "claude" ? "Claude Code" : "Codex"}
                      </div>
                      {/* UX19-12: same disclosure as the delivering row — and
                          the release (×) beside it stays live, because letting
                          go of a dead engagement is the recovery. */}
                      {ghost && <div className="sub">{GHOST_REVIEWING_NOTE}</div>}
                    </span>
                    {canRunAgents && (
                      <span className="right">
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={reviewerBusy || running || closed || ghost}
                          onClick={() => onRunReviewer(c.profileId)}
                          title={
                            ghost
                              ? GHOST_REVIEWING_NOTE
                              : closed
                                ? "Task is closed (terminal stage). No runs needed"
                                : running
                                  ? "A run for this reviewer is already streaming"
                                  : "Start a run for this reviewer"
                          }
                        >
                          <Icon name="bolt" />
                          {running ? "Running…" : "Run"}
                        </button>
                        <button
                          type="button"
                          className="rev-x"
                          disabled={reviewerBusy}
                          aria-label={vocab.releaseOf(c.role)}
                          title={vocab.release}
                          onClick={() => onRemoveReviewer(c.profileId)}
                        >
                          <Icon name="x" />
                        </button>
                      </span>
                    )}
                  </div>
                );
              })
            ) : (
              <span className="sub">None engaged</span>
            )}
            {canRunAgents && (
              <ReviewerControl
                projectSlug={task.projectSlug}
                specialists={availableReviewers}
                hasAnyDeployed={deployedSpecialists.length > 0}
                busy={reviewerBusy}
                closed={closed}
                vocab={vocab}
                onAssign={onAssignReviewer}
              />
            )}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Human owner · reviews &amp; accepts</div>
          <div className="val">
            <div className="rev-row">
              {o && (
                <span className="rev-chip">
                  <Avatar person={o} />
                  <span className="nm">
                    {o.name}
                    {mine ? " · you" : ""}
                  </span>
                </span>
              )}
              {/* F19-11: said "open to any project member" beside a Permissions
               *  row reading "contributor+ to own" — a viewer read one line as
               *  an invitation and the other as a refusal. Name the real tier. */}
              {!o && (
                // F19-11: this read "open to any project member", which the
                // RBAC matrix contradicts on the very next line of the same
                // row — `own-task` is admin/maintainer/contributor (rbac.ts:65),
                // and a viewer IS a project member. The sibling copy inside
                // OwnerControl had it right, so the two disagreed in one cell.
                // Ownership eligibility is stated here, once, for every role.
                <span className="sub">
                  Unowned. Any contributor or above can take it
                </span>
              )}
              <OwnerControl
                task={task}
                myRole={myRole}
                busy={busy}
                onOwner={onOwner}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
