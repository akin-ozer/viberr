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

/* F19-33: the panel-head count and the trailing policy note used to be hoisted
   inline-style constants here, in policy-page.tsx and in settings-page.tsx —
   three private copies of two declarations the sheet already owns (`.fine`,
   app.css:230; `.pol-note.after` / `.pol-note.last`, app.css:3844-3846), and
   they had already drifted (this file's note sat at .9rem, settings' at .8rem,
   the sheet's at .85rem). Ruling 14: shared single implementations, never fork
   per surface. The count is `right sub fine`, the same three classes seven
   other panel heads use; the note is `pol-note after last`. */

export function RepositoryPanel({
  data,
  onOpenTask,
  canSeeCredential,
  warnActions,
  manageActions,
}: {
  data: Pick<GithubViewData, "project" | "connection" | "credential">;
  onOpenTask: (taskKey: string) => void;
  /**
   * R19-11 (Q-V1, PAT half) — does this reader hold the credential grant?
   *
   * Required, not optional: a caller that forgets it would silently go back to
   * showing every member the token fingerprint, which IS the finding. The
   * decision itself is `roleCan(myRole, "grant-github-scope")` in
   * {@link GithubViewPage} — the same ACTION_ROLES entry the route's action
   * guard enforces, never a role literal.
   */
  canSeeCredential: boolean;
  warnActions?: React.ReactNode;
  manageActions?: React.ReactNode;
}) {
  const conn = connectionPill(data.connection);
  // G8: the Connection pill is a LIVE repository-access probe while the
  // credential card below shows the STORED project credential — in seed / probe
  // states they can disagree (pill "no credential" above a PAT card with
  // scopes). When they diverge, add a one-line note so the two surfaces read as
  // measuring different things rather than contradicting each other.
  //
  // R19-11: the note points AT the card ("shown below"), so it goes when the
  // card goes — a reader without the grant must not be told to look at
  // something that is not there.
  const showProbeNote =
    canSeeCredential &&
    conn.kind !== "ready" &&
    data.credential.source !== "none";
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
              // Ruling 148: the absent fact in words. Same row on the settings
              // page already says "not set" (ruling 14: one declaration, one
              // wording), and the Connection row below already carries the
              // "no repository" pill, so this slot must not repeat it.
              <span className="fine md dim">not set</span>
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
                Live repository probe. The stored project credential is shown
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
          <span className="v plain">every task uses this repository</span>
        </div>
      </div>

      {/* R19-11 (owner ruling, Q-V1 PAT half): the credential card is the
          project's token fingerprint, its scope verdicts and its rotate/remove
          controls. Server-side, every one of those actions gates on
          `grant-github-scope` (routes/project.github.tsx), so the card is
          WITHDRAWN below that tier rather than rendered read-only — ruling 37's
          precedent: a withdrawn affordance is honest, a disabled one invites a
          support question. What stays is the Connection row above, which is the
          only credential fact a reader of the board legitimately needs ("can
          this repository be reached?"), plus a line naming the grant so the gap
          is explained rather than blank. The loader redacts the same fields it
          hides, so the withheld tail is not merely unrendered — it never
          reaches the browser. */}
      {canSeeCredential ? (
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
      ) : (
        <div className="pol-note after last">
          <Icon name="lock" />
          <span>
            Credential details need the <strong>Grant GitHub scope</strong>{" "}
            grant (project admin or maintainer). The Connection row above still
            shows whether this repository is reachable.
          </span>
        </div>
      )}
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
        <span className="right sub fine">
          {prs.length} linked to tasks
        </span>
      </div>
      <div className="rq-list">
        {prs.length === 0 && (
          // Empty state the mock never designed (spec §7.9a) — quiet copy.
          <div className="pol-note last">
            <Icon name="pr" />
            <span>
              No pull requests yet. One is opened at the review boundary by the
              server or the delivering agent.
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
                  <span className="mono">{row.branch}</span> → {defaultBranch} ·{" "}
                  {row.taskKey}
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
      {/* F19-34: this used to say "accepting a completion in the review queue".
          The queue performs zero mutations — it is a read-only triage list whose
          rows navigate to task detail, which is exactly why ruling 30 (R15-11)
          labels its row "Review" and not "Accept". Acceptance happens on the
          task page, next to the evidence it is judged against, so the note names
          that surface. */}
      <div className="pol-note after last">
        <Icon name="lock" />
        <span>
          Merging stays reserved for humans. Accepting a completion on its task
          page merges its PR when GitHub is reachable; otherwise it records
          accepted (merge pending).
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
        <span className="right sub fine">
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
              No execution branches yet. A task-key branch is created when
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
                      {/* F20-23: a closed-not-merged (or merge-pending) PR used
                          to render a bare `#162` with only a colour tint, so a
                          reader scanning this table could not tell the delivery
                          was rejected. Carry the state word — "closed" /
                          "merge pending" — the way the PR list above does. An
                          open "in review" PR and a "merged" one stay bare here:
                          the Sync column already says "merged", and the narrow
                          column keeps the common open state uncluttered. */}
                      <Pill kind={prPill.kind} sm>
                        #{row.pr.number}
                        {row.pr.state !== "review" &&
                          row.pr.state !== "merged" &&
                          ` · ${prPill.label}`}
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
                    // Ruling 148: inside the row BUTTON a bare "−" reads as a
                    // per-row remove control. Same words as the task page's
                    // neutral "no PR" pill.
                    <span className="fine md dim">no PR</span>
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
      <div className="pol-note after last">
        <Icon name="branch" />
        <span>
          Branch names and commit messages carry the task key, so task → branch
          → commit → PR stays traceable without asking.
        </span>
      </div>
    </div>
  );
}

/**
 * F19-22: "when did a reconcile pass last COMPLETE?", computed in the route
 * loader (`routes/project.github.tsx`) off the per-tick `github.reconcile.task`
 * audit row. Same shape as `data.reconcile` — which answers the different
 * question "when did the cached state last CHANGE?" — and deliberately a
 * separate value: the chip renders both, because one of them going quiet is
 * normal and the other going quiet means the poller or the credential is down.
 */
export interface ReconcileCheckView {
  /** ISO of the newest completed pass, or null when none is on record. */
  at: string | null;
  /** Server-rendered relative label ("2m ago"), null when `at` is. */
  label: string | null;
  /** `at` is missing or older than the staleness threshold. */
  stale: boolean;
}

export function GithubViewPage({
  data,
  reconcileCheck,
  myRole,
}: {
  data: GithubViewData;
  /** F19-22 — see {@link ReconcileCheckView}. Required, not optional: a caller
   *  that forgets it would silently go back to rendering the last CHANGE as
   *  though it were the last check, which is the defect. */
  reconcileCheck: ReconcileCheckView;
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
  //
  // SAFETY: `myRole` is the project layout loader's own value (routes/project.tsx
  // — `project_members.role`, which 0001_baseline CHECK-constrains to exactly the
  // four project roles, or "admin" for the org-admin override, or null); this
  // page's prop is what widens it to `string`. `roleCan` denies any value outside
  // the four regardless, so the widening can only ever under-grant.
  const canReconcile = roleCan(
    myRole as ProjectRole | null,
    "reconcile-github",
  );
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

  // The ONE credential-authority decision on this page (R19-11): `roleCan` over
  // the same `grant-github-scope` ACTION_ROLES entry the route's action guard
  // enforces for grant-scope, set-credential and clear-credential alike. It
  // decides all three things that ARE that action — whether the credential card
  // is disclosed, whether Grant scope is offered, and whether the
  // attach/rotate/remove row renders — so a role can never be shown a control
  // it may not use, nor hidden from one it may. The loader redacts the payload
  // on the same rule; a client-only gate would leave the token tail in the HTML.
  //
  // SAFETY: same loader-sourced `myRole` as `canReconcile` above.
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

  // R17-5 (UX-3): "never synced" and "stale cache" are different situations
  // and the payload already distinguishes them (`at: null` vs an old
  // timestamp) — but both rendered the coral alert tone, so a brand-new
  // project's FIRST impression of this page was a warning about nothing being
  // wrong. Only a genuinely old cache warns; never-synced reads neutral with a
  // nudge to run the first sync.
  const changeStale = data.reconcile.stale && data.reconcile.at !== null;
  // F19-22: with a completed pass on record the warn tone tracks THAT, not the
  // last change. An hour without a change is what a quiet repository looks like
  // and must not shout; an hour without a CHECK means the poller or the
  // credential is down, which is the only case here worth a warning — and the
  // case the old chip could not see (`reconcileTaskExclusive` returns BEFORE the
  // `github.reconcile.task` audit write on `auth_failed` / `network_unavailable`,
  // so a poller running against a dead PAT stops this clock while the change
  // clock, frozen anyway, looks no different than on a quiet day).
  //
  // With no check on record `reconcileCheck.stale` is meaningless — the loader
  // derives it from a null instant — so the last change is the only evidence a
  // pass ever ran and the R17-5 rule above still decides.
  const staleCache = reconcileCheck.at ? reconcileCheck.stale : changeStale;
  const changeLabel = data.reconcile.at
    ? `last change ${data.reconcile.label}`
    : "no changes recorded";
  const freshnessText = reconcileCheck.at
    ? `Checked ${reconcileCheck.label} · ${changeLabel}`
    : data.reconcile.at
      ? `Last change ${data.reconcile.label}`
      : "No changes recorded";
  const freshnessTitle = reconcileCheck.at
    ? staleCache
      ? "No reconcile pass has completed for over an hour, though the background poller re-checks GitHub every 5 minutes. Either every branched task here is finished (the poller skips terminal tasks, so a wrapped-up project goes quiet legitimately), or the poller or credential is down and the branch and PR state below is out of date. Update status checks now."
      : "When a reconcile pass last completed, and when one last found a change. The background poller re-checks GitHub every 5 minutes and records nothing on a pass that finds nothing new, so a much older last change means a quiet repository. Update status forces a check now."
    : staleCache
      ? "No branch or PR change has been recorded for over an hour. The background poller re-checks GitHub every 5 minutes and records nothing on a pass that finds nothing new, so this is also what a quiet repository looks like. Update status forces a check now."
      : data.reconcile.at
        ? "When the cached branch/PR state last CHANGED. A background poller re-checks GitHub every 5 minutes and records nothing on a pass that finds nothing new. Update status forces a check now."
        : "No branch or PR change has been recorded yet. Nothing is wrong. Update status checks GitHub now.";

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
            Execution surface for {data.project.name}: branches, pull requests,
            and credential health
          </div>
        </div>
        <div className="board-tools">
          {/* P11-14: GitHub state is served from cache; a background poller
              refreshes it every 5 minutes, and "Update status" refreshes it now.
              Show how fresh it is so stale state can't look current.

              F19-22: `data.reconcile.at` is `MAX(observed_at)` over
              `github.reconcile` PROVENANCE, and DG-3 skips that row on an
              unchanged poller tick — so it is the last pass that CHANGED
              something, never the last pass that ran. Labelled "Updated Nm ago"
              it claimed the second while holding the first, and contradicted its
              own tooltip's "every 5 minutes" (live-proven on the task panel:
              "Synced 1h ago" over seven successful passes in the same hour).
              The second half now arrives as `reconcileCheck` (the per-tick
              `github.reconcile.task` audit row, unioned with the human sweep's
              project row) and the chip renders both: "Checked 2m ago · last
              change 40m ago" says in one line what neither number could say
              alone. */}
          <span
            className={"gh-freshness" + (staleCache ? " stale" : "")}
            title={freshnessTitle}
          >
            <Icon name={staleCache ? "alert" : "clock"} />
            {freshnessText}
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
            canSeeCredential={canGrant}
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
