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
    | "accept_completion";
  profileId?: string;
  backend?: "claude" | "codex";
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
};

const KIND_LABEL: Record<RecommendationView["kind"], string> = {
  assign_specialist: "Primary specialist",
  assign_reviewer: "Reviewer",
  run_specialist: "Run specialist",
  run_reviewer: "Run reviewer",
  transition: "Stage",
  accept_completion: "Completion",
};

export function OperatorRecommendations({
  recommendations,
  canApply,
  canApplyCompletion = false,
  completionReady = true,
  busy,
  onApply,
  onDismiss,
}: {
  recommendations: RecommendationView[];
  /** admin|maintainer — gates the Apply button (server re-checks). */
  canApply: boolean;
  /** Current contributor+ task owner may apply only accept_completion. */
  canApplyCompletion?: boolean;
  /** Current immutable validation/review evidence satisfies completion. */
  completionReady?: boolean;
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
        {recommendations.map((r) => {
          const canApplyRecommendation =
            r.kind === "accept_completion"
              ? completionReady && (canApply || canApplyCompletion)
              : canApply;
          return (
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
              {/* Supervisors may dismiss any recommendation. Applying a
                  completion recommendation additionally requires current
                  immutable evidence; a task owner may apply only that kind. */}
              {(canApplyRecommendation || canApply) && (
                <div className="op-rec-actions">
                  {canApplyRecommendation && (
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
                  )}
                  {canApply && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => onDismiss(r.id)}
                      title="Dismiss without acting"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
