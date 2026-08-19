import { Icon, type IconName } from "~/ui/icon";
import { Pill } from "~/ui/pill";

/**
 * Operator recommendations panel — a SUPERVISED operator recommends governed
 * actions (assign a specialist, engage a reviewer, move a stage) rather than
 * performing them. Each pending recommendation renders as a highlighted card
 * with the operator's reasoning and a one-click Apply (admin|maintainer) that
 * executes the same mutation a human would, plus Dismiss. Under full autonomy
 * the operator performs the actions itself and no cards appear (it comments).
 *
 * This is a DUMB panel: Apply and Dismiss call back to the page. One card kind
 * — `accept_completion`, and any `transition` whose target is the terminal
 * stage — reaches the same merge writer as the Accept button, so the page
 * routes THOSE clicks through the shared acceptance confirm before they run
 * (F19-3 / F19-26 / ruling 20). The panel owns no fetcher and no confirm state:
 * a section that owned its own submission structurally could not ask first.
 */

export interface RecommendationView {
  id: string;
  kind:
    | "assign_specialist"
    | "assign_reviewer"
    | "run_specialist"
    | "run_reviewer"
    | "transition"
    | "accept_completion"
    // R15-2: the operator recommends DELIVERY (push + review PR); applying it
    // performs the delivery under the human's authorization.
    | "delivery";
  profileId?: string;
  toStageId?: string;
  label: string;
  detail: string;
}

const KIND_ICON = {
  assign_specialist: "branch",
  assign_reviewer: "check",
  run_specialist: "bolt",
  run_reviewer: "bolt",
  transition: "board",
  accept_completion: "check",
  delivery: "github",
} as const satisfies Record<RecommendationView["kind"], IconName>;

const KIND_LABEL = {
  // UXA-6: this slot is "Delivering agent" everywhere else on THIS page — the
  // execution profile's section header, the "Assign delivering agent" menu and
  // its aria-label, and the GitHub panel's deliver button — so the same actor
  // wore two names one viewport apart. The generic-agents vocabulary won.
  assign_specialist: "Delivering agent",
  assign_reviewer: "Reviewer",
  // …and the row one line below said "Run specialist" for the SAME actor. The
  // server already words this card "Start the delivering agent's run"
  // (operator-actions.server.ts), so the chip was the last holdout.
  run_specialist: "Run delivering agent",
  run_reviewer: "Run reviewer",
  transition: "Stage",
  accept_completion: "Completion",
  delivery: "Delivery",
} as const satisfies Record<RecommendationView["kind"], string>;

export function OperatorRecommendations({
  recommendations,
  canApply,
  busy,
  onApply,
  onDismiss,
}: {
  recommendations: RecommendationView[];
  /** admin|maintainer — gates the Apply button (server re-checks). */
  canApply: boolean;
  busy: boolean;
  /** Page-owned: an `accept_completion` (or terminal-stage `transition`) Apply
   *  reaches the acceptance confirm before it submits (F19-3). */
  onApply: (recId: string) => void;
  onDismiss: (recId: string) => void;
}) {
  if (recommendations.length === 0) return null;
  return (
    <div className="panel op-recs">
      <div className="panel-head">
        <span className="agent-glyph op">
          <Icon name="shield" />
        </span>
        <h2>Operator recommendations</h2>
        <span className="right">
          <Pill kind="agent" dot>
            {recommendations.length} pending
          </Pill>
        </span>
      </div>
      <div className="op-rec-list">
        {recommendations.map((r) => (
          <div className="op-rec" key={r.id}>
            <div className="op-rec-main">
              <div className="op-rec-label">
                <span className="op-rec-kind">
                  <Icon name={KIND_ICON[r.kind]} />
                  {KIND_LABEL[r.kind]}
                </span>
                <span className="op-rec-title">{r.label}</span>
              </div>
              {r.detail && <div className="op-rec-detail">{r.detail}</div>}
            </div>
            {/* Apply AND Dismiss are both maintainer-level (M1) — the server
                enforces admin|maintainer for each, so hide them from lower
                roles rather than render a button that 403s on click. */}
            {canApply && (
              <div className="op-rec-actions">
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={busy}
                  onClick={() => onApply(r.id)}
                  title={
                    r.kind === "accept_completion"
                      ? "Apply the operator's recommendation — asks before merging"
                      : "Apply the operator's recommendation"
                  }
                >
                  <Icon name="check" />
                  Apply
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => onDismiss(r.id)}
                  title="Dismiss without acting"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
