import { useNavigate } from "react-router";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime, LocalRelative } from "~/ui/local-time";
import { Pill, ValidationPill } from "~/ui/pill";
import { capabilityById } from "~/shared/capabilities";
import { prStatePill } from "~/features/github/github-pills";
import { DueDatePill, LabelChips, PriorityFlag } from "~/ui/task-meta";
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
 * C4: the row WAIT-TAG uses the two canonical phrases the whole app shares —
 * "waiting on you" (viewer-scoped: this viewer can accept) and "waiting on a
 * human" (project-scoped: someone else must). The queue used to spell the
 * viewer case "your acceptance", a fifth variant of "a human owes something";
 * the panel heading below still names the acceptance action ("Waiting on your
 * acceptance"), which is the queue's PURPOSE, not a per-row status tag. The
 * subline builder lives in review-helpers.ts (Fast Refresh: components-only
 * module).
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
        {/* F19-32: the label rides along for every state the pill's colour
            alone cannot carry — `closed` (rejected) and `accepted`
            ("merge pending", R16-6/ruling 40, which the projection used to
            coerce to "review" before it ever reached this map). `merged` and
            `review` stay bare: the subline says both in words one line above,
            and the queue's density rule is the board card's (only ACTIONABLE
            state earns a second label). */}
        {t.pr && (
          <Pill
            kind={prStatePill(t.pr.state).kind}
            sm
            // Design pass 2026-09-08: the same pair goes QUIET. An open review
            // PR is the normal condition of everything in this queue, so its
            // fill differentiated nothing — and it was the loudest chip on a
            // row whose real state (awaiting verdict) sits in the quiet tier.
            // `closed` and `merge pending` keep the fill with their word.
            quiet={t.pr.state === "merged" || t.pr.state === "review"}
          >
            PR #{t.pr.number}
            {t.pr.state === "merged" || t.pr.state === "review"
              ? ""
              : ` · ${prStatePill(t.pr.state).label}`}
          </Pill>
        )}
        <ValidationPill value={t.validation} sm />
        {/* F26-14: the same triage metadata the board card shows — priority,
            labels and due date — so the acceptance boundary is not blind to an
            urgent or overdue task. Shared `task-meta.tsx` pills (one vocabulary);
            only non-default values render, so a plain task adds nothing. */}
        <PriorityFlag priority={t.priority} sm />
        {t.labels.length > 0 && <LabelChips labels={t.labels} max={3} />}
        <DueDatePill dueDate={t.dueDate} sm />
        {/* Gap-10: the acceptance boundary is where a forgotten task costs the
            most — a completion report nobody answered blocks the merge and the
            branch behind it. The queue carried no time at all, so a row that
            landed five minutes ago and one that has waited since Tuesday were
            pixel-identical. Same neutral pill and same copy as the board card
            (one vocabulary); the row has room for the tooltip the dense card
            cannot carry. */}
        {t.quiet && t.lastActivityAt && (
          <span
            title="Nothing has been recorded on this task since then, and no run is in flight."
          >
            <Pill kind="neutral" sm>
              no activity · <LocalRelative iso={t.lastActivityAt} />
            </Pill>
          </span>
        )}
        {/* D4: the same continuity cue the board card carries (ContinuityTag,
            board-page.tsx) — one vocabulary, one tone (risk), one glyph — so a
            supervisor at the acceptance boundary sees the lost provider session
            too, not only on the task page's Continuity Recovery panel. The row
            has room for the tooltip the dense card cannot carry. */}
        {t.continuity === "degraded" && (
          <span title="A resumed agent session lost its provider transcript; the agent re-anchored on the task record and continued fresh. See the Continuity recovery panel on the task.">
            <Pill kind="risk" sm>
              <Icon name="refresh" />
              degraded continuity
            </Pill>
          </span>
        )}
        {ready ? (
          <span className="wait-tag you">
            <Icon name="hand" />
            waiting on you
          </span>
        ) : t.waiting === "human" ? (
          // Human-waiting, but not THIS viewer's to accept (R8-3) — a human still
          // needs to act, so never the false "agent working".
          <span className="wait-tag human">
            <Icon name="hand" />
            waiting on a human
          </span>
        ) : t.waiting === "schedule" ? (
          // Ruling 225: resting on a clock. Not a person, and not a run.
          <span className="wait-tag scheduled">
            <Icon name="clock" />
            {t.resumesAt ? (
              <>
                resumes <LocalDayDotTime iso={t.resumesAt} />
              </>
            ) : (
              "resumes on its own"
            )}
          </span>
        ) : t.waiting === "agent" ? (
          <span className="wait-tag agent">
            <span className="working" />
            agent working
          </span>
        ) : null}
        {/* F19-31: the branch above used to be a bare `else`, which collapsed
            "agent" and "none". `review + none` is a LEGAL stored combination
            (review-queue.server.ts lists it in "Still in review"), and for it
            the board's WaitTag renders nothing at all (board-page.tsx) while
            this row rendered the pulsing "agent working" — one stored value
            making opposite claims one click apart, the exact defect R8-3 fixed
            for "human". Silence is the board's answer, so it is this row's too;
            the subline carries the fact in words (review-helpers.ts). */}
      </span>
      {/* Design pass 2026-09-08: the action holds one right edge on every
          row; the chips wrap behind it instead of pushing it around. */}
      <span className="rq-go" aria-hidden="true">
        Review
        <Icon name="chevron" />
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
          {/* U35-5: "at the review boundary" named the one stage every row
              used to share. The rows are review work now, wherever it sits
              (an open review PR at Validation counts), so the count says what
              it counts and nothing about a stage. */}
          <div className="sub">
            {total} in review · {ready.length} waiting on your acceptance
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
                ? `${operatorName} runs at full autonomy and separately holds ${ACCEPTANCE_CAP_LABEL} set to Direct, so it can move a task to ${stageNames.terminal} itself. Every other actor at this boundary is a human. See Policy.`
                : `${stageNames.review} → ${stageNames.terminal} is locked to humans. See Policy`
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
        {/* A section with nothing to demand is a well (`.panel.quiet`), not
            the page's heaviest frame drawn around an empty sentence. */}
        <div className={ready.length ? "panel" : "panel quiet"}>
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
            <div className="empty sm">
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
                {/* A10 (pass 23): "merges the review PR" was absolute; a
                    verified no-change completion (no PR) and a no-PR
                    auto-detect accept to the terminal stage without a merge. */}
                Accepting a completion merges its review PR, when there is one,
                and moves the task to <strong>{stageNames.terminal}</strong>,
                always in the audit log. Normally a human action, with one
                exception on this project: <strong>{operatorName}</strong> runs
                at <strong>full autonomy</strong> and separately holds{" "}
                <strong>{ACCEPTANCE_CAP_LABEL}</strong> set to <em>Direct</em>,
                an explicit grant, never implied by the autonomy setting, that
                lets it accept a completion itself (it still refuses a
                failing-validation task).
              </span>
            ) : (
              <span>
                Accepting a completion merges its review PR, when there is one,
                and moves the task to <strong>{stageNames.terminal}</strong>,
                always a human action, always in the audit log.
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
            // D8: absent → why it matters (P16), not a bare label.
            <div className="empty">
              No review work in flight. A task an agent is actively revising in
              a review stage shows here until it reaches the boundary and moves
              to the queue above.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
