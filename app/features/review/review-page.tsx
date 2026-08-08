import { useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { Pill, ValidationPill } from "~/ui/pill";
import { capabilityById } from "~/shared/capabilities";
import { prStatePill } from "~/features/github/github-pills";
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

/**
 * UXV19-1: the capability's rendered NAME comes from the shared catalog, by id.
 *
 * This page shipped the retired label "Completion for human acceptance" in both
 * the chip tooltip and the acceptance footer — and it is the surface that sends
 * the reader to Policy to verify the claim, where the same control is called
 * "Accept completion into Done" (the rename's reason is on the catalog entry:
 * the old label read as a guarantee it does not make). Naming the control by
 * hand is what let the rename miss this file; reading it from the catalog means
 * the queue, Policy and the Agents profile cannot say three different things.
 */
const ACCEPTANCE_CAP_LABEL =
  capabilityById("completion-for-acceptance")?.label ??
  "Accept completion into Done";

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
        {/* UXA-2: this queue carried its OWN pr-state colour map, so a
            closed-unmerged (rejected) PR rendered neutral grey here while the
            canonical `prStatePill` (ruling 12) renders it `risk` on the board,
            task detail and the GitHub page — and `closed` is a first-class row
            state in this very queue, with rose-toned rework/archive copy in its
            subline. Same defect UI-36 fixed on task detail. Use the one map. */}
        {t.pr && (
          <Pill kind={prStatePill(t.pr.state).kind} sm>
            PR #{t.pr.number}
            {t.pr.state === "merged" || t.pr.state === "review"
              ? ""
              : ` · ${prStatePill(t.pr.state).label}`}
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
          {/* P13-D-9: the chip claimed "human only" on EVERY project. On a
              full-autonomy project whose operator ALSO holds an explicit
              `completion-for-acceptance: direct` grant, that operator closes
              tasks itself, so the chip has to say so — the same exception
              Policy and the create modal already disclose. (The grant is
              `promotable: false`: no preset and no autonomy change ever confers
              it; an admin sets it deliberately.) */}
          <button
            type="button"
            className="btn ghost sm"
            onClick={onPolicy}
            title={
              operatorCanAccept
                ? `${operatorName} runs at full autonomy and separately holds ${ACCEPTANCE_CAP_LABEL} set to Direct, so it can move a task to ${stageNames.terminal} itself — every other actor at this boundary is a human. See Policy.`
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
            <span className="right sub fine">
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
          <div className="pol-note after last">
            <Icon name={operatorCanAccept ? "bolt" : "lock"} />
            {/* P13-D-9: wording tracks the Policy note (policy-page.tsx) — one
                exception, explicitly granted and audited, never a general
                "agents can close tasks". UXV19-1: the control's name is the
                catalog's, so "tracks the Policy note" stays true. */}
            {operatorCanAccept ? (
              <span>
                Accepting a completion merges the review PR and moves the task
                to <strong>{stageNames.terminal}</strong> — always in the audit
                log. Normally a human action, with one exception on this
                project: <strong>{operatorName}</strong> runs at{" "}
                <strong>full autonomy</strong> and separately holds{" "}
                <strong>{ACCEPTANCE_CAP_LABEL}</strong> set to <em>Direct</em> —
                an explicit grant, never implied by the autonomy setting, that
                lets it accept a completion itself (it still refuses a
                failing-validation task).
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
            <span className="right sub fine">{working.length}</span>
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
