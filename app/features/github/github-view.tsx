import { useFetcher, useNavigate } from "react-router";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useActionToast } from "~/ui/use-action-toast";
import { CredentialCard, CredentialManageActions } from "./credential-card";
import { RECONCILE_START_TOAST } from "./github-copy";
import {
  checksPill,
  connectionPill,
  mergeablePill,
  prStatePill,
  reviewPill,
  syncPill,
} from "./github-pills";
import type {
  BranchRowView,
  GithubViewData,
  PrRowView,
} from "./github-query.server";

/**
 * GitHub repository panel (connection + credential health incl. the
 * VIB-142 scope-violation banner), pull-request list, execution-branch
 * table. All governed data comes from the loader; the only mutations are
 * the Reconcile and Grant-scope route actions (POST + CSRF, toast copy from
 * the server). Row clicks navigate to task detail.
 *
 * Panels are presentational (props + callbacks) so jsdom tests render them
 * without a router; GithubViewPage wires fetchers/navigation.
 */

type ActionResult = { ok: true; toast: string } | { ok: false; error: string };

const PANEL_COUNT_STYLE = {
  fontSize: ".76rem",
  color: "var(--faint)",
} as const;
const POL_NOTE_STYLE = { marginBottom: 0, marginTop: ".9rem" } as const;

