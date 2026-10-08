import { useEffect, useMemo, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { capabilityById, isClaudeOnlyEnforcedLabel } from "~/shared/capabilities";
import {
  CODEX_REPO_WRITE_ADVISORY_NOTE,
  codexRepoWriteAdvisory,
} from "~/server/tasks/specialist-tool-policy";
import { resolveDeclaredStages } from "~/shared/workflow/stage-eligibility";
import { countLabel } from "~/shared/text/plural";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import {
  BOUNDARIES,
  TRANSITION_TO_DONE_CAPABILITY_ID,
  TRANSITION_TO_DONE_EXCEPTION,
} from "~/features/policy/policy-data";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { GlyphSwap } from "~/ui/copy-glyph";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon, type IconName, storeIcon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import {
  deploymentDot,
  deploymentStatusKind,
  describeDriftLists,
  profileRoleLabel,
  type AgentDeploymentView,
  type AgentProfileView,
  type LibraryProfileView,
  type TemplateDrift,
} from "./agent-types";
import {
  deployingProfileId,
  engagementTallies,
  primaryBackend,
  primaryBackendHealth,
  rosterOf,
  runningTaskCounts,
  viewerConnections,
} from "./agents-page-derive";
import { useProfileSelection } from "./agents-page-selection";
import {
  CAP_META,
  GOVERNED_CAP_LABELS,
  type ResCatalogGroup,
  type ResItemWarning,
} from "./capability-catalog";
import { CapabilityMatrixModal } from "./capability-matrix-modal";
import {
  CreateProfileModal,
  type ProfileFormPayload,
} from "./create-profile-modal";
import { effortLabel } from "./effort-label";

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
 *
 * Ruling 700(e) split the two large bodies along the task-page recipe:
 * ProfileDetail and AgentsPage keep their hooks and hand hook-free regions
 * (ProfileHero, CapabilityPolicyPanel, ContextRuntimePanel with its
 * RuntimeRow; AgentsHead, ProfilesTab) one slot of their markup each; what the
 * page reads off its props is in `agents-page-derive.ts`, and its URL-held
 * selection in `agents-page-selection.ts`.
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

/** OBS-4: the operator capability whose column placement needs the boundary
 *  qualifier below (the id is the persisted one; the LABEL comes from the
 *  catalog so this card can never print a stale name). */
const STAGE_TRANSITIONS_CAPABILITY_ID = "stage-transitions";

/** The Policy page's own name for a boundary that advances without a human —
 *  borrowed, never restated, so both surfaces call it the same thing. */
const AUTO_BOUNDARY_LABEL =
  BOUNDARIES.find((b) => b.id === "auto")?.label ?? "Auto-advance";

// ------------------------------------------------------------ small parts

/**
 * Ruling 127: who on this project can actually run this backend.
 *
 * There is no instance-level "the backend is configured" fact any more — a run
 * bills a PERSON, so the honest instance-level number is a count of the people
 * who connected it, and the honest per-viewer fact is whether THEY did. F16's
 * rule survives the change: absent ⇒ unknown here, and nothing is claimed
 * either way; the page never invents a second, quietly divergent check.
 */
export interface BackendConnectionSummary {
  backend: "codex" | "claude";
  /** The person looking at this page has connected this backend. */
  viewerConnected: boolean;
  /** Project members who have connected it, of how many members there are. */
  membersConnected: number;
  membersTotal: number;
}

export type BackendHealthMap = Partial<
  Record<"codex" | "claude", BackendConnectionSummary>
>;

function BackendChip({
  b,
  health,
  noted = false,
}: {
  b: "codex" | "claude";
  /** Undefined = not probed on this surface; nothing is claimed. */
  health?: BackendConnectionSummary | undefined;
  /** The panel's note under the row already says the viewer has not
   *  connected this backend, so the chip does not say it a second time. */
  noted?: boolean;
}) {
  // Mirrors the task-level Execution profile panel ("Codex — not
  // configured"), which was already telling this truth while this page said
  // "available" about the same profile.
  // Ruling 127: "not connected" is about the VIEWER's own account, not the
  // deployment's — the badge says what THEY have to do about it. Ruling 625:
  // one phrase and one hue for it on the page (the hero's and the roster's
  // rose pill), and only where nothing nearer says it already.
  const missing = health ? !health.viewerConnected && !noted : false;
  return (
    <span className="be-chip">
      <AgentGlyph backend={b} decorative />
      {BACKEND_LABEL[b]}
      {missing && (
        <span className="pill risk sm" title={notConnectedNote(b)}>
          not connected
        </span>
      )}
    </span>
  );
}

/** Ruling 127: what a person who has not connected a backend must do, in one
 *  sentence, addressed to them. */
function notConnectedNote(backend: "codex" | "claude"): string {
  return `You haven't connected ${BACKEND_LABEL[backend]}. Connect it on your Profile → Agent accounts to run this profile on your tasks.`;
}

/**
 * Ruling 127: the billing rule, plus the only instance-level number that
 * survives it.
 *
 * "Configured" was a property of the deployment; a run is a property of a
 * PERSON, and which person depends on the task, which this page does not have.
 * So the roster states the rule ("runs use the task owner's <Backend>
 * account") and counts the members of THIS project who could satisfy it. The
 * count is people, never a verdict: a project where one member has connected
 * Codex is a project where this profile runs on that person's tasks.
 */
function runsUseOwnerNote(health: BackendConnectionSummary): string {
  const label = BACKEND_LABEL[health.backend];
  return (
    `Runs use the task owner's ${label} account · ` +
    `${health.membersConnected} of ${health.membersTotal} members connected`
  );
}

function ProfileGlyph({ a, lg }: { a: AgentProfileView; lg?: boolean }) {
  return (
    <span
      className={
        "agent-glyph" + (lg ? " lg" : "") + (a.kind === "operator" ? " op" : "")
      }
      title={profileRoleLabel(a.name, a.role, a.kind) ?? undefined}
    >
      <Icon name={storeIcon(a.icon)} />
    </span>
  );
}

function ActiveBadge({
  count,
  unusable,
}: {
  count: number;
  /** F16: the viewer has not connected the profile's backend — every run it
   *  is given on their tasks refuses before it starts, so "idle" alone is a
   *  half-truth. The sentence its hover carries, naming the backend. */
  unusable?: string | undefined;
}) {
  // Ruling 455 names the count in words; ruling 459's violet working dot
  // leads them, as on every other agent-at-work surface.
  if (count > 0)
    return (
      <span className="ag-active">
        <span className="working" />
        {count} running
      </span>
    );
  // Ruling 625: the page's one phrase and hue for this fact ("no runtime" was
  // a second, vaguer claim, in amber beside the hero's rose pill). The words
  // the backend chips use: in a 312px roster card the backend's name wrapped
  // the role under the name, so it rides the hover sentence and the hero.
  if (unusable)
    return (
      <span className="pill risk sm" title={unusable}>
        not connected
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
    backendHealth && !backendHealth.viewerConnected
      ? notConnectedNote(backendHealth.backend)
      : undefined;
  const role = profileRoleLabel(a.name, a.role, a.kind);
  return (
    <button
      type="button"
      className={"ag-item" + (on ? " on" : "")}
      // Interface review 2026-09-24 (acce-9): the open profile's state, not
      // just its ring.
      aria-current={on ? "true" : undefined}
      onClick={onClick}
    >
      <ProfileGlyph a={a} />
      <span className="ag-item-main">
        <span className="nm">{a.name}</span>
        {role && <span className="sub">{role}</span>}
      </span>
      <ActiveBadge count={count} unusable={unusable} />
    </button>
  );
}

/**
 * C10 — the ONE deployment-status pill for this page.
 *
 * The status strings are a server contract (`agent-types.DeploymentStatus`), but
 * the roster rendered them as the raw `d.status` text inside a bare `<Pill>` at
 * two call sites, so a future rename of the vocabulary would have to be chased
 * across the page. Routing both sites through this component keeps the kind AND
 * the label in one place (ruling 14's single implementations). It also restores
 * the article the board carries — the raw status "waiting on human" reads
 * "waiting on a human" here, matching every other surface (C4) — while the
 * underlying status VALUE the loader derives is untouched.
 */
function deploymentStatusLabel(status: string): string {
  return status === "waiting on human" ? "waiting on a human" : status;
}

/** F10-20 finished: ONE human-facing vocabulary for the engagement fact — the
 *  internal "primary"/"reviewer" literals never render (the Live roster
 *  translated them while the Active-deployments panel leaked them raw). */
function engagementLabel(e: "operator" | "primary" | "reviewer"): string {
  return e === "operator" ? "operator" : e === "primary" ? "delivering" : "supporting";
}

function DeploymentStatusPill({
  d,
}: {
  d: Pick<AgentDeploymentView, "status" | "running">;
}) {
  return (
    <Pill kind={deploymentStatusKind(d.status)} sm dot={deploymentDot(d)}>
      {deploymentStatusLabel(d.status)}
    </Pill>
  );
}

function CapColumn({
  group,
  items,
  codexPrimary,
  codexCarveOut,
}: {
  group: keyof typeof CAP_META;
  items: string[];
  /** F-P1 (pass 25): the profile's first (run) backend is Codex, so any
   *  claude-only-enforced grant listed here binds only advisorily — the same
   *  caveat the capability matrix and editor already show per row. */
  codexPrimary?: boolean;
  /** Pass 32 (E32-3 fallback): this Codex-first profile withholds repo-write
   *  while granting evidence — the one shape the Codex sandbox cannot bind —
   *  so the repo-write row in the withheld bucket gets the same caveat. */
  codexCarveOut?: boolean;
}) {
  const m = CAP_META[group];
  const repoWriteLabel = capabilityById("execute-code-or-write-repo")?.label;
  return (
    <div className={"cap-col " + group}>
      <div className="cap-col-head">
        <Icon name={m.icon} />
        {m.label}
      </div>
      <div className="cap-list">
        {/* D32-8 (pass 32): an empty bucket kept its header over nothing, so
            "RECOMMENDS ONLY" with no rows read as a rendering gap rather than
            as a fact. Say it, the way ResGroup below says "None". */}
        {items.length === 0 && <span className="sub fine md dim">None</span>}
        {items.map((x) => {
          const claudeOnly = codexPrimary && isClaudeOnlyEnforcedLabel(x);
          const carveOut = codexCarveOut && x === repoWriteLabel;
          return (
            <div className="cap-item" key={x}>
              <Icon name={m.icon} />
              <span>{x}</span>
              {/* Both conditions hold at once on the repo-write row, and each
                  used to render its own span — so the row read "Execute code or
                  write to the repo · advisory on Codex · advisory on Codex",
                  the same four words twice, with the only difference buried in
                  a tooltip. The card makes each claim ONCE (F15-09), and the
                  carve-out's note is the specific one: it names WHY the
                  withholding is advisory on this runtime, where the Claude-only
                  note only says that it is. */}
              {(claudeOnly || carveOut) && (
                <span
                  className="fhint"
                  title={
                    carveOut
                      ? `On this profile's Codex runtime ${CODEX_REPO_WRITE_ADVISORY_NOTE}.`
                      : "Claude-enforced. On this profile's Codex runtime the tool layer does not bind it; the server-owned delivery gate is the real boundary."
                  }
                >
                  {" "}
                  · advisory on Codex
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Ruling 156: the sentence under a grant list whose copy differs from the
 * template's. "there" is the template, "here" is this project's copy.
 */
function driftSentence(drift: { missing: string[]; extra: string[] }): string {
  const parts: string[] = [];
  if (drift.missing.length) {
    parts.push(
      `${drift.missing.join(", ")} ${drift.missing.length === 1 ? "is" : "are"} granted there, not here`,
    );
  }
  if (drift.extra.length) {
    parts.push(
      `${drift.extra.join(", ")} ${drift.extra.length === 1 ? "is" : "are"} granted here, not on the template`,
    );
  }
  return `Differs from the template: ${parts.join("; ")}.`;
}

function ResGroup({
  label,
  icon,
  items,
  known,
  warnings,
  drift,
}: {
  label: string;
  icon: IconName;
  items: string[];
  /** P14-KM-11: the ids the store actually holds. `undefined` = unknown here, so
   *  nothing is marked (never invent a "missing" state from missing data). */
  known?: ReadonlySet<string>;
  /** Ruling 479(b): what the registry knows against a resource the store does
   *  hold (an MCP server that needs a sign-in, say), keyed by id. */
  warnings?: ReadonlyMap<string, ResItemWarning>;
  /** Ruling 156: how this list differs from the template's, when it does. */
  drift?: { missing: string[]; extra: string[] };
}) {
  const differs = drift && (drift.missing.length > 0 || drift.extra.length > 0);
  return (
    <div className="res-group">
      <div className="lbl">{label}</div>
      {differs && <span className="sub fine">{driftSentence(drift)}</span>}
      <div className="res-chips">
        {items.length ? (
          items.map((x) => {
            // A grant naming a resource the store no longer has reaches the run
            // as nothing at all — live, a renamed MCP left this panel painting a
            // healthy chip while the agent found zero tools under that name.
            const missing = known ? !known.has(x) : false;
            // Ruling 479(b): a server the store holds can still reach no run
            // (live: `cloudflare-api` needed a sign-in and every run dropped
            // it). Marked the way a missing one is, with the remedy.
            const flag: ResItemWarning | undefined = missing
              ? {
                  note: "missing",
                  title: `${x} is no longer in the store, so this grant reaches no run`,
                }
              : warnings?.get(x);
            return (
            <span
              className={flag ? "res-chip missing" : "res-chip"}
              key={x}
              {...(flag ? { title: flag.title } : {})}
            >
              <Icon name={flag ? "alert" : icon} />
              {x}
              {flag && <span className="res-chip-note">{flag.note}</span>}
              {/* The title is a description no screen reader is bound to
                  read; the remedy is part of the chip's text. */}
              {flag && <span className="vh">. {flag.title}</span>}
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
 *    (both applied in `dispatchAgentRun`, specialist-run.server.ts), i.e. no
 *    delivery, no comments, no ask-human, no evidence. The thread runs and
 *    produces nothing anyone can act on, which is the opposite of the
 *    continuity the copy promised.
 *  - "until the operator reassigns them" describes an automatic recovery that
 *    nothing initiates. `deleteAgentProfile` (agent-profile-actions.server.ts)
 *    edits `project.md`, reprojects and audits — it queues no operator run,
 *    writes no task timeline event and sends no notification. Reassignment is
 *    real (`assignSpecialist`), but only if a human goes and does it, so the
 *    dialog names it as their next step.
 */
function DeleteConfirm({
  a: current,
  projectName,
  activeCount: currentCount,
  onCancel,
  onConfirm,
}: {
  a: AgentProfileView;
  projectName: string;
  activeCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Ruling 459: the confirm plays its exit after the delete lands, and the
  // page then selects another profile, so the words are the ones it opened
  // with; the exit never names the next profile.
  const [{ a, activeCount }] = useState(() => ({ a: current, activeCount: currentCount }));
  // The shared `ConfirmDialog` (ruling 458(f)): a native <dialog> whose
  // backdrop click and Escape dismiss come from useDialog.
  return (
    <ConfirmDialog
      screenLabel="Profile deletion dialog"
      title={`Delete the ${a.name} profile?`}
      body={
        <>
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
              for you. Until someone assigns a replacement from each task's
              Execution profile, runs there can't deliver, comment, ask a question
              or attach evidence.
            </>
          ) : (
            <> The global base definition is unaffected.</>
          )}
        </>
      }
      confirmLabel="Delete profile"
      confirmIcon="x"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/**
 * Ruling 479(d): "Use the template's grants" REPLACES this project's copy of
 * the three grant lists (ruling 156, owner Q35-7), so a grant the project
 * added on its own is dropped. The label reads as "add what the template
 * has", and the press went straight to the server: live, one click would have
 * taken `cloudflare-api` off the agent that owns the open Cloudflare task, and
 * the toast never said a grant was lost. The confirm names both halves from
 * the drift the card already renders, in the propagation's own words.
 */
function SyncGrantsConfirm({
  a: current,
  drift: currentDrift,
  projectName,
  onCancel,
  onConfirm,
}: {
  a: AgentProfileView;
  drift: TemplateDrift;
  projectName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Ruling 459: the words stay the ones it opened with while the exit plays,
  // after the write has already cleared the drift.
  const [{ name, removed, added }] = useState(() => ({
    name: current.name,
    removed: describeDriftLists(currentDrift.extra),
    added: describeDriftLists(currentDrift.missing),
  }));
  return (
    <ConfirmDialog
      screenLabel="Template grants dialog"
      title={`Replace ${name}'s grants with the template's?`}
      tone={removed.length > 0 ? "danger" : "primary"}
      body={
        <>
          {projectName}&apos;s copy of <strong>{name}</strong> takes the
          template&apos;s skills, MCP servers and knowledge bases, and loses any
          it granted on its own. <strong>Removes</strong>{" "}
          {removed.length ? removed.join(", ") : "nothing"} ·{" "}
          <strong>adds</strong> {added.length ? added.join(", ") : "nothing"}.
          Changes apply from the next run.
        </>
      }
      confirmLabel="Replace grants"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
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
 *
 * Ruling 133 (F34-16): the chips and the count said WHERE without saying what
 * the where gates. Eligibility decides where a profile may be NEWLY engaged;
 * the task's delivering engagement, once made, may be prompted or resumed on
 * that task at every stage (rework, conflict resolution, follow-ups), while a
 * supporting engagement stays stage-scoped. The panel states the first half
 * always and the scoping half only for a profile that is actually scoped here
 * — for `spanAll`, an empty list, or a list that resolves to nothing on this
 * board, "the stages above" would name a scope that does not exist and
 * contradict the R14-1 note two lines below.
 */
function StageEligibility({
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
      ? "no stage restriction · eligible everywhere"
      : resolved.length === 0
        ? "declared stages don't exist here · eligible everywhere"
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
                data-stage-color={elig ? s.color : undefined}
              />
              {s.name}
              {/* Ruling 479(f): the difference was ink and a strike-through
                  alone, so assistive technology read all five stage names
                  the same way (WCAG 1.3.1). The state is in the text now. */}
              <span className="vh">{elig ? ", eligible" : ", not eligible"}</span>
            </span>
          );
        })}
        {stale.map((id) => (
          <span
            key={id}
            className="stage-chip off"
            title={`This profile grants the stage “${id}”, which is neither a stage on this board nor a role any stage here fills, so the grant does nothing.`}
          >
            <span className="sdot" />
            {id} · not on this board
          </span>
        ))}
      </div>
      <p className="fine sm">
        Eligibility decides where this profile may be newly engaged. Once it
        delivers a task it may be prompted on that task at any stage.
        {!unrestricted &&
          " A supporting or reviewing engagement runs only at the stages above."}
      </p>
      {/* R14-1: a declaration that resolves to nothing here no longer disables
          the profile — silently disabling every agent on a re-templated board is
          the failure we actually observed (Lightweight Lab, ids todo/doing/done).
          It DOES mean the declaration is dead weight, so say so. */}
      {!a.spanAll && a.stages.length > 0 && resolved.length === 0 && (
        <div className="empty xs">
          None of this profile's declared stages ({a.stages.join(", ")}) exist on
          this board, by id or by role. The declaration says nothing here, so
          the profile is eligible everywhere. Edit it to restrict the profile to
          this board's stages.
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ library picker

/** A no-break space before the dot keeps it on the line it closes. */
const META_DOT = "\u00a0· ";

/**
 * "Add from library" — deploy an org-level template into this project
 * (owner ruling 1 / P13-AP-05). Until this existed, a profile created in
 * Settings → Global agent profiles could never be deployed, run or selected:
 * no code path copied a template into a project's roster, so the org editor
 * offered a lifecycle it could not finish.
 *
 * Ruling 638: a row is the profile as Settings → Global agent profiles shows
 * it, with its add on the right. It borrowed the deployments row instead, whose
 * 84px label column holds "delivering" and not a role: "IMPLEMENTATION" ran on
 * under the description, the name sat in the faint key voice beside a bold
 * paragraph, and the stage pill wrapped under one row and sat beside the next.
 */
function LibraryPicker({
  library,
  stages,
  workflow,
  projectName,
  busy,
  adding = null,
  done = false,
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
  /** The profile whose deploy is in flight: its row names the work while the
   *  others wait at the busy step (ruling 368). */
  adding?: string | null;
  /** The deploy landed: the picker plays its exit, then onClose unmounts it
   *  (ruling 459). */
  done?: boolean;
  onClose: () => void;
  onAdd: (profileId: string) => void;
}) {
  const { ref: dialogRef, close } = useDialog(onClose);
  useEffect(() => {
    if (done) close();
  }, [done, close]);
  return (
    <dialog className="modal-card" aria-label="Add from library" ref={dialogRef}>
      <div className="modal-head">
        <span className="agent-glyph lg">
          <Icon name="agents" />
        </span>
        <div className="mh-main">
          <h2>Add from library</h2>
          {/* Ruling 638: one sentence. The footer said the copy part again
              ("the global profile stays the source"), beside a Close the
              head's ✕ already is, so the footer went. */}
          <div className="mh-sub">
            Adding a global profile gives {projectName} its own editable copy,
            capability grants included.
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
          <div className="lib-list">
            {library.map((t) => {
              const here = resolveDeclaredStages(t.stages, stages, workflow);
              // Mirrors the roster's own reading of the same declaration: no
              // restriction (or one that means nothing here) = every stage.
              const everywhere =
                t.spanAll || t.stages.length === 0 || here.length === 0;
              const inFlight = adding === t.id;
              // A run uses the first backend (P13-UI-52), so the tile is that
              // one's, as on the template's own row in Settings.
              const primary = t.backends[0];
              return (
                <button
                  type="button"
                  className="lib-row"
                  key={t.id}
                  disabled={busy || done}
                  aria-busy={inFlight || undefined}
                  onClick={() => onAdd(t.id)}
                >
                  {primary && <AgentGlyph backend={primary} decorative />}
                  <span className="lib-main">
                    <span className="nm">{t.name}</span>
                    {t.desc && (
                      <span className="lib-desc clamp" title={t.desc}>
                        {t.desc}
                      </span>
                    )}
                    {/* One line of text that wraps as one: each dot holds to
                        the fact before it, so a phone's wrapped line never
                        opens on a separator. */}
                    <span className="lib-meta">
                      <span>{profileRoleLabel(t.name, t.role, "specialist")}</span>
                      {t.backends.length > 0 && (
                        <>
                          {META_DOT}
                          <span>{t.backends.map((b) => BACKEND_LABEL[b]).join(", ")}</span>
                        </>
                      )}
                      {META_DOT}
                      <span>
                        {everywhere
                          ? "every stage here"
                          : `${countLabel(here.length, "stage")} here`}
                      </span>
                    </span>
                  </span>
                  <span className="lib-add">
                    <GlyphSwap rest="plus" alt="loader" on={inFlight} spinAlt />
                    {inFlight ? "Adding…" : "Add"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </dialog>
  );
}

// ------------------------------------------------------------------ detail

/**
 * The open profile's hero (ruling 700(e), the split of `ProfileDetail` along
 * the task-page recipe): its glyph, name and role, whether it is running,
 * engaged or idle, where its copy came from, and its Delete and Edit buttons.
 * Hook-free: the detail owns the delete confirm and hands in its setter.
 */
function ProfileHero({
  a,
  insts,
  activeKeys,
  backendMissing,
  backendLabel,
  projectName,
  canDelete,
  canManage,
  setConfirm,
  onEdit,
}: {
  a: AgentProfileView;
  insts: AgentDeploymentView[];
  /** The tasks it is engaged on, the count the delete confirm names too. */
  activeKeys: string[];
  backendMissing: boolean;
  backendLabel: string;
  projectName: string;
  canDelete: boolean;
  canManage: boolean;
  setConfirm: (open: boolean) => void;
  onEdit: (a: AgentProfileView) => void;
}) {
  const heroRole = profileRoleLabel(a.name, a.role, a.kind);
  // "running on N" is a claim about LIVE runs, not engagements: an assigned
  // profile sits idle on most of its tasks (the F16 note below). Count only the
  // tasks with an agent_runs row actually state='running' (`d.running`), or the
  // hero read "running on 3 tasks" for a profile executing nothing.
  const runningKeys = [
    ...new Set(insts.filter((d) => d.running).map((d) => d.taskKey)),
  ];
  return (
    <div className="ag-hero">
      <ProfileGlyph a={a} lg />
      <div className="ag-hero-main">
        <div className="ag-hero-top">
          {/* The page's ONE h1 is "Agents" (this is a master-detail layout, and
              every other surface in the app has exactly one). The selected
              profile is a section within it. */}
          <h2 className="ag-hero-name">{a.name}</h2>
          {/* Quiet: the role describes. The "not connected" pill beside it is
              the one thing on this line that wants a person. The operator
              has no role (ruling 518), so its name stands alone. */}
          {heroRole && (
            <Pill kind="neutral" sm quiet>
              {heroRole}
            </Pill>
          )}
          {runningKeys.length > 0 ? (
            <span className="ag-running">
              <span className="working" />
              running on {countLabel(runningKeys.length, "task")}
            </span>
          ) : backendMissing ? (
            <Pill kind="risk" sm>
              idle · {backendLabel} not connected
            </Pill>
          ) : activeKeys.length > 0 ? (
            // Engaged (assigned) but not executing a run right now — say so
            // rather than the false "running on N" or the bare "available".
            <span className="ag-idle">
              idle · engaged on {countLabel(activeKeys.length, "task")}
            </span>
          ) : (
            <span className="ag-idle">idle · available</span>
          )}
        </div>
        {/* OBS-7: a fork keeps its own copy and stops tracking the global
            (the edit modal's own warning says so), but the scope line still
            read "Global base" — the one sentence a reader uses to decide
            whether editing the org profile would reach this project. Name
            both facts: where it came from, and that this project's copy has
            since diverged. */}
        <div className="ag-scope">
          {a.scope}
          {a.customized && (
            <> · customized for {projectName}</>
          )}
          {/* Ruling 156: the grants signal beside the identity one, with the
              exact difference under each list in the resources panel. */}
          {a.templateDrift && <> · grants differ from the template</>}
        </div>
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
  );
}

/**
 * "Capability policy" (ruling 700(e), the split of `ProfileDetail`): the three
 * governed columns, the operator's two qualifying notes, and the advisory
 * lines collapsed under them. Hook-free; all of it is read off the profile.
 */
function CapabilityPolicyPanel({ a }: { a: AgentProfileView }) {
  // F15-05/F15-06: the capability columns show GOVERNED policy only — the same
  // partition the matrix draws between its curated groups and "Other actions".
  // A grant with no runtime consumer (advisory catalog id, bespoke extra) is
  // guidance and says so; it never renders as "Acts directly" beside the
  // capabilities that actually bind. The buckets themselves already come from
  // the one server-side interpretation of the stored grants
  // (`capabilitiesToActionLabels`), verdict outcomes gated included.
  const isGoverned = (label: string) => GOVERNED_CAP_LABELS.has(label);
  // F-P1 (pass 25): when a run would resolve to Codex, the claude-only-enforced
  // grants in these columns bind only advisorily — CapColumn shows the caveat.
  // Ruling 185 adds the write family to that set on Codex.
  const codexPrimary = primaryBackend(a) === "codex";
  const codexCarveOut = codexPrimary && codexRepoWriteAdvisory(a.capabilities);
  const governed = {
    direct: a.actions.direct.filter(isGoverned),
    recommend: a.actions.recommend.filter(isGoverned),
    forbidden: a.actions.forbidden.filter(isGoverned),
  };
  // F20-9 / D1 second half: on the OPERATOR card, "Accept completion into Done"
  // (direct/recommend) sits above "Transition a task to Done" (Reserved for
  // humans) with no reconciliation — the exact contradiction the Policy page
  // resolves with ONE exception note. Borrow that canonical copy (never restate
  // it) so the two surfaces cannot drift. The exception is operator-only, so a
  // specialist's always-human Transition-to-Done row carries no such note.
  const transitionToDoneLabel = capabilityById(
    TRANSITION_TO_DONE_CAPABILITY_ID,
  )?.label;
  const showDoneException =
    a.kind === "operator" &&
    transitionToDoneLabel !== undefined &&
    governed.forbidden.includes(transitionToDoneLabel);
  // OBS-4: "Stage transitions" under RECOMMENDS ONLY is a simplification the
  // live session caught contradicting the runtime — a supervised operator moved
  // Triage→Ready and Ready→In Progress DIRECTLY, because the capability mode
  // decides what happens at a boundary the WORKFLOW gates, and an auto-advance
  // boundary has no gate to recommend into. The column is right about the gated
  // boundaries and silent about the rest, so the card says which is which
  // instead of reading as a flat "it never moves a task itself".
  const stageTransitionsLabel = capabilityById(STAGE_TRANSITIONS_CAPABILITY_ID)
    ?.label;
  const showBoundaryNuance =
    a.kind === "operator" &&
    stageTransitionsLabel !== undefined &&
    governed.recommend.includes(stageTransitionsLabel);
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
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="shield" />
        <h2>Capability policy</h2>
      </div>
      {showDoneException && (
        <p className="cap-exception">
          <Icon name="lock" />
          <span>
            <strong>{transitionToDoneLabel}</strong> stays reserved for humans{" "}
            {TRANSITION_TO_DONE_EXCEPTION}.
          </span>
        </p>
      )}
      {showBoundaryNuance && (
        /* OBS-4: the boundary the workflow marks "{AUTO_BOUNDARY_LABEL}" has
           no approval to recommend into, so this operator moves it itself —
           the label is borrowed from the Policy page's boundary list rather
           than restated, so the two surfaces name the same thing. */
        <p className="cap-exception">
          <Icon name="arrow" />
          <span>
            <strong>{stageTransitionsLabel}</strong> is a recommendation at the
            boundaries this project gates. A boundary set to{" "}
            <strong>{AUTO_BOUNDARY_LABEL}</strong> is moved directly. The
            Policy page lists which boundary is which.
          </span>
        </p>
      )}
      <div className="cap-cols">
        <CapColumn group="direct" items={governed.direct} codexPrimary={codexPrimary} />
        <CapColumn group="recommend" items={governed.recommend} codexPrimary={codexPrimary} />
        <CapColumn
          group="forbidden"
          items={governed.forbidden}
          codexPrimary={codexPrimary}
          codexCarveOut={codexCarveOut}
        />
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
            <Icon name="chevron" className="disc-chev" />
          </summary>
          <div className="cap-advisory-body">
            <p>
              These describe how the profile is meant to work. Nothing in the
              runtime enforces them, so they never grant or refuse anything.
              The binding policy is the three columns above.
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
  );
}

/**
 * "Context resources & runtime" (ruling 700(e), the split of
 * `ProfileDetail`): the template-grants button, the granted resources, what a
 * run starts on, and the viewer's connection note. Hook-free: the detail owns
 * the grants confirm and hands in its setter.
 */
function ContextRuntimePanel({
  a,
  resourceCatalog,
  rulingsKb,
  backendHealth,
  runHealth,
  backendMissing,
  backendLabel,
  canSyncTemplate,
  setSyncDrift,
}: {
  a: AgentProfileView;
  resourceCatalog: readonly ResCatalogGroup[] | undefined;
  rulingsKb: string | null;
  backendHealth: BackendHealthMap | undefined;
  runHealth: BackendConnectionSummary | null;
  backendMissing: boolean;
  backendLabel: string;
  canSyncTemplate: boolean;
  setSyncDrift: (drift: TemplateDrift | null) => void;
}) {
  // P14-KM-11: what the store actually holds, per resource kind. Absent catalog
  // ⇒ undefined ⇒ nothing is marked missing (see ResGroup).
  const known = (key: string): ReadonlySet<string> | undefined => {
    const group = resourceCatalog?.find((g) => g.key === key);
    return group ? new Set(group.items.map((i) => i.id)) : undefined;
  };
  // Ruling 479(b): the registry's word against a resource it does hold.
  const warningsOf = (key: string): ReadonlyMap<string, ResItemWarning> => {
    const out = new Map<string, ResItemWarning>();
    for (const item of resourceCatalog?.find((g) => g.key === key)?.items ?? []) {
      if (item.warning) out.set(item.id, item.warning);
    }
    return out;
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="cpu" />
        <h2>Context resources &amp; runtime</h2>
        {/* Ruling 156 (owner, Q35-8): only an org admin copies the template's
            grants onto this project; a project admin sees the difference and
            asks. The button carries the record the page rendered (B5), so a
            save landing in between is refused, never reverted. Ruling
            479(d): it opens a confirm naming what the press removes and
            adds; the submit is the confirm's. */}
        {canSyncTemplate && a.templateDrift && (
          <button
            type="button"
            className="btn ghost sm right"
            aria-haspopup="dialog"
            onClick={() => setSyncDrift(a.templateDrift)}
          >
            <Icon name="cpu" />
            Use the template&apos;s grants
          </button>
        )}
      </div>
      <div className="res-groups">
        <ResGroup
          label="Skills"
          icon="bolt"
          items={a.resources.skills}
          known={known("skills")}
          {...(a.templateDrift
            ? { drift: { missing: a.templateDrift.missing.skills, extra: a.templateDrift.extra.skills } }
            : {})}
        />
        <ResGroup
          label="MCP servers"
          icon="cpu"
          items={a.resources.mcps}
          known={known("mcps")}
          warnings={warningsOf("mcps")}
          {...(a.templateDrift
            ? { drift: { missing: a.templateDrift.missing.mcps, extra: a.templateDrift.extra.mcps } }
            : {})}
        />
        <ResGroup
          label="Knowledge bases"
          icon="file"
          items={a.resources.kb}
          known={known("kb")}
          {...(a.templateDrift
            ? { drift: { missing: a.templateDrift.missing.kb, extra: a.templateDrift.extra.kb } }
            : {})}
        />
        {rulingsKb && (
          <p className="muted">
            Every run on this project reads <code className="mono">{rulingsKb}</code>, the
            project's rulings, whether or not it is granted above (ruling 239). Removing the
            grant here would not stop this profile reading it.
          </p>
        )}
      </div>
      <RuntimeRow
        a={a}
        backendHealth={backendHealth}
        runHealth={runHealth}
        backendMissing={backendMissing}
      />
      {/* Ruling 127: the actionable half, addressed to the person reading
          it. There is no instance credential to name any more — a run bills
          the task owner, and this viewer's own account is what decides
          whether the profile runs on the tasks THEY own. Ruling 625: the
          members' count is the runtime line's, just above; it is not said
          twice. */}
      {backendMissing && (
        <div className="def-note">
          <Icon name="alert" />
          <span>
            <b>You haven't connected {backendLabel}</b>. Runs use the task
            owner's account, so a run this profile is given on a task you own
            refuses before it starts. Connect {backendLabel} on your Profile →
            Agent accounts.
          </span>
        </div>
      )}
    </div>
  );
}

/** What a run on this profile starts on: its backend, model and effort, the
 *  operator's autonomy, and its continuity (ruling 700(e), the split of
 *  `ProfileDetail`; hook-free). */
function RuntimeRow({
  a,
  backendHealth,
  runHealth,
  backendMissing,
}: {
  a: AgentProfileView;
  backendHealth: BackendHealthMap | undefined;
  runHealth: BackendConnectionSummary | null;
  backendMissing: boolean;
}) {
  return (
    <div className="runtime-row">
      <div className="rt-cell">
        <div className="lbl">
          Execution backend
          {a.backends.length > 1 && (
            <span className="fhint">a run uses the first</span>
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
                  noted={backendMissing && b === runHealth?.backend}
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
          {/* Ruling 127: WHOSE account a run on this profile spends. The
              page cannot answer "is this backend configured" any more (a
              run bills the task owner, and this page is not on a task), so
              it states the rule and the one honest instance-level number:
              how many of this project's members have connected it. */}
          {runHealth && (
            <div className="sub fine md dim">
              {runsUseOwnerNote(runHealth)}
            </div>
          )}
        </div>
      </div>
      {/* Ruling 479(e): every kind shows what a run starts on, model AND
          effort. The operator used to get Autonomy in this cell and no
          model at all, and no profile showed its effort, so whether an
          agent ran at Maximum or High was readable only inside the
          editor. The operator runs on the same two values
          (`resolveOperatorAuthority`); an empty effort is the backend's
          own default. */}
      <div className="rt-cell">
        <div className="lbl">Model · effort</div>
        <div className="rt-val model-val">
          <span>
            {a.modelLabel} ·{" "}
            {a.effort ? effortLabel(a.effort) : "default effort"}
          </span>
          {!a.modelKnown && (
            <span
              className="model-sub"
              title={`The saved model “${a.model}” isn't a recognized model id, so runs use the default (${a.modelLabel}). Open Edit profile to pick a model.`}
            >
              <Icon name="alert" />
              default
            </span>
          )}
          {/* R20-3/F20-4: a real run proved the provider refuses this model
              for this account. The badge names the provider's own redacted
              sentence; a run on it would be refused before it starts. */}
          {a.modelUnavailable && (
            <span
              className="model-sub"
              title={`${a.modelUnavailable.reason} A run on this model would be refused. Open Edit profile to pick another.`}
            >
              <Icon name="alert" />
              unavailable
            </span>
          )}
        </div>
      </div>
      {a.kind === "operator" && (
        <div className="rt-cell">
          <div className="lbl">Autonomy</div>
          <div className="rt-val">
            <Pill kind={a.autonomy === "full" ? "agent" : "neutral"} sm dot>
              {a.autonomy === "full" ? "Full autonomy" : "Supervised"}
            </Pill>
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
  );
}

export function ProfileDetail({
  a,
  stages,
  workflow,
  resourceCatalog,
  rulingsKb = null,
  backendHealth,
  insts,
  projectName,
  canManage,
  canSyncTemplate = false,
  onOpen,
  onDelete,
  onEdit,
  onSyncResources = () => {},
}: {
  a: AgentProfileView;
  stages: StageView[];
  /** R14-1: the board's edges — eligibility resolves by structural role too. */
  workflow: WorkflowEdgeView[];
  /** F16 + ruling 127: who can run each backend, from the one credential store
   *  (`connectedUserIds` / `isBackendAvailableFor`). */
  backendHealth?: BackendHealthMap | undefined;
  /** P14-KM-11: the live store catalog, so a grant naming a resource the store
   *  no longer holds renders as missing rather than healthy. */
  resourceCatalog?: readonly ResCatalogGroup[];
  /** Ruling 239: the project's rulings knowledge base, which every profile
   *  reads whether or not it grants one. Without saying so here, this card's
   *  own `kb` list is WRONG about what the profile actually gets. */
  rulingsKb?: string | null;
  insts: AgentDeploymentView[];
  projectName: string;
  canManage: boolean;
  /** Ruling 156 (owner, Q35-8): org admins only may take the template's
   *  grants onto this project's copy. */
  canSyncTemplate?: boolean;
  onOpen: (taskKey: string) => void;
  onDelete: (id: string) => void;
  onEdit: (a: AgentProfileView) => void;
  onSyncResources?: (a: AgentProfileView) => void;
}) {
  const activeKeys = [...new Set(insts.map((d) => d.taskKey))];
  const [confirm, setConfirm] = useState(false);
  // Ruling 479(d): "Use the template's grants" asks first, naming what goes.
  // The drift is held from the press, so the confirm outlives the write that
  // clears it on the card (its exit plays, ruling 459).
  const [syncDrift, setSyncDrift] = useState<TemplateDrift | null>(null);
  // F16: "idle · available" was the page's answer no matter what — live, a
  // Codex profile whose backend nobody could run read "idle · available" here
  // while the task-level Execution panel, one click away, disagreed.
  // Availability is two claims, and only one of them is about engagements:
  // nothing is running it, AND a run could start. Ruling 127 makes the second
  // claim person-shaped — a run bills the task owner, and the person reading
  // this page is who would start one on the tasks they own.
  const runHealth = primaryBackendHealth(a, backendHealth);
  // Ruling 127: the second claim is now about the VIEWER's own account — they
  // are the person who would press Run.
  const backendMissing = runHealth !== null && !runHealth.viewerConnected;
  const backendLabel = runHealth ? BACKEND_LABEL[runHealth.backend] : "Codex";
  const canDelete = a.kind !== "operator" && canManage;

  return (
    <div className="ag-detail">
      {confirm && (
        <DeleteConfirm
          a={a}
          projectName={projectName}
          activeCount={activeKeys.length}
          onCancel={() => setConfirm(false)}
          onConfirm={() => onDelete(a.id)}
        />
      )}
      {syncDrift && (
        <SyncGrantsConfirm
          a={a}
          drift={syncDrift}
          projectName={projectName}
          onCancel={() => setSyncDrift(null)}
          onConfirm={() => onSyncResources(a)}
        />
      )}
      <ProfileHero
        a={a}
        insts={insts}
        activeKeys={activeKeys}
        backendMissing={backendMissing}
        backendLabel={backendLabel}
        projectName={projectName}
        canDelete={canDelete}
        canManage={canManage}
        setConfirm={setConfirm}
        onEdit={onEdit}
      />

      <p className="ag-desc">{a.desc}</p>

      <StageEligibility a={a} stages={stages} workflow={workflow} />

      <CapabilityPolicyPanel a={a} />

      <ContextRuntimePanel
        a={a}
        resourceCatalog={resourceCatalog}
        rulingsKb={rulingsKb}
        backendHealth={backendHealth}
        runHealth={runHealth}
        backendMissing={backendMissing}
        backendLabel={backendLabel}
        canSyncTemplate={canSyncTemplate}
        setSyncDrift={setSyncDrift}
      />

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
            {/* Ruling 625: with the backend not connected, the note above
                already says why a run would be refused; this stops at the
                fact, and no longer calls the profile available. */}
            {backendMissing
              ? "Not currently engaged on any task."
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
                {/* Ruling 625: on the operator's own page every row is an
                    operator engagement, so the label went on all of them. */}
                {(a.kind !== "operator" || d.engagement !== "operator") && (
                  <span className="deploy-eng">{engagementLabel(d.engagement)}</span>
                )}
                <span className="deploy-task">
                  <span className="key">{d.taskKey}</span> {d.taskTitle}
                </span>
                {d.backend && a.kind !== "operator" && (
                  <BackendChip b={d.backend} />
                )}
                <DeploymentStatusPill d={d} />
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

/**
 * The four counters above the roster.
 *
 * Extracted from `AgentsPage` (U12) so the retired-vocabulary gate can render
 * the labels without a router: the "specialist" noun survived here for two
 * passes precisely because nothing could read this copy in isolation, and a
 * gate that cannot render a string cannot defend it.
 */
export function AgentStats({
  profiles,
  operators,
  running,
  waiting,
}: {
  /** Approved profiles on this project, operator included. */
  profiles: number;
  /** Operator ENGAGEMENTS — one per active task. */
  operators: number;
  /** Engagements with a run in flight (`d.running`, F34-5). */
  running: number;
  /** Engagements on a task whose `waiting` is `human` (`d.taskWaiting`). */
  waiting: number;
}) {
  return (
    <div className="ag-stats">
      <div className="ag-stat">
        <div className="n">{profiles}</div>
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
        <div className="n agent">{running}</div>
        {/* U12: this read "specialists in a working state" — the retired noun,
            on the page whose own comment says the word is dropped. What is
            counted is ENGAGEMENTS, the same unit the "waiting on a human" stat
            beside it counts, so it says the same word for it. F34-5: "in a
            working state" was the task's `waiting` flag wearing a run's
            clothes; the number is now runs in flight, and the label says so. */}
        <div className="l">agent threads with a run in flight</div>
      </div>
      <div className="ag-stat">
        <div className="n human">{waiting}</div>
        {/* P14-WL-04: this counted agent ENGAGEMENTS parked on a human in
            THIS project, while the board counted tasks and Home counted the
            viewer's own decisions org-wide — three different questions with
            near-identical copy, side by side in one session. Each surface now
            names its own scope. F34-5: the waiting is the TASK's (an engagement
            can be running on a task that waits on a human), so the label names
            the task as the thing that waits. */}
        <div className="l">agent threads waiting on a human</div>
      </div>
    </div>
  );
}

export function LiveRoster({
  deployments,
  onOpen,
  nameById,
  iconById,
  operatorBackend,
}: {
  deployments: AgentDeploymentView[];
  onOpen: (taskKey: string) => void;
  /** profileId → display name, so live rows show a human name instead of the
   *  raw profileId (P11-42). The row falls back to the profileId when a name
   *  can't be resolved. */
  nameById?: Record<string, string>;
  /** profileId → the profile's own icon (ruling 625), so a row wears the mark
   *  the Profiles tab gives it; the Backend column names the backend. */
  iconById?: Record<string, string>;
  /** Ruling 479(e): the backend an operator run starts on. The Backend column
   *  printed "orchestration" for every operator row, a word for no runtime,
   *  while the operator runs on Claude or Codex like any agent. */
  operatorBackend: "codex" | "claude";
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
          // D8: absent → why it matters → next action (P16).
          <div className="empty sm">
            {/* U12: "specialist" is retired vocabulary (C11/FR14) — the objects
                on this page are agent profiles, engaged per task as the
                delivering or a supporting agent. */}
            No agents are currently engaged. When an operator or an agent profile
            is running on a task, it appears here with its live status. Open a
            task and run the operator to engage one.
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
          const icon = iconById?.[d.profileId];
          return (
            <button
              type="button"
              className="live-row"
              key={`${d.profileId}:${d.taskKey}:${d.engagement}`}
              onClick={() => onOpen(d.taskKey)}
            >
              <span className="live-agent">
                {/* Ruling 625: the profile's own glyph, as on the Profiles tab
                    (Developer drew Codex's cpu here and its branch there). A
                    row whose profile is gone keeps the backend's tile. */}
                <span
                  className={
                    "agent-glyph" +
                    (isOp
                      ? " op"
                      : icon
                        ? ""
                        : " " + (d.backend === "claude" ? "claude" : "codex"))
                  }
                >
                  <Icon
                    name={
                      icon
                        ? storeIcon(icon)
                        : isOp
                          ? "shield"
                          : d.backend === "claude"
                            ? "sparkle"
                            : "cpu"
                    }
                  />
                </span>
                <span className="live-ident">
                  <span
                    className="live-name"
                    {...(resolved
                      ? {}
                      : {
                          title: `No profile named ${d.profileId} is approved on this project. The engagement outlived its profile.`,
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
                  ? BACKEND_LABEL[operatorBackend]
                  : d.backend
                    ? BACKEND_LABEL[d.backend]
                    : "Codex"}
              </span>
              <span className="live-task">
                <span className="key">{d.taskKey}</span>{" "}
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
                  {engagementLabel(d.engagement)}
                </Pill>
              </span>
              <span>
                <DeploymentStatusPill d={d} />
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
      notices?: { kind: "repaired" | "withheld"; message: string }[];
      /** F20-20: an operator autonomy elevation / direct-accept grant, named so
       *  the admin sees what the save just enabled (the generic "updated" tick
       *  hid that the operator can now close tasks without a human). */
      governanceNotice?: { message: string };
    }
  | { ok: false; error: string };

/** The form fields a profile create/edit posts to the route action. */
type ProfileSubmitFields = {
  intent: "create-profile" | "update-profile";
  _csrf: string;
  payload: string;
  profileId?: string;
};

/**
 * The page head (ruling 700(e), the split of `AgentsPage` along the task-page
 * recipe): the title and its sentence, the Profiles/Live switch, and the
 * matrix, library and new-profile buttons. Hook-free: the page owns the tab
 * and every modal's state and hands in their setters.
 */
function AgentsHead({
  tab,
  setTab,
  deployments,
  libraryProfiles,
  canManage,
  setMatrixOpen,
  setLibraryOpen,
  setCreating,
}: {
  tab: "profiles" | "live";
  setTab: (next: "profiles" | "live") => void;
  deployments: AgentDeploymentView[];
  libraryProfiles: LibraryProfileView[];
  canManage: boolean;
  setMatrixOpen: (open: boolean) => void;
  setLibraryOpen: (open: boolean) => void;
  setCreating: (open: boolean) => void;
}) {
  return (
    <div className="board-head">
      <div>
        <h1>Agents</h1>
        {/* C11 — record the profile-vs-engagement split the task page settled
            on (UXA-6 / FR14): these are reusable PROFILES; per task the
            operator engages one as the DELIVERING agent and others as
            SUPPORTING agents. The old "specialist" vocabulary is dropped
            below so one object stops carrying three names one click apart.

            OBS-7 residual: this line ended "· global base, customized for
            <project>" — a blanket claim over a roster where the answer is
            per profile, and one each selected profile's own scope line
            already gives (`.ag-scope`, which composes the template's sentence
            with the fork). A project-created profile was never a global base,
            and an untouched deployment was never customized, so the header
            contradicted the card one click away in both directions. Point at
            the card instead of asserting for it. */}
        <div className="sub">
          Reusable agent profiles, eligible stages, and capability policy. The
          operator engages one per task as the delivering agent, others as
          supporting. Each profile names where it came from, and whether this
          project's copy has since diverged.
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
  );
}

/**
 * The Profiles tab (ruling 700(e), the split of `AgentsPage` along the
 * task-page recipe): the roster, operator first, and the open profile's
 * detail. Hook-free: the page owns the selection, the fetcher and every
 * modal, and hands in what the roster and the detail call.
 */
function ProfilesTab({
  operator,
  specialists,
  current,
  libraryProfiles,
  counts,
  backendHealth,
  canManage,
  setSel,
  setCreating,
  setLibraryOpen,
  stages,
  workflow,
  resourceCatalog,
  rulingsKb,
  deployments,
  projectName,
  viewerIsOrgAdmin,
  onOpen,
  deleteProfile,
  setEditing,
  syncResources,
}: {
  operator: AgentProfileView | null;
  specialists: AgentProfileView[];
  current: AgentProfileView | null;
  libraryProfiles: LibraryProfileView[];
  /** Per profile, the tasks it has a run in flight on. */
  counts: Record<string, number>;
  backendHealth: BackendHealthMap | undefined;
  canManage: boolean;
  setSel: (profileId: string) => void;
  setCreating: (open: boolean) => void;
  setLibraryOpen: (open: boolean) => void;
  stages: StageView[];
  workflow: WorkflowEdgeView[];
  resourceCatalog: readonly ResCatalogGroup[] | undefined;
  rulingsKb: string | null;
  deployments: AgentDeploymentView[];
  projectName: string;
  viewerIsOrgAdmin: boolean;
  onOpen: (taskKey: string) => void;
  deleteProfile: (profileId: string) => void;
  setEditing: (a: AgentProfileView) => void;
  syncResources: (a: AgentProfileView) => void;
}) {
  return (
    <div className="agents-layout">
      <aside className="profile-list">
        {/* Ruling 518: the operator is one agent, so it heads the list on
            its own, with no group label naming a second role for it. */}
        {operator && (
          <ProfileItem
            a={operator}
            count={counts[operator.id] ?? 0}
            {...(backendHealth ? { health: backendHealth } : {})}
            on={current?.id === operator.id}
            onClick={() => setSel(operator.id)}
          />
        )}
        <div className="ag-group-label">
          {/* C11: "delivering agent" is the shipped vocabulary (UXA-6);
              "Specialist" was a third name for the same object. These are
              the assignable agent profiles (the operator is the one above).
              Design pass 2026-09-08: no "+" in the label — this view had
              three controls for one action (the toolbar's New profile, the
              dashed row under the list, and this); the two that belong to
              the page and to the list stay. */}
          Agent profiles
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
            New agent profile
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
          {...(rulingsKb ? { rulingsKb } : {})}
          insts={deployments.filter((d) => d.profileId === current.id)}
          projectName={projectName}
          canManage={canManage}
          canSyncTemplate={viewerIsOrgAdmin}
          onOpen={onOpen}
          onDelete={deleteProfile}
          onEdit={setEditing}
          onSyncResources={syncResources}
        />
      )}
    </div>
  );
}

export function AgentsPage({
  profiles,
  library,
  deployments,
  stages,
  workflow,
  projectSlug,
  projectName,
  myRole,
  viewerIsOrgAdmin = false,
  resourceCatalog,
  backendHealth,
  rulingsKb = null,
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
  myRole: ProjectRole | null;
  /** Ruling 156 (owner, Q35-8): the org role decides who may copy a
   *  template's grants onto this project; a project admin sees the marker. */
  viewerIsOrgAdmin?: boolean;
  /** Live store resources for the profile-editor picker (F6/item-2). */
  resourceCatalog?: readonly ResCatalogGroup[];
  /** F16 + ruling 127: per backend, whether the VIEWER connected it and how
   *  many project members have. One probe answers every backend claim on this
   *  page, including the editor's note (there is no second, quietly divergent
   *  `backendAvailable` pair any more). */
  backendHealth?: BackendHealthMap | undefined;
  /** Ruling 239: the project's rulings knowledge base, injected into every run
   *  the project makes. Null when the project names none. */
  rulingsKb?: string | null;
}) {
  const navigate = useNavigate();
  const push = useToast();
  const csrf = useCsrfToken();
  const fetcher = useFetcher<ProfileActionResult>();

  const canManage = roleCan(myRole, "manage-agents");
  const viewerConnected = viewerConnections(backendHealth);
  const { sel, tab, setSel, setTab } = useProfileSelection();
  const [creating, setCreating] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfileView | null>(null);
  // Ruling 459: a save or deploy that lands plays the open modal's exit; the
  // modal's onClose then unmounts it and clears this.
  const [modalDone, setModalDone] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { operator, operatorBackend, specialists, libraryProfiles, current } = rosterOf(
    profiles,
    library,
    sel,
  );

  const counts = useMemo(() => runningTaskCounts(deployments), [deployments]);

  // Live-roster rows carry only a profileId (AgentDeploymentView has no name);
  // resolve a human display name from the profiles the page already holds,
  // falling back to the profileId when unresolved (P11-42).
  const nameById = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p.name])),
    [profiles],
  );
  const iconById = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p.icon])),
    [profiles],
  );

  const { operators, running, waiting } = engagementTallies(deployments);

  const onOpen = (taskKey: string) =>
    navigate(`/projects/${projectSlug}/tasks/${taskKey}`);

  // One handled-result effect (phase-5/7 pattern): toast, close on success,
  // keep the modal open with the server error otherwise.
  useFetcherResult(fetcher, (d) => {
    if (d.ok) {
      push(d.toast);
      for (const notice of d.notices ?? []) {
        push(notice.message, notice.kind === "withheld" ? "error" : "success");
      }
      // F20-20: a governance elevation (full autonomy / direct-accept) gets its
      // own toast naming the consequence — the save succeeded, so it is not
      // error-toned, but it must not be silent under the generic "updated" tick.
      if (d.governanceNotice) {
        push(d.governanceNotice.message);
      }
      if (creating || editing || libraryOpen) setModalDone(true);
      setFormError(null);
      if (d.profileId) setSel(d.profileId);
    } else if (creating || editing) {
      setFormError(d.error);
    } else {
      // P13-D-10: `push` defaults to the "success" kind, so this failure
      // rendered under a green tick.
      push(d.error, "error");
    }
  });

  const submitProfile = (payload: ProfileFormPayload) => {
    setFormError(null);
    const fields: ProfileSubmitFields = {
      intent: editing ? "update-profile" : "create-profile",
      _csrf: csrf,
      payload: JSON.stringify(payload),
    };
    // Only an edit names a profile; create posts no `profileId` field.
    if (editing) fields.profileId = editing.id;
    fetcher.submit(fields, { method: "post" });
  };

  const deployFromLibrary = (profileId: string) => {
    fetcher.submit(
      { intent: "deploy-profile", _csrf: csrf, profileId },
      { method: "post" },
    );
  };

  // Ruling 156: take the template's grants onto this project's copy, carrying
  // the record the page rendered so a save landing in between is refused.
  const syncResources = (a: AgentProfileView) => {
    fetcher.submit(
      {
        intent: "sync-profile-resources",
        _csrf: csrf,
        profileId: a.id,
        fingerprint: a.fingerprint,
      },
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
      <AgentsHead
        tab={tab}
        setTab={setTab}
        deployments={deployments}
        libraryProfiles={libraryProfiles}
        canManage={canManage}
        setMatrixOpen={setMatrixOpen}
        setLibraryOpen={setLibraryOpen}
        setCreating={setCreating}
      />

      {/* UXA-15: Policy and project Settings both explain their read-only state
          to a role without the grant; Agents — where the New profile, Add from
          library, Edit and Delete affordances all simply vanish — said nothing,
          so a contributor saw a roster they could not touch and no reason why. */}
      {!canManage && (
        <div className="pol-note">
          <Icon name="lock" />
          <span>
            {/* F20-16: name the REAL grant (the Policy matrix's own label for
                `manage-agents`) and the REAL tier — `manage-agents` is
                `roles: [A]` (rbac.ts), a project admin only, NOT a maintainer.
                The old copy invented "Manage agents … (project admin or
                maintainer)", telling a maintainer they hold a grant this page
                then refuses. */}
            Read-only: deploying, editing or removing agent profiles needs the{" "}
            <strong>Manage agent profiles</strong> grant, held by a project
            admin. The capability matrix below is readable by every member.
          </span>
        </div>
      )}
      <AgentStats
        profiles={profiles.length}
        operators={operators}
        running={running}
        waiting={waiting}
      />

      {tab === "profiles" ? (
        <ProfilesTab
          operator={operator}
          specialists={specialists}
          current={current}
          libraryProfiles={libraryProfiles}
          counts={counts}
          backendHealth={backendHealth}
          canManage={canManage}
          setSel={setSel}
          setCreating={setCreating}
          setLibraryOpen={setLibraryOpen}
          stages={stages}
          workflow={workflow}
          resourceCatalog={resourceCatalog}
          rulingsKb={rulingsKb}
          deployments={deployments}
          projectName={projectName}
          viewerIsOrgAdmin={viewerIsOrgAdmin}
          onOpen={onOpen}
          deleteProfile={deleteProfile}
          setEditing={setEditing}
          syncResources={syncResources}
        />
      ) : (
        <LiveRoster
          deployments={deployments}
          onOpen={onOpen}
          nameById={nameById}
          iconById={iconById}
          operatorBackend={operatorBackend}
        />
      )}

      {(creating || editing) && (
        <CreateProfileModal
          key={editing?.id}
          initial={editing}
          stages={stages}
          projectName={projectName}
          busy={fetcher.state !== "idle"}
          done={modalDone}
          error={formError}
          {...(resourceCatalog ? { resourceCatalog } : {})}
          {...(viewerConnected ? { viewerConnected } : {})}
          onClose={() => {
            setCreating(false);
            setEditing(null);
            setModalDone(false);
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
          adding={deployingProfileId(fetcher)}
          done={modalDone}
          onClose={() => {
            setLibraryOpen(false);
            setModalDone(false);
          }}
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
