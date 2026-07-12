import { useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { reviewRowSub, type ReviewRowView } from "./review-helpers";
import type { PrState } from "~/schemas/task-file.schema";

function prPill(
  state: PrState,
): { kind: "done" | "info" | "risk" | "input"; label: string } {
  switch (state) {
    case "merged":
      return { kind: "done", label: "merged" };
    case "closed":
      return { kind: "risk", label: "closed" };
    case "accepted":
      return { kind: "input", label: "merge pending" };
    default:
      return { kind: "info", label: "in review" };
  }
}

/**
 * Review queue — the human acceptance boundary as a read-only triage list
 * (review-queue.md, ported 1:1 from design/html-app/app/review.jsx).
 *
 * Zero mutations here: rows navigate to task detail (where packet
 * resolution lives, Phase 5), the policy chip navigates to Policy. Human
 * decisions are split into this viewer's responsibility versus the project
 * team's; agent work and unattended review tasks remain distinct. Rows leave
 * the queue live via the shell's SSE revalidation (Phase 6).
 */

function RQRow({
  t,
  onOpen,
  status,
}: {
  t: ReviewRowView;
  onOpen: (key: string) => void;
  status: "mine" | "other" | "agent" | "none";
}) {
  const sub = reviewRowSub(t);
  return (
    <button type="button" className="rq-row" onClick={() => onOpen(t.key)}>
      <span className="rq-key">{t.key}</span>
      <span className="rq-main">
        <div className="ttl">{t.title}</div>
        <div className="sub">{sub}</div>
      </span>
      <span className="rq-meta">
        {t.pr && (() => {
          const meta = prPill(t.pr.state);
          return (
            <Pill kind={meta.kind} sm>
              PR #{t.pr.number} · {meta.label}
            </Pill>
          );
        })()}
        <ValidationPill value={t.validation} sm />
        {status === "mine" ? (
          <span className="wait-tag human">
            <Icon name="hand" />
            your decision
          </span>
        ) : status === "other" ? (
          <span className="wait-tag human">
            <Icon name="user" />
            teammate decision
          </span>
        ) : status === "agent" ? (
          <span className="wait-tag agent">
            <Icon name="cpu" />
            waiting on agent
          </span>
        ) : (
          <span className="wait-tag">
            <Icon name="alert" />
            no active handoff
          </span>
        )}
      </span>
    </button>
  );
}

export function ReviewQueuePage({
  projectSlug,
  ready,
  others = [],
  working,
  unattended = [],
  total,
}: {
  projectSlug: string;
  ready: ReviewRowView[];
  others?: ReviewRowView[];
  working: ReviewRowView[];
  unattended?: ReviewRowView[];
  total: number;
}) {
  const navigate = useNavigate();
  const onOpen = (key: string) =>
    navigate(`/projects/${projectSlug}/tasks/${key}`);
  const onPolicy = () => navigate(`/projects/${projectSlug}/policy`);

  return (
    <div className="board-wrap" data-screen-label="Review queue">
      <div className="board-head">
        <div>
          <h1>Review queue</h1>
          <div className="sub">
            {total} task{total === 1 ? "" : "s"} at the review boundary ·{" "}
            {ready.length} waiting on your decision
          </div>
        </div>
        <div className="board-tools">
          <button
            type="button"
            className="hero-file"
            style={{ cursor: "pointer" }}
            onClick={onPolicy}
            title="Review → Done follows the configured completion policy — see Policy"
          >
            <Icon name="lock" />
            <span>Review → Done · governed completion</span>
          </button>
        </div>
      </div>

      <div className="policy-wrap">
        <div className="panel">
          <div className="panel-head">
            <Icon name="hand" />
            <h2>Waiting on your decision</h2>
            <span
              className="right sub"
              style={{ fontSize: ".76rem", color: "var(--faint)" }}
            >
              {ready.length} of {total}
            </span>
          </div>
          {ready.length ? (
            <div className="rq-list">
              {ready.map((t) => (
                <RQRow key={t.key} t={t} onOpen={onOpen} status="mine" />
              ))}
            </div>
          ) : (
            <div className="empty">
              Nothing waits on you. Completion reports land here when a task
              reaches the boundary.
            </div>
          )}
          <div
            className="pol-note"
            style={{ marginBottom: 0, marginTop: ".9rem" }}
          >
            <Icon name="lock" />
            <span>
              Acceptance consumes healthy evidence and every required reviewer
              approval. Repo-less work moves to <strong>Done</strong>. Repository
              work reaches Done only after its linked PR is truly merged; until
              then it stays in Review as <strong>merge pending</strong> — every
              outcome is audited.
            </span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <Icon name="activity" />
            <h2>Waiting on agents</h2>
            <span
              className="right sub"
              style={{ fontSize: ".76rem", color: "var(--faint)" }}
            >
              {working.length}
            </span>
          </div>
          {working.length ? (
            <div className="rq-list">
              {working.map((t) => (
                <RQRow key={t.key} t={t} onOpen={onOpen} status="agent" />
              ))}
            </div>
          ) : (
            <div className="empty">No review tasks are waiting on an agent.</div>
          )}
        </div>

        {others.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <Icon name="user" />
              <h2>Waiting on the project team</h2>
              <span className="right sub">{others.length}</span>
            </div>
            <div className="rq-list">
              {others.map((t) => (
                <RQRow key={t.key} t={t} onOpen={onOpen} status="other" />
              ))}
            </div>
          </div>
        )}

        {unattended.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <Icon name="alert" />
              <h2>No active handoff</h2>
              <span className="right sub">{unattended.length}</span>
            </div>
            <div className="rq-list">
              {unattended.map((t) => (
                <RQRow key={t.key} t={t} onOpen={onOpen} status="none" />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
