import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useNavigate, useSearchParams } from "react-router";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { resolveDeclaredStages } from "~/shared/workflow/stage-eligibility";
import { countLabel } from "~/shared/text/plural";
import type { BackendCredentialHealth } from "~/server/runtimes/runtime-registry.server";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import {
  deploymentDot,
  deploymentStatusKind,
  profileRoleLabel,
  type AgentDeploymentView,
  type AgentProfileView,
  type LibraryProfileView,
} from "./agent-types";
import {
  CAP_META,
  GOVERNED_CAP_LABELS,
  type ResCatalogGroup,
} from "./capability-catalog";
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

/** The board's workflow edges — what `resolveDeclaredStages` needs to map a
 *  declared stage id onto THIS board by structural role (R14-1). */
export interface WorkflowEdgeView {
  from: string;
  to: string;
}

// ------------------------------------------------------------ small parts

/**
 * F16: per-backend credential health, as the server's ONE answer to it
 * (`backendCredentialHealth` in runtime-registry.server.ts — the same source the
 * run service and the logs read). Absent ⇒ unknown here, and nothing is claimed
 * either way; the page never invents a second, quietly divergent check.
 */
export type BackendHealthMap = Partial<
  Record<"codex" | "claude", BackendCredentialHealth>
>;

/** The backend a run would actually resolve — the profile's FIRST (the
 *  "a run uses the first" rule the runtime row already states). */
function primaryBackend(a: AgentProfileView): "codex" | "claude" | null {
  return a.backends[0] ?? null;
}

/** The health entry for a profile's primary backend, or null when the page has
 *  no health data (or the profile has no backend — the operator's
 *  orchestration runtime). */
function primaryBackendHealth(
  a: AgentProfileView,
  health: BackendHealthMap | undefined,
): BackendCredentialHealth | null {
  const backend = primaryBackend(a);
  if (!backend || !health) return null;
  return health[backend] ?? null;
}

function BackendChip({
  b,
  health,
}: {
  b: string;
  /** Undefined = not probed on this surface; nothing is claimed. */
  health?: BackendCredentialHealth | undefined;
}) {
  // Mirrors the task-level Execution profile panel verbatim ("Codex — not
  // configured"), which was already telling this truth while this page said
  // "available" about the same profile. `.model-sub` is the runtime row's
  // existing "this value is not what it looks like" badge (the model cell's
  // DEFAULT flag) — same amber, same alert glyph, same cursor:help, no new
  // class name with no rule behind it.
  const missing = health ? !health.available : false;
  return (
    <span className="be-chip">
      <AgentGlyph backend={b} />
      {b === "claude" ? "Claude Code" : "Codex"}
      {missing && (
        <span
          className="model-sub"
          {...(health?.detail ? { title: health.detail } : {})}
        >
          <Icon name="alert" />
          not configured
        </span>
      )}
    </span>
  );
}

function ProfileGlyph({ a, lg }: { a: AgentProfileView; lg?: boolean }) {
  return (
    <span
      className={
        "agent-glyph" + (lg ? " lg" : "") + (a.kind === "operator" ? " op" : "")
      }
      title={profileRoleLabel(a.name, a.role, a.kind)}
    >
      <Icon name={a.icon as IconName} />
    </span>
  );
}

function ActiveBadge({
  count,
  unusable,
}: {
  count: number;
  /** F16: the profile's backend holds no credential — every run it is given
   *  refuses before it starts, so "idle" alone is a half-truth. */
  unusable?: string | undefined;
}) {
  if (count > 0)
    return (
      <span className="ag-active">
        <span className="working" />
        {count}
      </span>
    );
  if (unusable)
    return (
      <span className="model-sub" title={unusable}>
        <Icon name="alert" />
        no runtime
      </span>
    );
  return <span className="ag-idle">idle</span>;
}

