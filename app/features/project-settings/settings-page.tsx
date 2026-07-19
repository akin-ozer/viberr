import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate, type FetcherWithComponents } from "react-router";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { TglP } from "~/ui/toggle";
import { useDialog } from "~/ui/use-dialog";
import {
  CredentialCard,
  CredentialManageActions,
} from "~/features/github/credential-card";
import type { MembershipView } from "./membership.server";
import type { SettingsViewData } from "./settings-query.server";

/**
 * Project Settings view (design/html-app/app/settings.jsx → 1:1 port,
 * project-settings spec): project identity, workflow-stages editor
 * (rename / HTML5-DnD reorder / add / remove with triage+done locks),
 * members panel (invite/remove — roles live in Policy), repository &
 * credentials (shared CredentialCard + the real Grant-scope flow), danger
 * zone. All governed state comes from the loader; every mutation is a
 * route-action POST (no optimistic UI). Client-side guard toasts mirror
 * the mock; the server re-checks every guard.
 */

type ActionResult =
  | { ok: true; toast: string; stageId?: string }
  | { ok: false; error: string };

function useActionToast(fetcher: FetcherWithComponents<ActionResult>) {
  const push = useToast();
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    const d = fetcher.data;
    if (d.ok) {
      if (d.toast) push(d.toast);
    } else if (d.error) {
      push(d.error);
    }
  }, [fetcher.state, fetcher.data, push]);
}

const PANEL_COUNT_STYLE = { fontSize: ".76rem", color: "var(--faint)" } as const;
const POL_NOTE_STYLE = { marginBottom: 0, marginTop: ".8rem" } as const;

/**
 * Client mirror of the server stage-lock guard: the entry (first) and terminal
 * (last) stages are structural and can't be removed — pinned by position, not
 * literal id, so custom/lightweight boards behave the same.
 */
function stageLockReason(
  stageId: string,
  stages: readonly { id: string }[],
): string | null {
  if (stages.length === 0) return null;
  if (stageId === stages[0]!.id) return "it's the entry point";
  if (stageId === stages[stages.length - 1]!.id)
    return "human acceptance stays terminal";
  return null;
}

// ------------------------------------------------------------------ project

export function ProjectPanel({
  project,
  canManage,
  onSave,
}: {
  project: SettingsViewData["project"];
  canManage: boolean;
  onSave: (fields: { name: string; prefix: string; description: string }) => void;
}) {
  // Revalidation resync (a save or an SSE-driven reload brings new values)
  // happens by remount: the render site keys this panel on the identity
  // fields, so state re-seeds from the loader instead of a sync effect.
  const [name, setName] = useState(project.name);
  const [prefix, setPrefix] = useState(project.prefix);
  const [desc, setDesc] = useState(project.description);

  const saveIfDirty = () => {
    if (
      name.trim() === project.name &&
      prefix === project.prefix &&
      desc.trim() === project.description
    ) {
      return; // only save when dirty (spec §7.2)
    }
    onSave({ name, prefix, description: desc });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="board" />
        <h2>Project</h2>
      </div>
      <div className="set-fields">
        <div className="field-row" style={{ gridTemplateColumns: "1fr 120px" }}>
          <div className="field">
            <label className="flabel" htmlFor="set-project-name">
              Project name
            </label>
            <input
              id="set-project-name"
              type="text"
              value={name}
              disabled={!canManage}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveIfDirty}
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="set-project-prefix">
              Task prefix
            </label>
            <input
              id="set-project-prefix"
              type="text"
              className="mono"
              value={prefix}
              disabled={!canManage}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().slice(0, 4))}
              onBlur={saveIfDirty}
            />
          </div>
        </div>
        <div className="field">
          <label className="flabel" htmlFor="set-project-desc">
            Description
          </label>
          <textarea
            id="set-project-desc"
            rows={2}
            value={desc}
            disabled={!canManage}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={saveIfDirty}
          ></textarea>
        </div>
      </div>
      <div className="kv" style={{ marginTop: ".4rem" }}>
        <div className="kv-row">
          <span className="k">Task keys</span>
          <span className="v">
            <span className="mono">{prefix}-###</span>
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Canonical task file</span>
          <span className="v">
            <Icon name="file" />
            <span className="mono">{project.taskFilePattern}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- stages

