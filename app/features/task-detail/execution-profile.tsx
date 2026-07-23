import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
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

export interface TaskMemberView {
  userId: string;
  role: string;
  user: { name: string; initials?: string | null; tone?: string | null };
}

function OwnerControl({
  task,
  meId,
  myRole,
  members,
  busy,
  onOwner,
  onRelease,
}: {
  task: TaskSummary;
  meId: string;
  myRole: string | null;
  members: TaskMemberView[];
  busy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  onRelease: () => void;
}) {
  const o = task.owner && task.owner.kind === "human" ? task.owner : null;
  const mine = !!(o && o.userId === meId);
  const admin = myRole === "admin";
  // Q5 tiering (XS-12): only contributor+ may take/hold ownership — a viewer is
  // read + comment only, so its take/hand-off buttons would just 403. Gate the
  // controls the same way the server does rather than render a button that fails.
  const canOwn = roleCan(myRole as ProjectRole | null, "own-task");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!o) {
    // Only contributor+ may take ownership (Q5) — hide from viewers/non-members.
    return canOwn ? (
      <button
        type="button"
        className="rev-add"
        disabled={busy}
        onClick={() => onOwner("take")}
        title="Take ownership — review & acceptance, this task only"
      >
        <Icon name="plus" />
        Assign me
      </button>
    ) : (
      <span className="sub">Unowned — a contributor or above can take it</span>
    );
  }

  // Hand-off requires owner-or-admin (owner-assign); only the owner or an admin
  // sees the candidate list.
  const canHandOff = mine || admin;
  // Hand-off candidates: active members minus the current owner and me, and —
  // F10-13 — only members who can actually OWN a task (contributor or above).
  // The server rejects a hand-off to a viewer ("own-task"), so the picker must
  // not offer one.
  const candidates = canHandOff
    ? members.filter(
        (m) =>
          m.userId !== o.userId &&
          m.userId !== meId &&
          roleCan(m.role as ProjectRole, "own-task"),
      )
    : [];

  // Nothing this user can do to ownership → no Manage control (Q5, XS-12): a
  // viewer can't take over, hand off, or release.
  if (!canOwn && !admin) {
    return null;
  }

  return (
    <div className="own-wrap" ref={ref}>
      <button
        type="button"
        className={"own-btn" + (open ? " open" : "")}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Manage
        <Icon name="chevron" />
      </button>
      {open && (
        <div className="own-menu" role="menu" aria-label="Manage task ownership">
          {!mine && canOwn && (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onOwner("take");
              }}
            >
              <Icon name="user" />
              Take over ownership
            </button>
          )}
          {candidates.length > 0 && <div className="own-lbl">Hand off to</div>}
          {candidates.map((m) => (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              key={m.userId}
              onClick={() => {
                setOpen(false);
                onOwner("assign", m);
              }}
            >
              <Avatar person={m.user} />
              {m.user.name}
              <span className="own-role">{m.role}</span>
            </button>
          ))}
          {mine && (
            <>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item danger"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onRelease();
                }}
              >
                <Icon name="x" />
                Release ownership…
              </button>
            </>
          )}
          {!mine && admin && (
            <>
              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item danger"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onRelease();
                }}
              >
                <Icon name="x" />
                Release {o.name.split(" ")[0]}…<span className="own-role">admin</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
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
  onAssign,
}: {
  projectSlug: string;
  specialists: DeployedSpecialistView[];
  busy: boolean;
  onAssign: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (specialists.length === 0) {
    return (
      <span className="sub">
        No agents deployed —{" "}
        <Link to={`/projects/${projectSlug}/agents`}>deploy one on the Agents page</Link>
        .
      </span>
    );
  }

  return (
    <div className="own-wrap" ref={ref}>
      <button
        type="button"
        className={"own-btn" + (open ? " open" : "")}
        disabled={busy}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Assign delivering agent
        <Icon name="chevron" />
      </button>
      {open && (
        <div className="own-menu" role="menu" aria-label="Assign a delivering agent">
          <div className="own-lbl">Deployed agents</div>
          {specialists.map((s) => (
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              key={s.id}
              onClick={() => {
                setOpen(false);
                onAssign(s.id);
              }}
            >
              <AgentGlyph backend={s.backend} />
              {s.name}
              <span className="own-role">{s.role}</span>
            </button>
          ))}
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
 */
function ReviewerControl({
  projectSlug,
  specialists,
  hasAnyDeployed,
  busy,
  onAssign,
}: {
  projectSlug: string;
  /** Deployed specialists available to add (already-engaged ones filtered out). */
  specialists: DeployedSpecialistView[];
  /** Whether the project has any deployed specialist at all (empty-state copy). */
  hasAnyDeployed: boolean;
  busy: boolean;
  onAssign: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!hasAnyDeployed) {
    return (
      <span className="sub">
        No agents deployed —{" "}
        <Link to={`/projects/${projectSlug}/agents`}>deploy one on the Agents page</Link>
        .
      </span>
    );
  }

  return (
    <div className="own-wrap" ref={ref}>
      <button
        type="button"
        className={"rev-add" + (open ? " open" : "")}
        disabled={busy}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="plus" />
        Engage reviewer
      </button>
      {open && (
        <div className="own-menu" role="menu" aria-label="Engage a reviewer">
          <div className="own-lbl">Deployed agents</div>
          {specialists.length === 0 ? (
            <div className="menu-item" aria-disabled>
              <span className="sub">All deployed agents are already reviewing.</span>
            </div>
          ) : (
            specialists.map((s) => (
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                key={s.id}
                onClick={() => {
                  setOpen(false);
                  onAssign(s.id);
                }}
              >
                <AgentGlyph backend={s.backend} />
                {s.name}
                <span className="own-role">{s.role}</span>
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
  defaultBackend,
  onRun,
}: {
  busy: boolean;
  /** Task is closed (terminal stage) — controls render disabled (G9). */
  disabled?: boolean;
  /** The operator profile's configured backend — the picker's default (P11-76). */
  defaultBackend: "claude" | "codex";
  onRun: (backend: string, autonomy: string) => void;
}) {
  const [backend, setBackend] = useState<string>(defaultBackend);
  const [autonomy, setAutonomy] = useState("supervised");
  const off = busy || disabled;
  return (
    <span className="op-run">
      <select
        className="op-sel"
        aria-label="Operator backend"
        value={backend}
        onChange={(e) => setBackend(e.target.value)}
        disabled={off}
      >
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
      </select>
      <select
        className="op-sel"
        aria-label="Operator autonomy"
        value={autonomy}
        onChange={(e) => setAutonomy(e.target.value)}
        disabled={off}
      >
        <option value="supervised">Supervised</option>
        <option value="full">Full autonomy</option>
      </select>
      {/* The operator coordinates ongoing work, so it stays runnable even while
          a specialist run streams — only its own in-flight run disables it.
          A closed (terminal-stage) task disables it too (G9). */}
      <button
        type="button"
        className="btn primary sm"
        disabled={off}
        onClick={() => onRun(backend, autonomy)}
        title={
          disabled
            ? "Task is closed (terminal stage) — reopen it to run the operator"
            : "Run the operator to coordinate this task"
        }
      >
        <Icon name="shield" />
        {busy ? "Running…" : "Run operator"}
      </button>
    </span>
  );
}

export function ExecutionProfile({
  task,
  meId,
  myRole,
  members,
  busy,
  onOwner,
  onRelease,
  deployedSpecialists,
  operatorBackend,
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
  members: TaskMemberView[];
  busy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  onRelease: () => void;
  /** Deployed specialists the assign menu offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** The operator's configured backend — the run picker's default (P11-76). */
  operatorBackend: "claude" | "codex";
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
  // so the real name comes from the deployed profile; fall back to `role` when
  // the agent is no longer deployed.
  const agentNameOf = (profileId: string, fallback: string) =>
    deployedSpecialists.find((s) => s.id === profileId)?.name ?? fallback;
  const sp = task.specialist;
  const o = task.owner && task.owner.kind === "human" ? task.owner : null;
  const mine = !!(o && o.userId === meId);
  // G9: a task at the terminal (Done) stage is closed — its runtime action
  // buttons (Run operator / Run specialist / Run reviewer) are disabled so a
  // closed task doesn't advertise live controls.
  const closed =
    task.displayReadiness === "accepted" || task.displayReadiness === "merged";
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
                  coordinator · {task.operator ? task.operator.sinceLabel : "—"}
                </div>
              </span>
            </div>
            {canRunAgents && (
              <OperatorRunControl
                busy={operatorBusy}
                disabled={closed}
                defaultBackend={operatorBackend}
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
                  <div className="nm">{agentNameOf(sp.profileId, sp.role)}</div>
                  <div className="sub">
                    {sp.role} · {sp.backend === "claude" ? "Claude Code" : "Codex"}
                  </div>
                </span>
                {canRunAgents && (
                  <span className="right">
                    <button
                      type="button"
                      className="btn primary sm"
                      disabled={runBusy || deliveringActive || closed}
                      onClick={onRunSpecialist}
                      title={
                        closed
                          ? "Task is closed (terminal stage) — no runs needed"
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
                  None yet — assign a deployed agent to deliver it
                </span>
                <SpecialistControl
                  projectSlug={task.projectSlug}
                  specialists={deployedSpecialists}
                  busy={runBusy}
                  onAssign={onAssignSpecialist}
                />
              </div>
            ) : (
              <span className="sub">
                None yet — the operator assigns one when execution starts
              </span>
            )}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Reviewing agents</div>
          {/* Each reviewer renders as a row identical to the delivering agent
              above (glyph · name / role·backend · Run), with a release (×). */}
          <div className="val revs">
            {task.reviewers.length ? (
              task.reviewers.map((c) => {
                const running = activeReviewerIds.includes(c.profileId);
                return (
                  <div className="rev-agent" key={c.profileId}>
                    <AgentGlyph backend={c.backend} />
                    <span>
                      <div className="nm">{agentNameOf(c.profileId, c.role)}</div>
                      <div className="sub">
                        {c.role} · {c.backend === "claude" ? "Claude Code" : "Codex"}
                      </div>
                    </span>
                    {canRunAgents && (
                      <span className="right">
                        <button
                          type="button"
                          className="btn primary sm"
                          disabled={reviewerBusy || running || closed}
                          onClick={() => onRunReviewer(c.profileId)}
                          title={
                            closed
                              ? "Task is closed (terminal stage) — no runs needed"
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
                          aria-label={`Release ${c.role} reviewer`}
                          title="Release reviewer"
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
              {!o && (
                <span className="sub">Unowned — open to any project member</span>
              )}
              <OwnerControl
                task={task}
                meId={meId}
                myRole={myRole}
                members={members}
                busy={busy}
                onOwner={onOwner}
                onRelease={onRelease}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
