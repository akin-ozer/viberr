import { useEffect, useRef } from "react";
import {
  useFetcher,
  useNavigate,
  type FetcherWithComponents,
} from "react-router";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { CredentialCard } from "./credential-card";
import { RECONCILE_START_TOAST } from "./github-copy";
import { connectionPill, prStatePill, syncPill } from "./github-pills";
import type {
  BranchRowView,
  GithubViewData,
  PrRowView,
} from "./github-query.server";

/**
 * GitHub view (design/html-app/app/github.jsx → 1:1 port, github-view
 * spec): repository panel (connection + credential health incl. the
 * VIB-142 scope-violation banner), pull-request list, execution-branch
 * table. All governed data comes from the loader; the only mutations are
 * the Reconcile and Grant-scope route actions (POST + CSRF, toast copy from
 * the server). Row clicks navigate to task detail.
 *
 * Panels are presentational (props + callbacks) so jsdom tests render them
 * without a router; GithubViewPage wires fetchers/navigation.
 */

type ActionResult = { ok: true; toast: string } | { ok: false; error: string };

/** Toast once per completed fetcher submission (phase-5 pattern). */
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

const PANEL_COUNT_STYLE = {
  fontSize: ".76rem",
  color: "var(--faint)",
} as const;
const POL_NOTE_STYLE = { marginBottom: 0, marginTop: ".9rem" } as const;

export function RepositoryPanel({
  data,
  onOpenTask,
  warnActions,
}: {
  data: Pick<GithubViewData, "project" | "connection" | "credential">;
  onOpenTask: (taskKey: string) => void;
  warnActions?: React.ReactNode;
}) {
  const conn = connectionPill(data.connection);
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
              <span style={{ color: "var(--placeholder)", fontSize: ".8rem" }}>
                —
              </span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Connection</span>
          <span className="v">
            <Pill kind={conn.kind} dot sm>
              {conn.label}
            </Pill>
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Task attachment</span>
          <span
            className="v"
            style={{
              fontWeight: 400,
              fontFamily: "var(--font-body)",
              fontSize: ".8rem",
              color: "var(--faint)",
            }}
          >
            project default · task-level override allowed
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Repos per task</span>
          <span className="v">1 · V1 limit</span>
        </div>
      </div>

      <CredentialCard
        credential={data.credential}
        onOpenTask={onOpenTask}
        warnActions={warnActions}
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
          <div className="pol-note" style={{ marginBottom: 0 }}>
            <Icon name="pr" />
            <span>
              No pull requests yet — the developer specialist opens one at the
              review boundary.
            </span>
          </div>
        )}
        {prs.map((row) => {
          const pill = prStatePill(row.state);
          return (
            <button
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
          review queue merges its PR.
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
          {branches.length} task-key branches
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
            <div className="empty" style={{ padding: "1rem" }}>
              No execution branches yet — a task-key branch is created when
              execution starts.
            </div>
          )}
          {branches.map((row) => {
            const s = syncPill(row.sync);
            const prPill = row.pr ? prStatePill(row.pr.state) : null;
            return (
              <button
                className="live-row"
                key={row.taskKey}
                onClick={() => onOpenTask(row.taskKey)}
              >
                <span className="live-task">
                  <span className="key mono">{row.taskKey}</span>{" "}
                  <span className="ttl">{row.title}</span>
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: ".45rem",
                    minWidth: 0,
                  }}
                >
                  <span className="trace ok" style={{ fontSize: ".74rem" }}>
                    <Icon name="branch" />
                    {row.branch}
                  </span>
                  {row.commitCount > 0 && (
                    <span style={{ color: "var(--faint)", fontSize: ".72rem" }}>
                      {row.commitCount}{" "}
                      {row.commitCount === 1 ? "commit" : "commits"}
                    </span>
                  )}
                </span>
                <span>
                  {row.pr && prPill ? (
                    <Pill kind={prPill.kind} sm>
                      #{row.pr.number}
                    </Pill>
                  ) : (
                    <span
                      style={{ color: "var(--placeholder)", fontSize: ".8rem" }}
                    >
                      —
                    </span>
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
  useActionToast(reconcileFetcher);
  useActionToast(grantFetcher);

  const slug = data.project.slug;
  const openTask = (taskKey: string) =>
    navigate(`/projects/${slug}/tasks/${taskKey}`);

  const reconcile = () => {
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
  const canGrant = myRole === "admin" || myRole === "maintainer";
  const busy =
    reconcileFetcher.state !== "idle" || grantFetcher.state !== "idle";

  // The cred-warn action slot: Grant scope (re-check, lives here until the
  // Phase-9 Settings card exists) + the mock's Fix in Settings navigation.
  const warnActions = (
    <span
      style={{
        marginLeft: "auto",
        display: "inline-flex",
        gap: ".4rem",
        flex: "none",
      }}
    >
      {canGrant && (
        <button
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
        className="btn sm"
        onClick={() => navigate(`/projects/${slug}/settings`)}
      >
        <Icon name="sliders" />
        Fix in Settings
      </button>
    </span>
  );

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
          <button
            className="btn ghost sm"
            onClick={reconcile}
            disabled={busy}
            title="Reconcile task state with GitHub"
          >
            <Icon name="refresh" />
            Reconcile
          </button>
          {data.project.repo && (
            <a
              className="btn ghost sm"
              href={`https://github.com/${data.project.repo}`}
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
