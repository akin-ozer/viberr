import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate, useSearchParams } from "react-router";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import {
  deploymentDot,
  deploymentStatusKind,
  type AgentDeploymentView,
  type AgentProfileView,
} from "./agent-types";
import { CAP_META } from "./capability-catalog";
import { CapabilityMatrixModal } from "./capability-matrix-modal";
import {
  CreateProfileModal,
  type ProfileFormPayload,
} from "./create-profile-modal";

/**
 * Agents view (design/html-app/app/agents.jsx → 1:1 port, agents spec):
 * profile roster + detail (eligible stages, three-bucket capability policy,
 * context resources & runtime, active deployments), Live roster tab, and
 * the three modals. All governed data comes from the loader (real
 * projections); profile CRUD posts to the route action (no optimistic UI).
 * Deploy/live rows navigate to task detail.
 *
 * Presentational pieces (ProfileDetail, LiveRoster, …) take props +
 * callbacks so jsdom tests render them without a router.
 */

export interface StageView {
  id: string;
  name: string;
  color: string;
}

// ------------------------------------------------------------ small parts

export function BackendChip({ b }: { b: string }) {
  return (
    <span className="be-chip">
      <AgentGlyph backend={b} />
      {b === "claude" ? "Claude Code" : "Codex"}
    </span>
  );
}

function ProfileGlyph({ a, lg }: { a: AgentProfileView; lg?: boolean }) {
  return (
    <span
      className={
        "agent-glyph" + (lg ? " lg" : "") + (a.kind === "operator" ? " op" : "")
      }
      title={a.role}
    >
      <Icon name={a.icon as IconName} />
    </span>
  );
}

function ActiveBadge({ count }: { count: number }) {
  if (count > 0)
    return (
      <span className="ag-active">
        <span className="working" />
        {count}
      </span>
    );
  return <span className="ag-idle">idle</span>;
}

function ProfileItem({
  a,
  count,
  on,
  onClick,
}: {
  a: AgentProfileView;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button className={"ag-item" + (on ? " on" : "")} onClick={onClick}>
      <ProfileGlyph a={a} />
      <span className="ag-item-main">
        <span className="nm">{a.name}</span>
        <span className="sub">{a.role}</span>
      </span>
      <ActiveBadge count={count} />
    </button>
  );
}