export function RepositoryPanel({
  data,
  onOpenTask,
  warnActions,
  manageActions,
}: {
  data: Pick<GithubViewData, "project" | "connection" | "credential">;
  onOpenTask: (taskKey: string) => void;
  warnActions?: React.ReactNode;
  manageActions?: React.ReactNode;
}) {
  const conn = connectionPill(data.connection);
  // G8: the Connection pill is a LIVE repository-access probe while the
  // credential card below shows the STORED project credential — in seed / probe
  // states they can disagree (pill "no credential" above a PAT card with
  // scopes). When they diverge, add a one-line note so the two surfaces read as
  // measuring different things rather than contradicting each other.
  const showProbeNote =
    conn.kind !== "ready" && data.credential.source !== "none";
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="github" />
        <h2>Repository</h2>
      </div>
      <div className="kv">
        <div className="kv-row">
          <span className="k">Default repository</span>
          <span className="v">
            <Icon name="github" />
            {data.project.repo ? (
              <span className="mono">{data.project.repo}</span>
            ) : (
              <span className="fine md dim">—</span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Connection</span>
          <span
            className="v"
            style={
              showProbeNote
                ? {
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: ".35rem",
                  }
                : undefined
            }
          >
            <Pill kind={conn.kind} dot sm>
              {conn.label}
            </Pill>
            {showProbeNote && (
              <span className="probe-note">
                Live repository probe — the stored project credential is shown
                below.
              </span>
            )}
          </span>
        </div>
        {/* P13-D-5: this row hardcoded "project default · task-level override
            allowed" — a capability nothing implemented (no writer ever set
            `task.repo`) and which the Settings toggle could not turn off either,
            since it was hardcoded. One project, one repository. */}
        <div className="kv-row">
          <span className="k">Task attachment</span>
          <span className="v plain">
            every task uses this repository
          </span>
        </div>
      </div>

      <CredentialCard
        credential={data.credential}
        onOpenTask={onOpenTask}
        warnActions={warnActions}
        manageActions={manageActions}
        connectionAuth={
          data.connection.status === "auth_failed"
            ? data.connection.reason
            : "ok"
        }
      />
    </div>
  );
}

export function PullRequestsPanel({
  prs,
  defaultBranch,
  onOpenTask,
}: {
  prs: PrRowView[];
  defaultBranch: string;
  onOpenTask: (taskKey: string) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="pr" />
        <h2>Pull requests</h2>
        <span className="right sub" style={PANEL_COUNT_STYLE}>
          {prs.length} linked to tasks
        </span>
      </div>
      <div className="rq-list">
        {prs.length === 0 && (
          // Empty state the mock never designed (spec §7.9a) — quiet copy.
          <div className="pol-note last">
            <Icon name="pr" />
            <span>
              No pull requests yet — one is opened at the review boundary by
              the server or the delivering agent.
            </span>
          </div>
        )}
        {prs.map((row) => {
          const pill = prStatePill(row.state);
          return (
            <button
              type="button"
              className="rq-row"
              key={row.taskKey}
              onClick={() => onOpenTask(row.taskKey)}
            >
              <span className="rq-key">#{row.number}</span>
              <span className="rq-main">
                <div className="ttl">{row.title}</div>
                <div className="sub">
                  <span className="mono">{row.branch}</span> → {defaultBranch}{" "}
                  · {row.taskKey}
                </div>
              </span>
              <span className="rq-meta">
                {/* P13-D-28: this page is where someone comes to answer "is
                    this PR safe to accept". CI health was fetched on every
                    reconcile pass and discarded, and GitHub's review verdict
                    was never read at all. */}
                {row.checks && (
                  <Pill kind={checksPill(row.checks).kind} sm>
                    {checksPill(row.checks).label}
                  </Pill>
                )}
                {row.review && (
                  <Pill kind={reviewPill(row.review).kind} sm>
                    {reviewPill(row.review).label}
                  </Pill>
                )}
                {/* F17-L6: a conflicting PR cannot be merged — surface it here,
                    where a human decides whether it is safe to accept. */}
                {mergeablePill(row.mergeable) && (
                  <Pill kind={mergeablePill(row.mergeable)!.kind} sm>
                    {mergeablePill(row.mergeable)!.label}
                  </Pill>
                )}
                <Pill kind={pill.kind} sm dot>
                  {pill.label}
                </Pill>
              </span>
            </button>
          );
        })}
      </div>
      <div className="pol-note" style={POL_NOTE_STYLE}>
        <Icon name="lock" />
        <span>
          Merging stays reserved for humans — accepting a completion in the
          review queue merges its PR when GitHub is reachable; otherwise it
          records accepted (merge pending).
        </span>
      </div>
    </div>
  );
}

export function BranchesPanel({
  branches,
  onOpenTask,
}: {
  branches: BranchRowView[];
  onOpenTask: (taskKey: string) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="branch" />
        <h2>Execution branches</h2>
        <span className="right sub" style={PANEL_COUNT_STYLE}>
          {branches.length} task-key branch{branches.length === 1 ? "" : "es"}
        </span>
      </div>
      <div className="gh-table">
        <div className="live-table">
          <div className="live-head">
            <span>Task</span>
            <span>Execution branch</span>
            <span>Pull request</span>
            <span>Sync</span>
          </div>
          {branches.length === 0 && (
            // Empty state the mock never designed (spec §7.9b).
            <div className="empty sm">
              No execution branches yet — a task-key branch is created when
              execution starts.
            </div>
          )}
          {branches.map((row) => {
            const s = syncPill(row.sync);
            const prPill = row.pr ? prStatePill(row.pr.state) : null;
            return (
              <button
                type="button"
                className="live-row"
                key={row.taskKey}
                onClick={() => onOpenTask(row.taskKey)}
              >
                <span className="live-task">
                  <span className="key mono">{row.taskKey}</span>{" "}
                  <span className="ttl">{row.title}</span>
                </span>
                <span className="live-branch">
                  <span className="trace ok">
                    <Icon name="branch" />
                    {row.branch}
                  </span>
                  {row.commitCount > 0 && (
                    <span className="fine xs">
                      {row.commitCount}{" "}
                      {row.commitCount === 1 ? "commit" : "commits"}
                    </span>
                  )}
                </span>
                <span>
                  {row.pr && prPill ? (
                    <>
                      <Pill kind={prPill.kind} sm>
                        #{row.pr.number}
                      </Pill>
                      {/* P13-D-28: only the actionable state here — this is a
                          single narrow column, and the PR list above carries
                          the full CI/review detail. */}
                      {row.pr.checks?.state === "failing" && (
                        <Pill kind={checksPill(row.pr.checks).kind} sm>
                          {checksPill(row.pr.checks).label}
                        </Pill>
                      )}
                      {row.pr.review === "changes_requested" && (
                        <Pill kind={reviewPill(row.pr.review).kind} sm>
                          {reviewPill(row.pr.review).label}
                        </Pill>
                      )}
                      {/* F17-L6: a conflict is actionable here too — the branch
                          needs a rebase before its PR can merge. */}
                      {mergeablePill(row.pr.mergeable) && (
                        <Pill kind={mergeablePill(row.pr.mergeable)!.kind} sm>
                          {mergeablePill(row.pr.mergeable)!.label}
                        </Pill>
                      )}
                    </>
                  ) : (
                    <span className="fine md dim">—</span>
                  )}
                </span>
                <span>
                  <Pill kind={s.kind} sm dot>
                    {s.label}
                  </Pill>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="pol-note" style={POL_NOTE_STYLE}>
        <Icon name="branch" />
        <span>
          Branch names and commit messages carry the task key — task → branch
          → commit → PR stays traceable without asking.
        </span>
      </div>
    </div>
  );
}

export function GithubViewPage({
  data,
  myRole,
}: {
  data: GithubViewData;
  myRole: string | null;
}) {
  const navigate = useNavigate();
  const push = useToast();
  const csrf = useCsrfToken();
  const reconcileFetcher = useFetcher<ActionResult>();
  const grantFetcher = useFetcher<ActionResult>();
  const credFetcher = useFetcher<ActionResult>();
  useActionToast(reconcileFetcher);
  useActionToast(grantFetcher);
  useActionToast(credFetcher);

  const slug = data.project.slug;
  const openTask = (taskKey: string) =>
    navigate(`/projects/${slug}/tasks/${taskKey}`);

  // UI-37: `reconcile-github` is admin|maintainer (enforced at
  // routes/project.github.tsx). The button used to render for every role and
  // push "Updating branch and PR status from GitHub…" BEFORE submitting, so a
  // viewer clicked, watched fake progress, and then got a 403 — while the
  // sibling grant-scope control in this same file was correctly gated.
  const canReconcile = roleCan(myRole as ProjectRole | null, "reconcile-github");
  const reconcile = () => {
    if (!canReconcile) return;
    // First toast on submit, completion toast from the action (spec §4.1).
    push(RECONCILE_START_TOAST);
    reconcileFetcher.submit(
      { intent: "reconcile", _csrf: csrf },
      { method: "post" },
    );
  };
  const grantScope = () => {
    grantFetcher.submit(
      { intent: "grant-scope", _csrf: csrf },
      { method: "post" },
    );
  };

  // Grant scope stays a governed credential action (conventions: PAT/policy
  // changes are admin-shaped; project roles admin|maintainer hold it).
  const canGrant = roleCan(myRole as ProjectRole | null, "grant-github-scope");
  // Grant scope RE-CHECKS an existing PAT's scopes — meaningless when no
  // credential is configured (F6). Only offer it once a PAT is bound; the
  // no-credential card still shows "Fix in Settings" / "Attach credential".
  const hasCredential = data.credential.source === "pat";
  const busy =
    reconcileFetcher.state !== "idle" || grantFetcher.state !== "idle";

  // The cred-warn action slot: Grant scope (re-check, lives here until the
  // Phase-9 Settings card exists) + the mock's Fix in Settings navigation.
  const warnActions = (
    <span className="warn-acts">
      {canGrant && hasCredential && (
        <button
          type="button"
          className="btn sm"
          onClick={grantScope}
          disabled={busy}
          title="Re-check the credential's scopes against GitHub"
        >
          <Icon name="check" />
          Grant scope
        </button>
      )}
      <button
        type="button"
        className="btn sm"
        onClick={() => navigate(`/projects/${slug}/settings`)}
      >
        <Icon name="sliders" />
        Fix in Settings
      </button>
    </span>
  );

  // Attach / rotate / remove the project credential (finding #13) —
  // admin|maintainer, same gate as Grant scope.
  const manageActions = canGrant ? (
    <CredentialManageActions
      configured={data.credential.source === "pat"}
      canManage={canGrant}
      busy={credFetcher.state !== "idle"}
      onSet={() =>
        credFetcher.submit(
          { intent: "set-credential", _csrf: csrf },
          { method: "post" },
        )
      }
      onClear={() =>
        credFetcher.submit(
          { intent: "clear-credential", _csrf: csrf },
          { method: "post" },
        )
      }
    />
  ) : undefined;

  return (
    <div className="board-wrap" data-screen-label="GitHub">
      {/* Live updates (phase 6): no subscription needed HERE — this route
          is a child of routes/project.tsx, whose shell already subscribes
          project:<slug> + user scopes (useLiveUpdates). task.updated /
          violation.updated / projection.rebuilt all match the project
          scope, and useRevalidator refreshes every active loader,
          including this route's. */}
      <div className="board-head">
        <div>
          <h1>GitHub</h1>
          <div className="sub">
            Execution surface for {data.project.name} — branches, pull
            requests, and credential health
          </div>
        </div>
        <div className="board-tools">
          {/* P11-14: GitHub state is served from cache; a background poller
              refreshes it every 5 minutes, and "Update status" refreshes it now.
              Show how fresh it is so stale state can't look current. */}
          <span
            className={"gh-freshness" + (data.reconcile.stale ? " stale" : "")}
            title={
              data.reconcile.at
                ? "Branch/PR state auto-refreshes every 5 minutes — click Update status to refresh now."
                : "Branch/PR state has not been synced with GitHub yet."
            }
          >
            <Icon name={data.reconcile.stale ? "alert" : "clock"} />
            {data.reconcile.at
              ? `Updated ${data.reconcile.label}`
              : "Not yet synced"}
          </span>
          {canReconcile && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={reconcile}
              disabled={busy}
              title="Update branch/PR status from GitHub now"
            >
              <Icon name="refresh" />
              Update status
            </button>
          )}
          {data.project.repo && (
            <a
              className="btn ghost sm"
              href={`${data.githubHost}/${data.project.repo}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="ext" />
              Open on GitHub
            </a>
          )}
        </div>
      </div>

      <div className="policy-wrap">
        <div className="policy-cols">
          <RepositoryPanel
            data={data}
            onOpenTask={openTask}
            warnActions={warnActions}
            manageActions={manageActions}
          />
          <PullRequestsPanel
            prs={data.prs}
            defaultBranch={data.project.defaultBranch}
            onOpenTask={openTask}
          />
        </div>
        <BranchesPanel branches={data.branches} onOpenTask={openTask} />
      </div>
    </div>
  );
}
