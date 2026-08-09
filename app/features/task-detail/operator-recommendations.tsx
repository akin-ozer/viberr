import { Icon, type IconName } from "~/ui/icon";
import { Pill } from "~/ui/pill";

/**
 * Operator recommendations panel — a SUPERVISED operator recommends governed
 * actions (assign a specialist, engage a reviewer, move a stage) rather than
 * performing them. Each pending recommendation renders as a highlighted card
 * with the operator's reasoning and a one-click Apply (admin|maintainer) that
 * executes the same governed mutation, plus Dismiss. Under full autonomy the
 * operator performs the actions itself and no cards appear (it just comments).
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

const KIND_ICON: Record<RecommendationView["kind"], IconName> = {
  assign_specialist: "branch",
  assign_reviewer: "check",
  run_specialist: "bolt",
  run_reviewer: "bolt",
  transition: "board",
  accept_completion: "check",
  delivery: "github",
};

const KIND_LABEL: Record<RecommendationView["kind"], string> = {
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
};

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
                  title="Apply the operator's recommendation"
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
