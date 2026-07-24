import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate, useSearchParams } from "react-router";
import { roleCan, type ProjectRole } from "~/shared/rbac";
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
  type LibraryProfileView,
} from "./agent-types";
import { CAP_META, type ResCatalogGroup } from "./capability-catalog";
import { CapabilityMatrixModal } from "./capability-matrix-modal";
import {
  CreateProfileModal,
  type ProfileFormPayload,
} from "./create-profile-modal";

/**
 * Agent profile and deployment view:
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

function BackendChip({ b }: { b: string }) {
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
    <button type="button" className={"ag-item" + (on ? " on" : "")} onClick={onClick}>
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
        {items.map((x) => (
          <div className="cap-item" key={x}>
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
          items.map((x) => (
            <span className="res-chip" key={x}>
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
  const { ref: dialogRef, close } = useDialog(onCancel);
  // Native <dialog>: backdrop click and Escape dismiss are handled by
  // useDialog; the ::backdrop pseudo-element renders the scrim.
  return (
    <dialog
      className="confirm-card"
      role="alertdialog"
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
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          <Icon name="x" />
          Delete profile
        </button>
      </div>
    </dialog>
  );
}

// ------------------------------------------------------- stage eligibility

/**
 * P13-LV-02 — eligible-stage chips that tell the truth.
 *
 * Three lies fixed, all live-proven on a 3-stage board:
 *  1. `spanAll` was ignored. The Operator's header said "active across the
 *     whole lifecycle" while every chip below it rendered struck through.
 *  2. The counter was `profile.stages.length + " of " + boardStages.length`,
 *     which counts stage ids the board doesn't even have — a profile carrying
 *     stale grants read "5 of 4 stages", and the Developer showed "2 of 3"
 *     with NO chip highlighted (its 2 ids don't exist on that board).
 *  3. Stale/unknown grants were invisible. They are now shown as such, which
 *     is the only on-screen clue that a profile can't be assigned anywhere.
 *
 * Eligibility mirrors `specialistEligibleForStage` exactly (spanAll, or no
 * declared stages = unrestricted, or an explicit match) so the panel and the
 * assign/run guard can never disagree.
 */
