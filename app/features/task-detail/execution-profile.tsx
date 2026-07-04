import { useEffect, useRef, useState } from "react";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { Avatar } from "~/ui/avatar";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill } from "~/ui/pill";

/**
 * Execution profile panel + OwnerControl — 1:1 port of task.jsx §4.3/§4.4.
 *
 * Deviations from the mock (documented in the phase report):
 *   - all identity comparisons are by user id (ruling 6), never name;
 *   - members come from the layout loader, not window.VIBERR.policy.members
 *     (project.md membership has no status field — every member is active);
 *   - the "operator active" head pill renders only when an operator is
 *     actually attached (mock showed it unconditionally; real runtime state
 *     arrives in Phase 8);
 *   - Manage menu closes on Escape too (spec §4.4 port note).
 */

export type OwnerAction = "take" | "assign" | "release";

export interface TaskMemberView {
  userId: string;
  role: string;
  user: { name: string; initials?: string | null; tone?: string | null };
}

export function OwnerControl({
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
    return (
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
    );
  }

  // Hand-off candidates: active members minus the current owner and me.
  const candidates = members.filter(
    (m) => m.userId !== o.userId && m.userId !== meId,
  );

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
          {!mine && (
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

export function ExecutionProfile({
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
  const sp = task.specialist;
  const o = task.owner && task.owner.kind === "human" ? task.owner : null;
  const mine = !!(o && o.userId === meId);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Execution profile</h2>
        {task.operator && (
          <span className="right">
            <Pill kind="agent" dot>
              operator active
            </Pill>
          </span>
        )}
      </div>
      <div className="profile-grid">
        <div className="profile-cell">
          <div className="lbl">Operator</div>
          <div className="val">
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
        </div>
        <div className="profile-cell">
          <div className="lbl">Primary specialist</div>
          <div className="val">
            {sp ? (
              <>
                <AgentGlyph backend={sp.backend} />
                <span>
                  <div className="nm">{sp.name}</div>
                  <div className="sub">
                    {sp.role} · {sp.backend === "claude" ? "Claude Code" : "Codex"}
                  </div>
                </span>
              </>
            ) : (
              <span className="sub">
                None yet — the operator assigns one when execution starts
              </span>
            )}
          </div>
        </div>
        <div className="profile-cell">
          <div className="lbl">Consultants</div>
          <div className="val">
            {task.consultants.length ? (
              <div className="consultants">
                {task.consultants.map((c, i) => (
                  <span
                    className="who-chip"
                    key={i}
                    style={{
                      padding: ".25rem .5rem",
                      border: "1px solid var(--hairline)",
                      borderRadius: "999px",
                    }}
                  >
                    <AgentGlyph backend={c.backend} />
                    <span className="nm" style={{ fontSize: ".8rem" }}>
                      {c.name} · {c.role}
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="sub">None engaged</span>
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
