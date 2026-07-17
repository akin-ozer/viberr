import { useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { reviewRowSub, type ReviewRowView } from "./review-helpers";

/**
 * Review queue — the human acceptance boundary as a read-only triage list
 * (review-queue.md, ported 1:1 from design/html-app/app/review.jsx).
 *
 * Zero mutations here: rows navigate to task detail (where packet
 * resolution lives, Phase 5), the policy chip navigates to Policy. The
 * split is project-wide per ruling 10 — labels unchanged. Rows leave the
 * queue live via the shell's SSE revalidation (Phase 6).
 *
 * The wait-tag copy is deliberately different from the board ("your
 * acceptance" vs "waiting on you") — do not unify. The subline builder
 * lives in review-helpers.ts (Fast Refresh: components-only module).
 */

function RQRow({
  t,
  onOpen,
  ready,
}: {
  t: ReviewRowView;
  onOpen: (key: string) => void;
  ready?: boolean;
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
        {t.pr && (
          <Pill kind={t.pr.state === "merged" ? "done" : "info"} sm>
            PR #{t.pr.number}
          </Pill>
        )}
        <ValidationPill value={t.validation} sm />
        {ready ? (
          <span className="wait-tag human">
            <Icon name="hand" />
            your acceptance
          </span>
        ) : (
          <span className="wait-tag agent">
            <span className="working" />
            agent working
          </span>
        )}
      </span>
    </button>
  );
}

export function ReviewQueuePage({
  projectSlug,
  ready,
  working,
  total,
}: {
  projectSlug: string;
  ready: ReviewRowView[];
  working: ReviewRowView[];
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
            {ready.length} waiting on your acceptance
          </div>
        </div>
        <div className="board-tools">
          <button
            type="button"
            className="hero-file"
            style={{ cursor: "pointer" }}
            onClick={onPolicy}
            title="Review → Done is locked to humans — see Policy"
          >
            <Icon name="lock" />
            <span>Review → Done · human only</span>
          </button>
        </div>
      </div>

      <div className="policy-wrap">
        <div className="panel">
          <div className="panel-head">
            <Icon name="hand" />
            <h2>Waiting on your acceptance</h2>
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
                <RQRow key={t.key} t={t} onOpen={onOpen} ready />
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
              Accepting a completion merges the review PR and moves the task to{" "}
              <strong>Done</strong> — always a human action, always in the
              audit log.
            </span>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <Icon name="activity" />
            <h2>Still in review</h2>
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
                <RQRow key={t.key} t={t} onOpen={onOpen} />
              ))}
            </div>
          ) : (
            <div className="empty">No review work in flight.</div>
          )}
        </div>
      </div>
    </div>
  );
}
