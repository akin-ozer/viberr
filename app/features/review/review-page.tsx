import { useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { reviewRowSub, type ReviewRowView } from "./review-helpers";

/**
 * Review queue — the human acceptance boundary as a read-only triage list.
 *
 * Zero mutations here: rows navigate to task detail (where packet
 * resolution lives, Phase 5), the policy chip navigates to Policy. The split is
 * member-scoped by acceptance authority (R8-3): "your acceptance" lists only the
 * human-waiting tasks THIS viewer can accept; a human-waiting task someone else
 * must accept lands in "Still in review" labeled "waiting on a human" (never the
 * false "agent working"). Rows leave the queue live via the shell's SSE
 * revalidation (Phase 6).
 *
 * The wait-tag copy is deliberately different from the board ("your
 * acceptance" vs "waiting on you") — do not unify. The subline builder
 * lives in review-helpers.ts (Fast Refresh: components-only module).
 *
 * P13-D-9: the "human only" chip and the acceptance footer are conditional on
 * the project's operator authority (see review-acceptance-authority.server.ts).
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
    <button
      type="button"
      className="rq-row"
      onClick={() => onOpen(t.key)}
      // R15-11: the queue's whole job is deciding, yet the row was an unlabeled
      // clickable region — the surface read as actionless. It stays a triage
      // list (a decision belongs with its evidence: the diff, the verdict, the
      // packet), but the row now NAMES where it goes. Deliberately "Review",
      // not "Accept": acceptance is verdict-gated (R15-1) and may refuse, and a
      // control must not name an outcome this surface cannot promise — the same
      // rule F15-22 was filed under.
      aria-label={`Review ${t.key}: ${t.title}`}
    >
      <span className="rq-key">{t.key}</span>
      <span className="rq-main">
        <div className="ttl">{t.title}</div>
        <div className="sub">{sub}</div>
      </span>
      <span className="rq-meta">
        {t.pr && (
          <Pill
            kind={
              t.pr.state === "merged"
                ? "done"
                : t.pr.state === "closed"
                  ? "neutral"
                  : "info"
            }
            sm
          >
            PR #{t.pr.number}
            {t.pr.state === "closed" ? " · closed" : ""}
          </Pill>
        )}
        <ValidationPill value={t.validation} sm />
        {ready ? (
          <span className="wait-tag human">
            <Icon name="hand" />
            your acceptance
          </span>
        ) : t.waiting === "human" ? (
          // Human-waiting, but not THIS viewer's to accept (R8-3) — a human still
          // needs to act, so never the false "agent working".
          <span className="wait-tag human">
            <Icon name="hand" />
            waiting on a human
          </span>
        ) : (
          <span className="wait-tag agent">
            <span className="working" />
            agent working
          </span>
        )}
        <span className="rq-go" aria-hidden="true">
          Review
          <Icon name="chevron" />
        </span>
      </span>
    </button>
  );
}

export function ReviewQueuePage({
  projectSlug,
  ready,
  working,
  total,
  stageNames = { review: "Review", terminal: "Done" },
  acceptance = { operatorCanAccept: false, operatorName: "the operator" },
}: {
  projectSlug: string;
  ready: ReviewRowView[];
  working: ReviewRowView[];
  total: number;
  /** UI-49: the project's RESOLVED review + terminal stage names — stages are
   *  per-project and renameable, so this page must not name them itself. */
  stageNames?: { review: string; terminal: string };
  /** P13-D-9: whether this project's operator holds the ONE audited exception
   *  to the human-only terminal boundary (full autonomy +
   *  `completion-for-acceptance: direct`, owner ruling Q1). Defaults to the
   *  strict boundary so a caller that cannot resolve it never over-promises
   *  the other way. */
  acceptance?: { operatorCanAccept: boolean; operatorName: string };
}) {
  const navigate = useNavigate();
  const onOpen = (key: string) =>
    navigate(`/projects/${projectSlug}/tasks/${key}`);
  const onPolicy = () => navigate(`/projects/${projectSlug}/policy`);
  const { operatorCanAccept, operatorName } = acceptance;

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
          {/* UI-27 residual: this was a <button> wearing `hero-file`, visually
              identical to the non-interactive `hero-file` spans elsewhere — no
              affordance that it navigates. It reads as the link it is now. */}
          {/* P13-D-9: the chip claimed "human only" on EVERY project. On an
              Autonomous-preset project the operator holds an explicit
              `completion-for-acceptance: direct` grant and closes tasks itself,
              so the chip has to say so — the same exception Policy and the
              create modal already disclose. */}
          <button
            type="button"
            className="btn ghost sm"
            onClick={onPolicy}
            title={
              operatorCanAccept
                ? `${operatorName} runs at full autonomy with Completion for human acceptance set to Direct, so it can move a task to ${stageNames.terminal} itself — every other actor at this boundary is a human. See Policy.`
                : `${stageNames.review} → ${stageNames.terminal} is locked to humans — see Policy`
            }
          >
            <Icon name={operatorCanAccept ? "bolt" : "lock"} />
            <span>
              {stageNames.review} → {stageNames.terminal} ·{" "}
              {operatorCanAccept ? "human or operator" : "human only"}
            </span>
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
            <Icon name={operatorCanAccept ? "bolt" : "lock"} />
            {/* P13-D-9: wording tracks the Policy note (policy-page.tsx) — one
                exception, explicitly granted and audited, never a general
                "agents can close tasks". */}
            {operatorCanAccept ? (
              <span>
                Accepting a completion merges the review PR and moves the task
                to <strong>{stageNames.terminal}</strong> — always in the audit
                log. Normally a human action, with one exception on this
                project: <strong>{operatorName}</strong> runs at{" "}
                <strong>full autonomy</strong> with{" "}
                <strong>Completion for human acceptance</strong> set to{" "}
                <em>Direct</em>, an explicit opt-in that lets it accept a
                completion itself (it still refuses a failing-validation task).
              </span>
            ) : (
              <span>
                Accepting a completion merges the review PR and moves the task
                to <strong>{stageNames.terminal}</strong> — always a human
                action, always in the audit log.
              </span>
            )}
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