function ProfileItem({
  a,
  count,
  health,
  on,
  onClick,
}: {
  a: AgentProfileView;
  count: number;
  health?: BackendHealthMap | undefined;
  on: boolean;
  onClick: () => void;
}) {
  const backendHealth = primaryBackendHealth(a, health);
  const unusable =
    backendHealth && !backendHealth.available
      ? (backendHealth.detail ??
        `${backendHealth.backend === "claude" ? "Claude Code" : "Codex"} is not configured on this instance — runs for this profile would fail.`)
      : undefined;
  return (
    <button type="button" className={"ag-item" + (on ? " on" : "")} onClick={onClick}>
      <ProfileGlyph a={a} />
      <span className="ag-item-main">
        <span className="nm">{a.name}</span>
        <span className="sub">{profileRoleLabel(a.name, a.role, a.kind)}</span>
      </span>
      <ActiveBadge count={count} unusable={unusable} />
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
  known,
}: {
  label: string;
  icon: IconName;
  items: string[];
  /** P14-KM-11: the ids the store actually holds. `undefined` = unknown here, so
   *  nothing is marked (never invent a "missing" state from missing data). */
  known?: ReadonlySet<string>;
}) {
  return (
    <div className="res-group">
      <div className="lbl">{label}</div>
      <div className="res-chips">
        {items.length ? (
          items.map((x) => {
            // A grant naming a resource the store no longer has reaches the run
            // as nothing at all — live, a renamed MCP left this panel painting a
            // healthy chip while the agent found zero tools under that name.
            const missing = known ? !known.has(x) : false;
            return (
            <span
              className={missing ? "res-chip missing" : "res-chip"}
              key={x}
              {...(missing
                ? { title: `${x} is no longer in the store — this grant reaches no run` }
                : {})}
            >
              <Icon name={missing ? "alert" : icon} />
              {x}
              {missing && <span className="res-chip-note">missing</span>}
            </span>
            );
          })
        ) : (
          <span className="sub fine md dim">None</span>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------- delete confirm

/**
 * UX19-11 — the last guardrail before an irreversible policy change says what
 * actually happens.
 *
 * It used to read "those threads keep running until the operator reassigns
 * them", and both halves were false:
 *
 *  - `activeCount` counts ENGAGEMENTS on every non-archived, non-terminal task
 *    (`agent-deployments.server.ts`), most of them idle — "keep running"
 *    describes only a run already in flight. What the next run gets is ruling
 *    26 (R15-7): a profile that can no longer be resolved is FULLY conservative
 *    — `resolveUndeployedDisallowedTools()` and `withheldAgentGrants()`
 *    (`specialist-run.server.ts:760`, `:833`), i.e. no delivery, no comments,
 *    no ask-human, no evidence. The thread runs and produces nothing anyone can
 *    act on, which is the opposite of the continuity the copy promised.
 *  - "until the operator reassigns them" describes an automatic recovery that
 *    nothing initiates. `deleteAgentProfile`
 *    (`agent-profile-actions.server.ts:605-650`) edits `project.md`, reprojects
 *    and audits — it queues no operator run, writes no task timeline event and
 *    sends no notification. Reassignment is real (`assignSpecialist`), but only
 *    if a human goes and does it, so the dialog names it as their next step.
 */
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
            </strong>
            . Those engagements stay on the tasks, and nothing reassigns them
            for you — until someone assigns a replacement from each task's
            Execution profile, runs there can't deliver, comment, ask a question
            or attach evidence.
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
 * Eligibility mirrors `specialistEligibleForStage` exactly, and since R14-1
 * that means resolving through the SHARED `resolveDeclaredStages` — literal id,
 * then structural role, then "means nothing here → unrestricted". Re-deriving
 * it locally is what made the panel and the run guard disagree in the first
 * place, so this panel now asks the same function the guard does.
 */
export function StageEligibility({
  a,
  stages,
  workflow,
}: {
  a: AgentProfileView;
  stages: StageView[];
  workflow: WorkflowEdgeView[];
}) {
  const resolved = resolveDeclaredStages(a.stages, stages, workflow);
  // Rule 3 of the shared contract: a declaration that resolves to nothing on
  // this board says nothing about this workflow, so the profile is unrestricted
  // here — exactly as `stageEligible` treats it at run time.
  const unrestricted = a.spanAll || a.stages.length === 0 || resolved.length === 0;
  const onBoard = resolved.length;
  // A declared id is STALE only when it lands nowhere ON ITS OWN — asking the
  // shared resolver one id at a time is the only honest test, because a role
  // match (`impl` → this board's work stage) resolves to a DIFFERENT id than the
  // one declared and would otherwise look dead.
  const stale = a.stages.filter(
    (id) => resolveDeclaredStages([id], stages, workflow).length === 0,
  );
  const summary = a.spanAll
    ? "active across the whole lifecycle"
    : a.stages.length === 0
      ? "no stage restriction — eligible everywhere"
      : resolved.length === 0
        ? "declared stages don't exist here — eligible everywhere"
        : `${onBoard} of ${countLabel(stages.length, "stage")}`;
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="board" />
        <h2>Eligible stages</h2>
        <span className="right sub fine">{summary}</span>
      </div>
      <div className="stage-chips">
        {stages.map((s) => {
          const elig = unrestricted || resolved.includes(s.id);
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
            title={`This profile grants the stage “${id}”, which is neither a stage on this board nor a role any stage here fills — the grant does nothing.`}
          >
            <span className="sdot" />
            {id} · not on this board
          </span>
        ))}
      </div>
      {/* R14-1: a declaration that resolves to nothing here no longer disables
          the profile — silently disabling every agent on a re-templated board is
          the failure we actually observed (Lightweight Lab, ids todo/doing/done).
          It DOES mean the declaration is dead weight, so say so. */}
      {!a.spanAll && a.stages.length > 0 && resolved.length === 0 && (
        <div className="empty xs">
          None of this profile's declared stages ({a.stages.join(", ")}) exist on
          this board, by id or by role — the declaration says nothing here, so
          the profile is eligible everywhere. Edit it to restrict the profile to
          this board's stages.
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
  stages,
  workflow,
  projectName,
  busy,
  onClose,
  onAdd,
}: {
  library: LibraryProfileView[];
  /** THIS board's stages + workflow. P14-UI-63: the row used to print the
   *  template's own `stages.length`, which describes the ORG template and not
   *  the board it is about to land on — so a project whose stages were renamed
   *  read "2 stages" here and, one click later, "None of this profile's
   *  declared stages exist on this board" in the roster. Resolve against the
   *  target board (R14-1) so the promise and the outcome are the same number. */
  stages: StageView[];
  workflow: WorkflowEdgeView[];
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
          <div className="empty sm">
            Every global profile is already deployed here. Create more in org
            settings → Global agent profiles.
          </div>
        ) : (
          <div className="deploy-list">
            {library.map((t) => {
              const here = resolveDeclaredStages(t.stages, stages, workflow);
              // Mirrors the roster's own reading of the same declaration: no
              // restriction (or one that means nothing here) = every stage.
              const everywhere =
                t.spanAll || t.stages.length === 0 || here.length === 0;
              return (
                <button
                  type="button"
                  className="deploy-row"
                  key={t.id}
                  disabled={busy}
                  onClick={() => onAdd(t.id)}
                >
                  <span className="deploy-eng">
                    {profileRoleLabel(t.name, t.role, "specialist")}
                  </span>
                  <span className="deploy-task">
                    <span className="key mono">{t.name}</span> {t.desc}
                  </span>
                  {t.backends.map((b) => (
                    <BackendChip key={b} b={b} />
                  ))}
                  <Pill kind="neutral" sm>
                    {everywhere
                      ? "every stage here"
                      : `${here.length} stage${here.length === 1 ? "" : "s"} here`}
                  </Pill>
                </button>
              );
            })}
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
  workflow,
  resourceCatalog,
  backendHealth,
  insts,
  projectName,
  canManage,
  onOpen,
  onDelete,
  onEdit,
}: {
  a: AgentProfileView;
  stages: StageView[];
  /** R14-1: the board's edges — eligibility resolves by structural role too. */
  workflow: WorkflowEdgeView[];
  /** F16: per-backend credential health from `backendCredentialHealth`. */
  backendHealth?: BackendHealthMap | undefined;
  /** P14-KM-11: the live store catalog, so a grant naming a resource the store
   *  no longer holds renders as missing rather than healthy. */
  resourceCatalog?: readonly ResCatalogGroup[];
  insts: AgentDeploymentView[];
  projectName: string;
  canManage: boolean;
  onOpen: (taskKey: string) => void;
  onDelete: (id: string) => void;
  onEdit: (a: AgentProfileView) => void;
}) {
  const activeKeys = [...new Set(insts.map((d) => d.taskKey))];
  const [confirm, setConfirm] = useState(false);
  // F16: "idle · available" was the page's answer no matter what — live, a
  // Codex profile on an instance with no Codex credential read "idle ·
  // available" here while the task-level Execution panel, one click away, read
  // "Codex — not configured". Availability is two claims, and only one of them
  // is about engagements: nothing is running it, AND a run could start. The
  // second is the backend's to answer.
  const runHealth = primaryBackendHealth(a, backendHealth);
  const backendMissing = runHealth !== null && !runHealth.available;
  const backendLabel = runHealth?.backend === "claude" ? "Claude Code" : "Codex";
  // F15-05/F15-06: the capability columns show GOVERNED policy only — the same
  // partition the matrix draws between its curated groups and "Other actions".
  // A grant with no runtime consumer (advisory catalog id, bespoke extra) is
  // guidance and says so; it never renders as "Acts directly" beside the
  // capabilities that actually bind. The buckets themselves already come from
  // the one server-side interpretation of the stored grants
  // (`capabilitiesToActionLabels`), verdict outcomes gated included.
  const isGoverned = (label: string) => GOVERNED_CAP_LABELS.has(label);
  const governed = {
    direct: a.actions.direct.filter(isGoverned),
    recommend: a.actions.recommend.filter(isGoverned),
    forbidden: a.actions.forbidden.filter(isGoverned),
  };
  // The advisory line keeps each label's MODE. Concatenating the three buckets
  // lost it, so an advisory capability an admin explicitly set to human-only
  // read exactly like one left at "acts directly" — the matrix still tells them
  // apart, which is the F15-05 disagreement class one level quieter.
  const advisory = [
    ...a.actions.direct.map((label) => ({ label, mode: CAP_META.direct.label })),
    ...a.actions.recommend.map((label) => ({
      label,
      mode: CAP_META.recommend.label,
    })),
    ...a.actions.forbidden.map((label) => ({
      label,
      mode: CAP_META.forbidden.label,
    })),
  ].filter(({ label }) => !isGoverned(label));
  // P14-KM-11: what the store actually holds, per resource kind. Absent catalog
  // ⇒ undefined ⇒ nothing is marked missing (see ResGroup).
  const known = (key: string): ReadonlySet<string> | undefined => {
    const group = resourceCatalog?.find((g) => g.key === key);
    return group ? new Set(group.items.map((i) => i.id)) : undefined;
  };
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
            {/* The page's ONE h1 is "Agents" (this is a master-detail layout, and
                every other surface in the app has exactly one). The selected
                profile is a section within it. */}
            <h2 className="ag-hero-name">{a.name}</h2>
            <Pill kind={a.kind === "operator" ? "agent" : "neutral"} sm>
              {profileRoleLabel(a.name, a.role, a.kind)}
            </Pill>
            {activeKeys.length > 0 ? (
              <span className="ag-running">
                <span className="working" />
                running on {countLabel(activeKeys.length, "task")}
              </span>
            ) : backendMissing ? (
              <Pill kind="risk" sm>
                idle · {backendLabel} not configured
              </Pill>
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

      <StageEligibility a={a} stages={stages} workflow={workflow} />

      <div className="panel">
        <div className="panel-head">
          <Icon name="shield" />
          <h2>Capability policy</h2>
        </div>
        <div className="cap-cols">
          <CapColumn group="direct" items={governed.direct} />
          <CapColumn group="recommend" items={governed.recommend} />
          <CapColumn group="forbidden" items={governed.forbidden} />
        </div>
        {advisory.length > 0 && (
          /* R15-12: these were disclosed inline, above the fold, next to the
             grants that actually bind — so a Docs writer's panel led with
             "Move the task to Review (acts directly)" as advisory, which reads
             as a contradiction of the policy right above it. Hiding them was
             the other option and was rejected: an omission the reader cannot
             see is worse than an awkward truth. Collapsed, not removed — the
             count is always visible and one click shows every line. */
          <details className="cap-advisory">
            <summary>
              <Icon name="shield" />
              <span>
                Advisory only · {countLabel(advisory.length, "line")} the runtime
                does not read
              </span>
            </summary>
            <div className="cap-advisory-body">
              <p>
                These describe how the profile is meant to work. Nothing in the
                runtime enforces them, so they never grant or refuse anything —
                the binding policy is the three columns above.
              </p>
              <ul>
                {advisory.map((x) => (
                  <li key={x.label}>
                    {x.label} <span className="fhint">({x.mode.toLowerCase()})</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <Icon name="cpu" />
          <h2>Context resources &amp; runtime</h2>
        </div>
        <div className="res-groups">
          <ResGroup label="Skills" icon="bolt" items={a.resources.skills} known={known("skills")} />
          <ResGroup label="MCP servers" icon="cpu" items={a.resources.mcps} known={known("mcps")} />
          <ResGroup label="Knowledge bases" icon="file" items={a.resources.kb} known={known("kb")} />
        </div>
        <div className="runtime-row">
          <div className="rt-cell">
            <div className="lbl">
              Execution backend
              {a.backends.length > 1 && (
                <span className="fhint"> · a run uses the first</span>
              )}
            </div>
            <div className="rt-val">
              {/* P13-UI-52: a multi-backend profile listed both chips as if the
                  agent could run on either at will. A run resolves ONE backend
                  (the deployment's first), so the list is a capability, not a
                  live choice — and the editor writes exactly one. */}
              <div className="be-list">
                {a.backends.length ? (
                  a.backends.map((b) => (
                    <BackendChip
                      key={b}
                      b={b}
                      {...(backendHealth?.[b] ? { health: backendHealth[b] } : {})}
                    />
                  ))
                ) : (
                  <span className="be-chip">
                    <span className="agent-glyph op">
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
              <div className="rt-val mono model-val">
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
            <div className="rt-val mem-row">
              <Icon name="memory" />
              <span>
                Re-anchors on <code className="mono">task.md</code>
              </span>
            </div>
          </div>
        </div>
        {/* F16: the actionable half of "not configured" — the registry's own
            sentence naming the specific misconfiguration, rather than leaving
            an admin to guess which of five env vars is missing. */}
        {backendMissing && (
          <div className="def-note">
            <Icon name="alert" />
            <span>
              <b>{backendLabel} has no usable credential on this instance</b> —
              a run assigned to this profile refuses before it starts.{" "}
              {runHealth?.detail ?? ""}
            </span>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <Icon name="activity" />
          <h2>Active deployments</h2>
          <span className="right sub fine">
            {countLabel(insts.length, "engagement")}
          </span>
        </div>
        {insts.length === 0 ? (
          <div className="empty sm">
            {backendMissing
              ? `Not currently engaged on any task. This profile is approved, but ${backendLabel} is not configured — assigning it would produce a refused run.`
              : "Not currently engaged on any task. This profile is approved and available for assignment."}
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
          <div className="empty sm">
            No agents are currently engaged.
          </div>
        )}
        {sorted.map((d) => {
          const isOp = d.engagement === "operator";
          // P13-UI-27 residual: an unresolved profileId used to be printed raw
          // ("dev-2f1c"), which reads like a name and hides the real fact — the
          // engagement outlived the profile (deleted, or deployed on another
          // project). Name the condition and keep the id in the tooltip, where
          // it is diagnostic rather than decorative.
          const resolved = isOp ? "Operator" : nameById?.[d.profileId];
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
                  <span
                    className="live-name"
                    {...(resolved
                      ? {}
                      : {
                          title: `No profile named ${d.profileId} is approved on this project — the engagement outlived its profile.`,
                        })}
                  >
                    {resolved ?? "profile no longer here"}
                  </span>
                  {!isOp && (
                    <span className="live-role-sub">
                      {profileRoleLabel(resolved ?? d.profileId, d.role, "specialist")}
                    </span>
                  )}
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
  | {
      ok: true;
      toast: string;
      profileId: string;
      /** A delivery-headline decision the save had to make (B-AG1). `withheld`
       *  = the profile was saved as asked and cannot deliver until the headline
       *  capability is granted — shown as its own failure-toned toast, because
       *  the green "updated" tick alone reads as "nothing to see here". */
      notice?: { kind: "repaired" | "withheld"; message: string };
    }
  | { ok: false; error: string };

export function AgentsPage({
  profiles,
  library,
  deployments,
  stages,
  workflow,
  projectSlug,
  projectName,
  myRole,
  resourceCatalog,
  backendAvailable,
  backendHealth,
}: {
  profiles: AgentProfileView[];
  /** Org templates not yet deployed here — the "Add from library" options. */
  library?: LibraryProfileView[];
  deployments: AgentDeploymentView[];
  stages: StageView[];
  /** R14-1: the board's workflow edges, so every stage claim on this page is
   *  resolved against THIS board the way the run guard resolves it. */
  workflow: WorkflowEdgeView[];
  projectSlug: string;
  projectName: string;
  myRole: string | null;
  /** Live store resources for the profile-editor picker (F6/item-2). */
  resourceCatalog?: readonly ResCatalogGroup[];
  /** Per-backend credential availability — the create/edit modal disables a
   *  backend that isn't configured so a profile can't be pinned to it (RU-2). */
  backendAvailable?: Record<"codex" | "claude", boolean>;
  /** F16: the SAME probe, with its reason — the roster says whether a profile
   *  could actually run, not only whether anything is running it. */
  backendHealth?: BackendHealthMap | undefined;
}) {
  const navigate = useNavigate();
  const push = useToast();
  const csrf = useCsrfToken();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<ProfileActionResult>();

  const canManage = roleCan(myRole as ProjectRole | null, "manage-agents");
  // P13-UI-58 residual: `?profile=`/`?tab=` were READ once at mount and never
  // written back, so the selection was unlinkable, un-bookmarkable and lost on
  // reload — and a pasted `?tab=live` did nothing at all. The URL is the state:
  // selection reads from it and every click replaces it (replace: true keeps
  // one history entry per visit, the same rule the topbar search follows).
  const sel = searchParams.get("profile") ?? "operator";
  const tab = searchParams.get("tab") === "live" ? "live" : "profiles";
  const setSel = (profileId: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("profile", profileId);
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };
  const setTab = (next: "profiles" | "live") => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "live") params.set("tab", "live");
        else params.delete("tab");
        return params;
      },
      { replace: true, preventScrollReset: true },
    );
  };
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
      if (d.notice) {
        push(d.notice.message, d.notice.kind === "withheld" ? "error" : "success");
      }
      setCreating(false);
      setLibraryOpen(false);
      setEditing(null);
      setFormError(null);
      if (d.profileId) setSel(d.profileId);
    } else if (creating || editing) {
      setFormError(d.error);
    } else {
      // P13-D-10: `push` defaults to the "success" kind, so this failure
      // rendered under a green tick.
      push(d.error, "error");
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
    // P13-UI-58 residual: the selection used to jump to the operator BEFORE the
    // delete round-tripped, so a refused delete (RBAC, or a profile engaged
    // elsewhere) left the user staring at a different profile with only a toast
    // to explain it. Move the selection when the server confirms — the handled
    // effect above re-selects on success, and a failure leaves you where you
    // were, next to the profile you tried to delete.
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
          {/* P13-UI-58 residual: the Profiles/Live seg conveyed its selection
              with the `on` class alone — the same gap Home's Grid/List seg and
              the resources Transport seg already closed. */}
          <div className="seg">
            <button
              type="button"
              className={tab === "profiles" ? "on" : ""}
              aria-pressed={tab === "profiles"}
              onClick={() => setTab("profiles")}
            >
              <Icon name="agents" />
              Profiles
            </button>
            <button
              type="button"
              className={tab === "live" ? "on" : ""}
              aria-pressed={tab === "live"}
              onClick={() => setTab("live")}
            >
              <Icon name="activity" />
              Live<span className="tally">· {deployments.length}</span>
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
                <span className="tally">· {libraryProfiles.length}</span>
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

      {/* UXA-15: Policy and project Settings both explain their read-only state
          to a role without the grant; Agents — where the New profile, Add from
          library, Edit and Delete affordances all simply vanish — said nothing,
          so a contributor saw a roster they could not touch and no reason why. */}
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            Read-only — deploying, editing or removing agent profiles needs the{" "}
            <strong>Manage agents</strong> grant (project admin or maintainer).
            The capability matrix below is readable by every member.
          </span>
        </div>
      )}
      <div className="ag-stats">
        <div className="ag-stat">
          <div className="n">{profiles.length}</div>
          <div className="l">profiles approved · incl. operator</div>
        </div>
        <div className="ag-stat">
          <div className="n">{operators}</div>
          {/* P13-UI-51: the number is operator ENGAGEMENTS, which is one per
              active task — but the label read as a task count, so a task whose
              operator had been released showed a smaller "active tasks" number
              than the board did. Say what is counted. */}
          <div className="l">tasks with a live operator</div>
        </div>
        <div className="ag-stat">
          <div className="n agent">
            {working}
          </div>
          <div className="l">specialists in a working state</div>
        </div>
        <div className="ag-stat">
          <div className="n human">
            {waiting}
          </div>
          {/* P14-WL-04: this counted agent ENGAGEMENTS parked on a human in
              THIS project, while the board counted tasks and Home counted the
              viewer's own decisions org-wide — three different questions with
              near-identical copy, side by side in one session. Each surface now
              names its own scope. */}
          <div className="l">agent threads waiting on a human · this project</div>
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
                {...(backendHealth ? { health: backendHealth } : {})}
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
                {...(backendHealth ? { health: backendHealth } : {})}
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
              workflow={workflow}
              {...(resourceCatalog ? { resourceCatalog } : {})}
              {...(backendHealth ? { backendHealth } : {})}
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
          stages={stages}
          workflow={workflow}
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