function CapColumn({
  group,
  items,
}: {
  group: keyof typeof CAP_META;
  items: string[];
}) {
  const m = CAP_META[group];
  return (
    <div className={"cap-col " + group}>
      <div className="cap-col-head">
        <Icon name={m.icon} />
        {m.label}
      </div>
      <div className="cap-list">
        {items.map((x, i) => (
          <div className="cap-item" key={i}>
            <Icon name={m.icon} />
            <span>{x}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResGroup({
  label,
  icon,
  items,
}: {
  label: string;
  icon: IconName;
  items: string[];
}) {
  return (
    <div className="res-group">
      <div className="lbl">{label}</div>
      <div className="res-chips">
        {items.length ? (
          items.map((x, i) => (
            <span className="res-chip" key={i}>
              <Icon name={icon} />
              {x}
            </span>
          ))
        ) : (
          <span
            className="sub"
            style={{ fontSize: ".8rem", color: "var(--placeholder)" }}
          >
            None
          </span>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------- delete confirm

function DeleteConfirm({
  a,
  projectName,
  activeCount,
  onCancel,
  onConfirm,
}: {
  a: AgentProfileView;
  projectName: string;
  activeCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useDialog(onCancel);
  return (
    <>
      <div className="confirm-scrim" onClick={onCancel} />
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete profile"
        ref={dialogRef}
      >
        <div className="confirm-icon">
          <Icon name="alert" />
        </div>
        <h3>Delete the {a.name} profile?</h3>
        <p>
          This removes <strong>{a.name}</strong> from {projectName}'s approved
          profiles. It can't be assigned to new tasks.
          {activeCount > 0 ? (
            <>
              {" "}
              It is currently engaged on{" "}
              <strong>
                {activeCount} active task{activeCount > 1 ? "s" : ""}
              </strong>{" "}
              — those threads keep running until the operator reassigns them.
            </>
          ) : (
            <> The global base definition is unaffected.</>
          )}
        </p>
        <div className="confirm-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm}>
            <Icon name="x" />
            Delete profile
          </button>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ detail

export function ProfileDetail({
  a,
  stages,
  insts,
  projectName,
  canManage,
  onOpen,
  onDelete,
  onEdit,
}: {
  a: AgentProfileView;
  stages: StageView[];
  insts: AgentDeploymentView[];
  projectName: string;
  canManage: boolean;
  onOpen: (taskKey: string) => void;
  onDelete: (id: string) => void;
  onEdit: (a: AgentProfileView) => void;
}) {
  const activeKeys = [...new Set(insts.map((d) => d.taskKey))];
  const [confirm, setConfirm] = useState(false);
  const canDelete = a.kind !== "operator" && canManage;

  return (
    <div className="ag-detail">
      {confirm && (
        <DeleteConfirm
          a={a}
          projectName={projectName}
          activeCount={activeKeys.length}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            onDelete(a.id);
          }}
        />
      )}
      <div className="ag-hero">
        <ProfileGlyph a={a} lg />
        <div className="ag-hero-main">
          <div className="ag-hero-top">
            <h1>{a.name}</h1>
            <Pill kind={a.kind === "operator" ? "agent" : "neutral"} sm>
              {a.role}
            </Pill>
            {activeKeys.length > 0 ? (
              <span className="ag-running">
                <span className="working" />
                running on {activeKeys.length}{" "}
                {activeKeys.length > 1 ? "tasks" : "task"}
              </span>
            ) : (
              <span className="ag-idle">idle · available</span>
            )}
          </div>
          <div className="ag-scope">{a.scope}</div>
        </div>
        <div className="ag-hero-actions">
          {canDelete && (
            <button
              className="btn ghost sm danger"
              onClick={() => setConfirm(true)}
            >
              <Icon name="x" />
              Delete
            </button>
          )}
          {canManage && (
            <button className="btn sm" onClick={() => onEdit(a)}>
              <Icon name="user" />
              Edit profile
            </button>
          )}
        </div>
      </div>

      <p className="ag-desc">{a.desc}</p>

      <div className="panel">
        <div className="panel-head">
          <Icon name="board" />
          <h2>Eligible stages</h2>
          <span
            className="right sub"
            style={{ fontSize: ".76rem", color: "var(--faint)" }}
          >
            {a.spanAll
              ? "active across the whole lifecycle"
              : a.stages.length + " of " + stages.length + " stages"}
          </span>
        </div>
        <div className="stage-chips">
          {stages.map((s) => {
            const elig = a.stages.includes(s.id);
            return (
              <span
                key={s.id}
                className={"stage-chip" + (elig ? " elig" : " off")}
              >
                <span
                  className="sdot"
                  style={elig ? { background: s.color } : undefined}
                />
                {s.name}
              </span>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <Icon name="shield" />
          <h2>Capability policy</h2>
        </div>
        <div className="cap-cols">
          <CapColumn group="direct" items={a.actions.direct} />
          <CapColumn group="recommend" items={a.actions.recommend} />
          <CapColumn group="forbidden" items={a.actions.forbidden} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <Icon name="cpu" />
          <h2>Context resources &amp; runtime</h2>
        </div>
        <div className="res-groups">
          <ResGroup label="Skills" icon="bolt" items={a.resources.skills} />
          <ResGroup label="MCP servers" icon="cpu" items={a.resources.mcps} />
          <ResGroup label="Knowledge bases" icon="file" items={a.resources.kb} />
        </div>
        <div className="runtime-row">
          <div className="rt-cell">
            <div className="lbl">Execution backend</div>
            <div className="rt-val">
              <div className="be-list">
                {a.backends.length ? (
                  a.backends.map((b, i) => <BackendChip key={i} b={b} />)
                ) : (
                  <span className="be-chip">
                    <span className="agent-glyph op" style={{ width: 22, height: 22 }}>
                      <Icon name="shield" />
                    </span>
                    Orchestration runtime
                  </span>
                )}
              </div>
            </div>
          </div>
          {a.kind === "operator" ? (
            <div className="rt-cell">
              <div className="lbl">Autonomy</div>
              <div className="rt-val">
                <Pill kind={a.autonomy === "full" ? "agent" : "neutral"} sm dot>
                  {a.autonomy === "full" ? "Full autonomy" : "Supervised"}
                </Pill>
              </div>
            </div>
          ) : (
            <div className="rt-cell">
              <div className="lbl">Model</div>
              <div className="rt-val mono" style={{ fontSize: ".82rem" }}>
                {a.model}
              </div>
            </div>
          )}
          <div className="rt-cell">
            <div className="lbl">Continuity</div>
            <div className="rt-val mem-row" style={{ marginTop: 0 }}>
              <Icon name="memory" />
              <span>
                Re-anchors on <code className="mono">task.md</code>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <Icon name="activity" />
          <h2>Active deployments</h2>
          <span
            className="right sub"
            style={{ fontSize: ".76rem", color: "var(--faint)" }}
          >
            {insts.length} engagement{insts.length === 1 ? "" : "s"}
          </span>
        </div>
        {insts.length === 0 ? (
          <div className="empty" style={{ padding: "1rem .5rem" }}>
            Not currently engaged on any task. This profile is approved and
            available for assignment.
          </div>
        ) : (
          <div className="deploy-list">
            {insts.map((d, i) => (
              <button
                className="deploy-row"
                key={i}
                onClick={() => onOpen(d.taskKey)}
              >
                <span className="deploy-eng">{d.engagement}</span>
                <span className="deploy-task">
                  <span className="key mono">{d.taskKey}</span> {d.taskTitle}
                </span>
                {d.backend && a.kind !== "operator" && (
                  <BackendChip b={d.backend} />
                )}
                <Pill kind={deploymentStatusKind(d.status)} sm dot={deploymentDot(d)}>
                  {d.status}
                </Pill>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- live tab

const ENGAGEMENT_ORDER = { operator: 0, primary: 1, reviewer: 2 } as const;

export function LiveRoster({
  deployments,
  onOpen,
}: {
  deployments: AgentDeploymentView[];
  onOpen: (taskKey: string) => void;
}) {
  const sorted = [...deployments].sort(
    (a, b) =>
      a.taskKey.localeCompare(b.taskKey) ||
      ENGAGEMENT_ORDER[a.engagement] - ENGAGEMENT_ORDER[b.engagement],
  );
  return (
    <div className="live-wrap">
      <div className="live-table">
        <div className="live-head">
          <span>Agent</span>
          <span>Backend</span>
          <span>Task</span>
          <span>Engagement</span>
          <span>Status</span>
        </div>
        {sorted.length === 0 && (
          // Empty state the mock never designed (agents spec §4.4).
          <div className="empty" style={{ padding: "1rem" }}>
            No agents are currently engaged.
          </div>
        )}
        {sorted.map((d, i) => {
          const isOp = d.engagement === "operator";
          return (
            <button className="live-row" key={i} onClick={() => onOpen(d.taskKey)}>
              <span className="live-agent">
                <span
                  className={
                    "agent-glyph" +
                    (isOp ? " op" : " " + (d.backend === "claude" ? "claude" : "codex"))
                  }
                >
                  <Icon
                    name={isOp ? "shield" : d.backend === "claude" ? "sparkle" : "cpu"}
                  />
                </span>
                <span className="live-role">{d.role}</span>
              </span>
              <span className="live-be">
                {isOp
                  ? "orchestration"
                  : d.backend === "claude"
                    ? "Claude Code"
                    : "Codex"}
              </span>
              <span className="live-task">
                <span className="key mono">{d.taskKey}</span>{" "}
                <span className="ttl">{d.taskTitle}</span>
              </span>
              <span>
                <Pill
                  kind={
                    d.engagement === "operator"
                      ? "agent"
                      : d.engagement === "primary"
                        ? "info"
                        : "neutral"
                  }
                  sm
                >
                  {d.engagement}
                </Pill>
              </span>
              <span>
                <Pill kind={deploymentStatusKind(d.status)} sm dot={deploymentDot(d)}>
                  {d.status}
                </Pill>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- page

type ProfileActionResult =
  | { ok: true; toast: string; profileId: string }
  | { ok: false; error: string };

export function AgentsPage({
  profiles,
  deployments,
  stages,
  projectSlug,
  projectName,
  myRole,
}: {
  profiles: AgentProfileView[];
  deployments: AgentDeploymentView[];
  stages: StageView[];
  projectSlug: string;
  projectName: string;
  myRole: string | null;
}) {
  const navigate = useNavigate();
  const push = useToast();
  const csrf = useCsrfToken();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<ProfileActionResult>();

  const canManage = myRole === "admin";
  const [sel, setSel] = useState<string>(
    () => searchParams.get("profile") ?? "operator",
  );
  const [tab, setTab] = useState<"profiles" | "live">("profiles");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AgentProfileView | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const operator = profiles.find((p) => p.kind === "operator") ?? null;
  const specialists = profiles.filter((p) => p.kind !== "operator");
  const current = profiles.find((a) => a.id === sel) ?? profiles[0] ?? null;

  const counts = useMemo(() => {
    const sets = new Map<string, Set<string>>();
    for (const d of deployments) {
      if (!sets.has(d.profileId)) sets.set(d.profileId, new Set());
      sets.get(d.profileId)!.add(d.taskKey);
    }
    const out: Record<string, number> = {};
    for (const [k, v] of sets) out[k] = v.size;
    return out;
  }, [deployments]);

  const operators = deployments.filter((d) => d.engagement === "operator").length;
  const working = deployments.filter((d) => d.status === "working").length;
  const waiting = deployments.filter(
    (d) => d.status === "waiting on human" || d.status === "packet open",
  ).length;

  const onOpen = (taskKey: string) =>
    navigate(`/projects/${projectSlug}/tasks/${taskKey}`);

  // One handled-result effect (phase-5/7 pattern): toast, close on success,
  // keep the modal open with the server error otherwise.
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    const d = fetcher.data;
    if (d.ok) {
      push(d.toast);
      setCreating(false);
      setEditing(null);
      setFormError(null);
      if (d.profileId) setSel(d.profileId);
    } else if (creating || editing) {
      setFormError(d.error);
    } else {
      push(d.error);
    }
  }, [fetcher.state, fetcher.data, push, creating, editing]);

  const submitProfile = (payload: ProfileFormPayload) => {
    setFormError(null);
    fetcher.submit(
      {
        intent: editing ? "update-profile" : "create-profile",
        _csrf: csrf,
        ...(editing ? { profileId: editing.id } : {}),
        payload: JSON.stringify(payload),
      },
      { method: "post" },
    );
  };

  const deleteProfile = (profileId: string) => {
    if (sel === profileId) setSel("operator");
    fetcher.submit(
      { intent: "delete-profile", _csrf: csrf, profileId },
      { method: "post" },
    );
  };

  return (
    <div className="board-wrap" data-screen-label="Agents">
      <div className="board-head">
        <div>
          <h1>Agents</h1>
          <div className="sub">
            Reusable profiles, eligible stages, and capability policy · global
            base, customized for {projectName}
          </div>
        </div>
        <div className="board-tools">
          <div className="seg">
            <button
              className={tab === "profiles" ? "on" : ""}
              onClick={() => setTab("profiles")}
            >
              <Icon name="agents" />
              Profiles
            </button>
            <button
              className={tab === "live" ? "on" : ""}
              onClick={() => setTab("live")}
            >
              <Icon name="activity" />
              Live<span style={{ opacity: 0.6 }}>· {deployments.length}</span>
            </button>
          </div>
          <button className="btn ghost sm" onClick={() => setMatrixOpen(true)}>
            <Icon name="shield" />
            Capability matrix
          </button>
          {canManage && (
            <button className="btn primary sm" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New profile
            </button>
          )}
        </div>
      </div>

      <div className="ag-stats">
        <div className="ag-stat">
          <div className="n">{profiles.length}</div>
          <div className="l">profiles approved · incl. operator</div>
        </div>
        <div className="ag-stat">
          <div className="n">{operators}</div>
          <div className="l">operators running · one per active task</div>
        </div>
        <div className="ag-stat">
          <div className="n" style={{ color: "var(--agent-dark)" }}>
            {working}
          </div>
          <div className="l">specialists working right now</div>
        </div>
        <div className="ag-stat">
          <div className="n" style={{ color: "var(--blue-pressed)" }}>
            {waiting}
          </div>
          <div className="l">threads waiting on a human</div>
        </div>
      </div>

      {tab === "profiles" ? (
        <div className="agents-layout">
          <aside className="profile-list">
            <div className="ag-group-label">Orchestration</div>
            {operator && (
              <ProfileItem
                a={operator}
                count={counts[operator.id] ?? 0}
                on={current?.id === operator.id}
                onClick={() => setSel(operator.id)}
              />
            )}
            <div className="ag-group-label ag-group-row">
              Specialist profiles
              {canManage && (
                <button
                  className="ag-add"
                  title="New specialist profile"
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" />
                </button>
              )}
            </div>
            {specialists.map((p) => (
              <ProfileItem
                key={p.id}
                a={p}
                count={counts[p.id] ?? 0}
                on={current?.id === p.id}
                onClick={() => setSel(p.id)}
              />
            ))}
            {canManage && (
              <button className="ag-newbtn" onClick={() => setCreating(true)}>
                <Icon name="plus" />
                New specialist profile
              </button>
            )}
          </aside>
          {current && (
            <ProfileDetail
              a={current}
              stages={stages}
              insts={deployments.filter((d) => d.profileId === current.id)}
              projectName={projectName}
              canManage={canManage}
              onOpen={onOpen}
              onDelete={deleteProfile}
              onEdit={setEditing}
            />
          )}
        </div>
      ) : (
        <LiveRoster deployments={deployments} onOpen={onOpen} />
      )}

      {creating && (
        <CreateProfileModal
          initial={null}
          stages={stages}
          projectName={projectName}
          busy={fetcher.state !== "idle"}
          error={formError}
          onClose={() => {
            setCreating(false);
            setFormError(null);
          }}
          onSubmit={submitProfile}
        />
      )}
      {editing && (
        <CreateProfileModal
          key={editing.id}
          initial={editing}
          stages={stages}
          projectName={projectName}
          busy={fetcher.state !== "idle"}
          error={formError}
          onClose={() => {
            setEditing(null);
            setFormError(null);
          }}
          onSubmit={submitProfile}
        />
      )}
      {matrixOpen && (
        <CapabilityMatrixModal
          profiles={profiles}
          projectName={projectName}
          onClose={() => setMatrixOpen(false)}
        />
      )}
    </div>
  );
}