export function StageEligibility({
  a,
  stages,
}: {
  a: AgentProfileView;
  stages: StageView[];
}) {
  const boardIds = new Set(stages.map((s) => s.id));
  const unrestricted = a.spanAll || a.stages.length === 0;
  const onBoard = stages.filter((s) => a.stages.includes(s.id)).length;
  const stale = a.stages.filter((id) => !boardIds.has(id));
  const summary = a.spanAll
    ? "active across the whole lifecycle"
    : a.stages.length === 0
      ? "no stage restriction — eligible everywhere"
      : `${onBoard} of ${stages.length} stages`;
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="board" />
        <h2>Eligible stages</h2>
        <span
          className="right sub"
          style={{ fontSize: ".76rem", color: "var(--faint)" }}
        >
          {summary}
        </span>
      </div>
      <div className="stage-chips">
        {stages.map((s) => {
          const elig = unrestricted || a.stages.includes(s.id);
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
        {stale.map((id) => (
          <span
            key={id}
            className="stage-chip off"
            title={`This profile grants the stage “${id}”, which no longer exists on this board — the grant does nothing.`}
          >
            <span className="sdot" />
            {id} · not on this board
          </span>
        ))}
      </div>
      {!unrestricted && onBoard === 0 && (
        <div className="empty" style={{ padding: ".75rem .5rem" }}>
          None of this profile's eligible stages exist on this board, so it
          can't be assigned to any task here. Edit the profile's eligible stages
          to match the board.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ library picker

/**
 * "Add from library" — deploy an org-level template into this project
 * (owner ruling 1 / P13-AP-05). Until this existed, a profile created in
 * Settings → Global agent profiles could never be deployed, run or selected:
 * no code path copied a template into a project's roster, so the org editor
 * offered a lifecycle it could not finish.
 */
export function LibraryPicker({
  library,
  projectName,
  busy,
  onClose,
  onAdd,
}: {
  library: LibraryProfileView[];
  projectName: string;
  busy: boolean;
  onClose: () => void;
  onAdd: (profileId: string) => void;
}) {
  const { ref: dialogRef, close } = useDialog(onClose);
  return (
    <dialog className="modal-card" aria-label="Add from library" ref={dialogRef}>
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="agents" />
        </span>
        <div className="mh-main">
          <h2>Add from library</h2>
          <div className="mh-sub">
            Global agent profiles not yet deployed in {projectName}. Adding one
            copies its definition and capability grants into this project.
          </div>
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
      <div className="modal-body">
        {library.length === 0 ? (
          <div className="empty" style={{ padding: "1rem .5rem" }}>
            Every global profile is already deployed here. Create more in org
            settings → Global agent profiles.
          </div>
        ) : (
          <div className="deploy-list">
            {library.map((t) => (
              <button
                type="button"
                className="deploy-row"
                key={t.id}
                disabled={busy}
                onClick={() => onAdd(t.id)}
              >
                <span className="deploy-eng">{t.role || "Specialist"}</span>
                <span className="deploy-task">
                  <span className="key mono">{t.name}</span> {t.desc}
                </span>
                {t.backends.map((b) => (
                  <BackendChip key={b} b={b} />
                ))}
                <Pill kind="neutral" sm>
                  {t.spanAll
                    ? "every stage"
                    : t.stages.length + " stage" + (t.stages.length === 1 ? "" : "s")}
                </Pill>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          The global profile stays the source; this project gets its own
          editable copy.
        </span>
        <div className="foot-actions">
          <button type="button" className="btn ghost" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </dialog>
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
              type="button"
              className="btn ghost sm danger"
              onClick={() => setConfirm(true)}
            >
              <Icon name="x" />
              Delete
            </button>
          )}
          {canManage && (
            <button type="button" className="btn sm" onClick={() => onEdit(a)}>
              <Icon name="user" />
              Edit profile
            </button>
          )}
        </div>
      </div>

      <p className="ag-desc">{a.desc}</p>

      <StageEligibility a={a} stages={stages} />

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
                  a.backends.map((b) => <BackendChip key={b} b={b} />)
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
              <div className="rt-val mono model-val" style={{ fontSize: ".82rem" }}>
                <span>{a.modelLabel}</span>
                {!a.modelKnown && (
                  <span
                    className="model-sub"
                    title={`The saved model “${a.model}” isn't a recognized model id — runs use the default (${a.modelLabel}). Open Edit profile to pick a model.`}
                  >
                    <Icon name="alert" />
                    default
                  </span>
                )}
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
            {insts.map((d) => (
              <button
                type="button"
                className="deploy-row"
                key={`${d.taskKey}:${d.engagement}`}
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
  nameById,
}: {
  deployments: AgentDeploymentView[];
  onOpen: (taskKey: string) => void;
  /** profileId → display name, so live rows show a human name instead of the
   *  raw profileId (P11-42). The row falls back to the profileId when a name
   *  can't be resolved. */
  nameById?: Record<string, string>;
}) {
  const sorted = deployments.toSorted(
    (a, b) =>
      a.taskKey.localeCompare(b.taskKey) ||
      ENGAGEMENT_ORDER[a.engagement] - ENGAGEMENT_ORDER[b.engagement],
  );
  return (
    <div className="live-wrap">
      <div className="live-table">
        <div className="live-head">
          {/* F10-20: profile IDENTITY (not the task role) heads this column, with
              the task role as a sub-label — four distinct axes: identity, task
              role, engagement, backend. */}
          <span>Profile</span>
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
        {sorted.map((d) => {
          const isOp = d.engagement === "operator";
          return (
            <button
              type="button"
              className="live-row"
              key={`${d.profileId}:${d.taskKey}:${d.engagement}`}
              onClick={() => onOpen(d.taskKey)}
            >
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
                <span className="live-ident">
                  <span className="live-name">
                    {isOp ? "Operator" : (nameById?.[d.profileId] ?? d.profileId)}
                  </span>
                  {!isOp && <span className="live-role-sub">{d.role}</span>}
                </span>
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
                  {/* F10-20: human-facing engagement, not the internal
                      primary/reviewer literals. */}
                  {d.engagement === "operator"
                    ? "operator"
                    : d.engagement === "primary"
                      ? "delivering"
                      : "supporting"}
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
  library,
  deployments,
  stages,
  projectSlug,
  projectName,
  myRole,
  resourceCatalog,
  backendAvailable,
}: {
  profiles: AgentProfileView[];
  /** Org templates not yet deployed here — the "Add from library" options. */
  library?: LibraryProfileView[];
  deployments: AgentDeploymentView[];
  stages: StageView[];
  projectSlug: string;
  projectName: string;
  myRole: string | null;
  /** Live store resources for the profile-editor picker (F6/item-2). */
  resourceCatalog?: readonly ResCatalogGroup[];
  /** Per-backend credential availability — the create/edit modal disables a
   *  backend that isn't configured so a profile can't be pinned to it (RU-2). */
  backendAvailable?: Record<"codex" | "claude", boolean>;
}) {
  const navigate = useNavigate();
  const push = useToast();
  const csrf = useCsrfToken();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<ProfileActionResult>();

  const canManage = roleCan(myRole as ProjectRole | null, "manage-agents");
  const [sel, setSel] = useState<string>(
    () => searchParams.get("profile") ?? "operator",
  );
  const [tab, setTab] = useState<"profiles" | "live">("profiles");
  const [creating, setCreating] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfileView | null>(null);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const operator = profiles.find((p) => p.kind === "operator") ?? null;
  const specialists = profiles.filter((p) => p.kind !== "operator");
  const libraryProfiles = library ?? [];
  const current = profiles.find((a) => a.id === sel) ?? profiles[0] ?? null;

  const counts = useMemo(() => {
    const sets = new Map<string, Set<string>>();
    for (const d of deployments) {
      let keys = sets.get(d.profileId);
      if (!keys) {
        keys = new Set();
        sets.set(d.profileId, keys);
      }
      keys.add(d.taskKey);
    }
    const out: Record<string, number> = {};
    for (const [k, v] of sets) out[k] = v.size;
    return out;
  }, [deployments]);

  // Live-roster rows carry only a profileId (AgentDeploymentView has no name);
  // resolve a human display name from the profiles the page already holds,
  // falling back to the profileId when unresolved (P11-42).
  const nameById = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p.name])),
    [profiles],
  );

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
      setLibraryOpen(false);
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

  const deployFromLibrary = (profileId: string) => {
    fetcher.submit(
      { intent: "deploy-profile", _csrf: csrf, profileId },
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
              type="button"
              className={tab === "profiles" ? "on" : ""}
              onClick={() => setTab("profiles")}
            >
              <Icon name="agents" />
              Profiles
            </button>
            <button
              type="button"
              className={tab === "live" ? "on" : ""}
              onClick={() => setTab("live")}
            >
              <Icon name="activity" />
              Live<span style={{ opacity: 0.6 }}>· {deployments.length}</span>
            </button>
          </div>
          <button type="button" className="btn ghost sm" onClick={() => setMatrixOpen(true)}>
            <Icon name="shield" />
            Capability matrix
          </button>
          {canManage && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setLibraryOpen(true)}
            >
              <Icon name="agents" />
              Add from library
              {libraryProfiles.length > 0 && (
                <span style={{ opacity: 0.6 }}>· {libraryProfiles.length}</span>
              )}
            </button>
          )}
          {canManage && (
            <button type="button" className="btn primary sm" onClick={() => setCreating(true)}>
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
          <div className="l">active tasks · one operator each</div>
        </div>
        <div className="ag-stat">
          <div className="n" style={{ color: "var(--agent-dark)" }}>
            {working}
          </div>
          <div className="l">specialists in a working state</div>
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
                  type="button"
                  className="ag-add"
                  title="New specialist profile"
                  aria-label="New specialist profile"
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
              <button type="button" className="ag-newbtn" onClick={() => setCreating(true)}>
                <Icon name="plus" />
                New specialist profile
              </button>
            )}
            {canManage && libraryProfiles.length > 0 && (
              <button
                type="button"
                className="ag-newbtn"
                onClick={() => setLibraryOpen(true)}
              >
                <Icon name="agents" />
                Add from library · {libraryProfiles.length}
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
        <LiveRoster deployments={deployments} onOpen={onOpen} nameById={nameById} />
      )}

      {creating && (
        <CreateProfileModal
          initial={null}
          stages={stages}
          projectName={projectName}
          busy={fetcher.state !== "idle"}
          error={formError}
          {...(resourceCatalog ? { resourceCatalog } : {})}
          {...(backendAvailable ? { backendAvailable } : {})}
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
          {...(resourceCatalog ? { resourceCatalog } : {})}
          {...(backendAvailable ? { backendAvailable } : {})}
          onClose={() => {
            setEditing(null);
            setFormError(null);
          }}
          onSubmit={submitProfile}
        />
      )}
      {libraryOpen && (
        <LibraryPicker
          library={libraryProfiles}
          projectName={projectName}
          busy={fetcher.state !== "idle"}
          onClose={() => setLibraryOpen(false)}
          onAdd={deployFromLibrary}
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