export function StagesPanel({
  stages,
  counts,
  canManage,
  editingId,
  setEditingId,
  onRename,
  onReorder,
  onAdd,
  onRemove,
  onNavPolicy,
}: {
  stages: SettingsViewData["stages"];
  counts: Record<string, number>;
  canManage: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  onRename: (stageId: string, name: string) => void;
  onReorder: (orderedIds: string[]) => void;
  onAdd: () => void;
  onRemove: (stageId: string) => void;
  onNavPolicy: () => void;
}) {
  const push = useToast();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const count = (id: string) => counts[id] ?? 0;

  const commitName = (s: { id: string; name: string }, raw: string) => {
    setEditingId(null);
    const v = raw.trim();
    if (!v || v === s.name) return;
    onRename(s.id, v);
  };

  const remove = (s: { id: string; name: string }) => {
    const locked = stageLockReason(s.id, stages);
    if (locked) {
      push(`${s.name} can't be removed — ${locked}`);
      return;
    }
    const n = count(s.id);
    if (n > 0) {
      push(`Move ${n} ${n === 1 ? "task" : "tasks"} out of ${s.name} first`);
      return;
    }
    onRemove(s.id);
  };

  const drop = (targetId: string) => {
    const src = dragId;
    setDragId(null);
    setOverId(null);
    if (!src || src === targetId) return;
    const reordered = [...stages];
    const [moved] = reordered.splice(reordered.findIndex((s) => s.id === src), 1);
    reordered.splice(reordered.findIndex((s) => s.id === targetId), 0, moved!);
    // Entry stays first, terminal stays last (the server re-applies this
    // regardless), pinned by current identity not literal ids.
    const entryId = stages[0]?.id;
    const terminalId = stages[stages.length - 1]?.id;
    const next = [
      reordered.find((s) => s.id === entryId),
      ...reordered.filter((s) => s.id !== entryId && s.id !== terminalId),
      reordered.find((s) => s.id === terminalId),
    ].filter((s): s is NonNullable<typeof s> => Boolean(s));
    onReorder(next.map((s) => s.id));
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="branch" />
        <h2>Workflow stages</h2>
        <span className="right sub" style={PANEL_COUNT_STYLE}>
          {stages.length} stages
        </span>
      </div>
      <div className="stg-list">
        {stages.map((s) => {
          const locked = stageLockReason(s.id, stages);
          const n = count(s.id);
          return (
            <div
              className={
                "stg-row" +
                (dragId === s.id ? " dragging" : "") +
                (overId === s.id && dragId !== s.id ? " over" : "")
              }
              key={s.id}
              draggable={canManage && !locked && editingId !== s.id}
              onDragStart={(e) => {
                setDragId(s.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (overId !== s.id) setOverId(s.id);
              }}
              onDragLeave={() => {
                if (overId === s.id) setOverId(null);
              }}
              onDrop={() => drop(s.id)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              <span
                className={"stg-handle" + (locked ? " off" : "")}
                title={locked ? `${s.name} is fixed — ${locked}` : "Drag to reorder"}
              >
                <Icon name={locked ? "lock" : "grip"} />
              </span>
              <span className="sdot" style={{ background: s.color }}></span>
              {editingId === s.id ? (
                <input
                  type="text"
                  className="stg-input"
                  aria-label={"Rename " + s.name}
                  defaultValue={s.name}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => commitName(s, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="stg-name"
                  title="Rename stage"
                  disabled={!canManage}
                  onClick={() => setEditingId(s.id)}
                >
                  {s.name}
                </button>
              )}
              <span className="stg-count">
                {n} {n === 1 ? "task" : "tasks"}
              </span>
              <button
                type="button"
                className={"stg-x" + (locked ? " off" : "")}
                aria-label={"Remove " + s.name}
                title={
                  locked
                    ? `${s.name} is a required ${s.id === stages[0]?.id ? "entry" : "terminal"} stage and can't be removed`
                    : "Remove stage"
                }
                // F10-22: entry/terminal stages are model-locked; the control is
                // truly disabled (not just greyed) so it never looks actionable.
                disabled={!canManage || Boolean(locked)}
                onClick={() => remove(s)}
              >
                <Icon name="x" />
              </button>
            </div>
          );
        })}
      </div>
      {canManage && (
        <button
          type="button"
          className="btn ghost sm"
          style={{ width: "100%", marginTop: ".8rem" }}
          onClick={onAdd}
        >
          <Icon name="plus" />
          Add stage
        </button>
      )}
      <div className="pol-note" style={POL_NOTE_STYLE}>
        <Icon name="shield" />
        <span>
          Drag to reorder · click a name to rename. Who may move tasks between
          stages is set in{" "}
          <button type="button" className="keybtn" onClick={onNavPolicy}>
            Policy → Workflow rules
          </button>
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ members

export function MembersPanel({
  members,
  meId,
  projectName,
  canManage,
  busy,
  onInvite,
  onRemove,
  onNavPolicy,
}: {
  members: MembershipView[];
  meId: string | null;
  projectName: string;
  canManage: boolean;
  busy: boolean;
  onInvite: (name: string, email: string) => void;
  onRemove: (member: MembershipView) => void;
  onNavPolicy: () => void;
}) {
  const push = useToast();
  const [nm, setNm] = useState("");
  const [em, setEm] = useState("");

  const invite = () => {
    const name = nm.trim();
    const email = em.trim().toLowerCase();
    if (!name || !email.includes("@")) {
      push("Enter a name and a valid email");
      return;
    }
    if (members.some((m) => m.email.toLowerCase() === email)) {
      push(`${email} is already a member`);
      return;
    }
    onInvite(name, email);
    setNm("");
    setEm("");
  };

  const remove = (m: MembershipView) => {
    if (m.userId === meId) {
      push(`You can't remove yourself from ${projectName}`);
      return;
    }
    if (
      m.role === "admin" &&
      members.filter((x) => x.role === "admin").length <= 1
    ) {
      push(`${m.name} is the only admin — assign another admin in Policy first`);
      return;
    }
    onRemove(m);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Members</h2>
        <span className="right sub" style={PANEL_COUNT_STYLE}>
          {members.length} active
        </span>
      </div>
      <div className="member-list" style={{ marginBottom: 0 }}>
        {members.map((m) => (
          <div className="member-row" key={m.userId}>
            <Avatar person={{ initials: m.initials, tone: m.tone }} />
            <span className="member-main">
              <div className="nm">
                {m.name}
                {m.userId === meId && <span className="you-tag">you</span>}
              </div>
              <div className="em">{m.email}</div>
            </span>
            {canManage && (
              <button
                type="button"
                className="stg-x"
                aria-label={"Remove " + m.name}
                title="Remove member"
                disabled={busy}
                onClick={() => remove(m)}
              >
                <Icon name="x" />
              </button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="invite-row">
          <input
            type="text"
            placeholder="Full name"
            value={nm}
            onChange={(e) => setNm(e.target.value)}
          />
          <input
            type="text"
            placeholder="email@company.dev"
            value={em}
            onChange={(e) => setEm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") invite();
            }}
          />
          <button type="button" className="btn sm" onClick={invite} disabled={busy}>
            <Icon name="send" />
            Invite
          </button>
        </div>
      )}
      <div className="pol-note" style={POL_NOTE_STYLE}>
        <Icon name="shield" />
        <span>
          New members join as Viewer. Roles are managed in{" "}
          <button type="button" className="keybtn" onClick={onNavPolicy}>
            Policy → Human access
          </button>
        </span>
      </div>
    </div>
  );
}

// -------------------------------------------------- repository & credentials

export function RepoPanel({
  repo,
  override,
  credential,
  canOverride,
  canGrant,
  busy,
  credBusy,
  onToggleOverride,
  onGrantScope,
  onSetCredential,
  onClearCredential,
  onOpenTask,
}: {
  repo: string | null;
  override: boolean;
  credential: SettingsViewData["credential"];
  canOverride: boolean;
  canGrant: boolean;
  busy: boolean;
  credBusy: boolean;
  onToggleOverride: () => void;
  onGrantScope: () => void;
  onSetCredential: () => void;
  onClearCredential: () => void;
  onOpenTask: (taskKey: string) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="github" />
        <h2>Repository &amp; credentials</h2>
      </div>
      <div className="kv">
        <div className="kv-row">
          <span className="k">Default repository</span>
          <span className="v">
            <Icon name="github" />
            {repo ? (
              <span className="mono">{repo}</span>
            ) : (
              <span style={{ color: "var(--placeholder)", fontSize: ".8rem" }}>
                —
              </span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Task-level override</span>
          <span className="v" style={{ gap: ".6rem" }}>
            <span
              style={{
                fontSize: ".78rem",
                color: "var(--faint)",
                fontFamily: "var(--font-body)",
                fontWeight: 400,
              }}
            >
              {override
                ? "tasks may attach a different repo"
                : "all tasks use the default"}
            </span>
            {canOverride ? (
              <TglP
                on={override}
                onChange={onToggleOverride}
                label="Task-level repository override"
              />
            ) : (
              <span style={{ fontSize: ".78rem", color: "var(--faint)" }}>
                {override ? "on" : "off"}
              </span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Repos per task</span>
          <span className="v">1 · V1 limit</span>
        </div>
      </div>

      <CredentialCard
        credential={credential}
        onOpenTask={onOpenTask}
        warnActions={
          canGrant ? (
            <button
              type="button"
              className="btn sm"
              style={{ marginLeft: "auto" }}
              onClick={onGrantScope}
              disabled={busy}
              title="Re-check the credential's scopes against GitHub"
            >
              <Icon name="check" />
              Grant scope
            </button>
          ) : undefined
        }
        manageActions={
          <CredentialManageActions
            configured={credential.source === "pat"}
            canManage={canGrant}
            busy={credBusy}
            onSet={onSetCredential}
            onClear={onClearCredential}
          />
        }
      />
    </div>
  );
}

// -------------------------------------------------------------- danger zone

function DeleteProjectDialog({
  projectName,
  busy,
  onCancel,
  onConfirm,
}: {
  projectName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (confirmName: string) => void;
}) {
  const { ref: dialogRef, close } = useDialog(onCancel);
  const [confirmName, setConfirmName] = useState("");
  const matches = confirmName.trim() === projectName;
  return (
    // Native <dialog>: Escape, backdrop-click light-dismiss, scroll lock, and
    // focus restore come from useDialog + showModal(); role="alertdialog"
    // keeps the stronger semantics.
    <dialog
      className="confirm-card"
      role="alertdialog"
      aria-label="Delete project"
      ref={dialogRef}
    >
      <div className="confirm-icon">
        <Icon name="alert" />
      </div>
      <h3>Delete {projectName}?</h3>
      <p>
        Removes tasks, timelines, and audit logs. This cannot be undone.
        Type <strong>{projectName}</strong> to confirm.
      </p>
      <div className="field" style={{ marginTop: ".6rem" }}>
        <input
          type="text"
          value={confirmName}
          autoFocus
          placeholder={projectName}
          onChange={(e) => setConfirmName(e.target.value)}
        />
      </div>
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={!matches || busy}
          style={!matches ? { opacity: 0.5, pointerEvents: "none" } : undefined}
          onClick={() => onConfirm(confirmName)}
        >
          <Icon name="x" />
          Delete project
        </button>
      </div>
    </dialog>
  );
}

export function DangerZone({
  projectName,
  myRole,
  archived,
  busy,
  onArchive,
  onDelete,
}: {
  projectName: string;
  myRole: string | null;
  archived: boolean;
  busy: boolean;
  onArchive: (archived: boolean) => void;
  onDelete: (confirmName: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const isAdmin = myRole === "admin";

  return (
    <div className="panel danger-panel">
      <div className="panel-head">
        <Icon name="alert" />
        <h2>Danger zone</h2>
      </div>
      <div className="dz-row">
        <span className="dz-main">
          <div className="dn">
            {archived ? `Restore ${projectName}` : `Archive ${projectName}`}
          </div>
          <div className="dd">
            {archived
              ? "This project is archived — hidden from the workspace. Restore it to make it active again."
              : "Hides the project from the workspace and moves it to the Home “Archived” section. Timelines are preserved and it can be restored anytime."}
          </div>
        </span>
        <button
          type="button"
          className="btn ghost sm"
          // F10-34: destructive project actions are project-admin only. A
          // viewer/maintainer must not see an actionable control; the server
          // still enforces edit-policy.
          disabled={busy || !isAdmin}
          title={isAdmin ? undefined : "Only a project admin can archive this project"}
          onClick={() => onArchive(!archived)}
        >
          {archived ? "Restore" : "Archive"}
        </button>
      </div>
      <div className="dz-row">
        <span className="dz-main">
          <div className="dn">Delete project</div>
          <div className="dd">
            Removes tasks, timelines, and audit logs. This cannot be undone.
          </div>
        </span>
        <button
          type="button"
          className="btn danger sm"
          // F10-34: project-admin only; disabled for everyone else so the
          // typed-confirm dialog can never be opened without authority.
          disabled={busy || !isAdmin}
          title={isAdmin ? undefined : "Only a project admin can delete this project"}
          onClick={() => setConfirming(true)}
        >
          Delete project
        </button>
      </div>
      {confirming && (
        <DeleteProjectDialog
          projectName={projectName}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={(confirmName) => {
            setConfirming(false);
            onDelete(confirmName);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- page

export function SettingsPage({
  data,
  meId,
  myRole,
}: {
  data: SettingsViewData;
  meId: string | null;
  myRole: string | null;
}) {
  const navigate = useNavigate();
  const csrf = useCsrfToken();
  const identityFetcher = useFetcher<ActionResult>();
  const stageFetcher = useFetcher<ActionResult>();
  const memberFetcher = useFetcher<ActionResult>();
  const repoFetcher = useFetcher<ActionResult>();
  const credFetcher = useFetcher<ActionResult>();
  const dangerFetcher = useFetcher<ActionResult>();
  useActionToast(identityFetcher);
  useActionToast(stageFetcher);
  useActionToast(memberFetcher);
  useActionToast(repoFetcher);
  useActionToast(credFetcher);
  useActionToast(dangerFetcher);

  const isAdmin = myRole === "admin";
  const canGrant = myRole === "admin" || myRole === "maintainer";
  const slug = data.project.slug;

  // Stage rename edit-mode lives here so a fresh add-stage response can
  // drop the new row straight into edit mode (mock behavior).
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const autoEdited = useRef<unknown>(null);
  useEffect(() => {
    if (stageFetcher.state !== "idle" || !stageFetcher.data) return;
    if (autoEdited.current === stageFetcher.data) return;
    autoEdited.current = stageFetcher.data;
    if (stageFetcher.data.ok && stageFetcher.data.stageId) {
      setEditingStageId(stageFetcher.data.stageId);
    }
  }, [stageFetcher.state, stageFetcher.data]);

  const onNavPolicy = () => navigate(`/projects/${slug}/policy`);
  const onOpenTask = (taskKey: string) =>
    navigate(`/projects/${slug}/tasks/${taskKey}`);

  return (
    <div className="board-wrap" data-screen-label="Settings">
      <div className="board-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">Board configuration for {data.project.name}</div>
        </div>
      </div>
      <div className="policy-wrap">
        <div className="policy-cols">
          <ProjectPanel
            // Remount (resetting the edit fields) whenever the loader's
            // identity fields change — replaces the old resync effect.
            key={`${data.project.name}\u0000${data.project.prefix}\u0000${data.project.description}`}
            project={data.project}
            canManage={isAdmin}
            onSave={(fields) =>
              identityFetcher.submit(
                { intent: "save-project", _csrf: csrf, ...fields },
                { method: "post" },
              )
            }
          />
          <StagesPanel
            stages={data.stages}
            counts={data.stageCounts}
            canManage={isAdmin}
            editingId={editingStageId}
            setEditingId={setEditingStageId}
            onRename={(stageId, name) =>
              stageFetcher.submit(
                { intent: "rename-stage", _csrf: csrf, stageId, name },
                { method: "post" },
              )
            }
            onReorder={(orderedIds) =>
              stageFetcher.submit(
                {
                  intent: "reorder-stages",
                  _csrf: csrf,
                  orderedIds: orderedIds.join(","),
                },
                { method: "post" },
              )
            }
            onAdd={() =>
              stageFetcher.submit(
                { intent: "add-stage", _csrf: csrf },
                { method: "post" },
              )
            }
            onRemove={(stageId) =>
              stageFetcher.submit(
                { intent: "remove-stage", _csrf: csrf, stageId },
                { method: "post" },
              )
            }
            onNavPolicy={onNavPolicy}
          />
        </div>
        <div className="policy-cols">
          <MembersPanel
            members={data.members}
            meId={meId}
            projectName={data.project.name}
            canManage={isAdmin}
            busy={memberFetcher.state !== "idle"}
            onInvite={(name, email) =>
              memberFetcher.submit(
                { intent: "invite", _csrf: csrf, name, email },
                { method: "post" },
              )
            }
            onRemove={(member) =>
              memberFetcher.submit(
                { intent: "remove-member", _csrf: csrf, userId: member.userId },
                { method: "post" },
              )
            }
            onNavPolicy={onNavPolicy}
          />
          <RepoPanel
            repo={data.project.repo}
            override={data.repoOverride}
            credential={data.credential}
            canOverride={isAdmin}
            canGrant={canGrant}
            busy={repoFetcher.state !== "idle"}
            credBusy={credFetcher.state !== "idle"}
            onToggleOverride={() =>
              repoFetcher.submit(
                {
                  intent: "override",
                  _csrf: csrf,
                  enabled: String(!data.repoOverride),
                },
                { method: "post" },
              )
            }
            onGrantScope={() =>
              repoFetcher.submit(
                { intent: "grant-scope", _csrf: csrf },
                { method: "post" },
              )
            }
            onSetCredential={() =>
              credFetcher.submit(
                { intent: "set-credential", _csrf: csrf },
                { method: "post" },
              )
            }
            onClearCredential={() =>
              credFetcher.submit(
                { intent: "clear-credential", _csrf: csrf },
                { method: "post" },
              )
            }
            onOpenTask={onOpenTask}
          />
        </div>
        <DangerZone
          projectName={data.project.name}
          myRole={myRole}
          archived={data.project.archived}
          busy={dangerFetcher.state !== "idle"}
          onArchive={(archived) =>
            dangerFetcher.submit(
              { intent: "archive-project", _csrf: csrf, archived: String(archived) },
              { method: "post" },
            )
          }
          onDelete={(confirmName) =>
            dangerFetcher.submit(
              { intent: "delete-project", _csrf: csrf, confirmName },
              { method: "post" },
            )
          }
        />
      </div>
    </div>
  );
}
