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
  // Dynamic-dispatch rework (2026-08-29): the four slot-shaped kinds collapsed
  // into `run_agent` — the operator recommends running a chosen agent with a
  // prompt; Apply dispatches it exactly as the manual run-agent control would.
  kind:
    | "run_agent"
    | "transition"
    | "accept_completion"
    // R15-2: the operator recommends DELIVERY (push + review PR); applying it
    // performs the delivery under the human's authorization.
    | "delivery";
  profileId?: string;
  /** run_agent — the directive the dispatched run will follow (rendered on the
   *  card: the human must see the instruction they are authorizing). */
  prompt?: string;
  /** run_agent — the operator's explicit posture hint, when it gave one. */
  delivers?: boolean;
  toStageId?: string;
  label: string;
  detail: string;
}

const KIND_ICON = {
  run_agent: "bolt",
  transition: "board",
  accept_completion: "check",
  delivery: "github",
} as const satisfies Record<RecommendationView["kind"], IconName>;

const KIND_LABEL = {
  run_agent: "Run agent",
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
                  {/* Hunt 2026-08-29: an explicit posture hint rides the card
                      and Apply installs it — say which one, or the human
                      authorizes a shape they never saw. */}
                  {r.kind === "run_agent" && r.delivers !== undefined
                    ? r.delivers
                      ? " · delivering"
                      : " · supporting"
                    : ""}
                </span>
                <span className="op-rec-title">{r.label}</span>
              </div>
              {r.detail && <div className="op-rec-detail">{r.detail}</div>}
              {/* Hunt 2026-08-29: `prompt` is the DIRECTIVE Apply hands the
                  run. It was never rendered, so whenever the operator supplied
                  a separate `reason` the human approved an instruction they
                  had not seen. Shown only when it adds information the detail
                  line does not already carry verbatim. */}
              {r.kind === "run_agent" && r.prompt && r.prompt !== r.detail && (
                <div className="op-rec-prompt">
                  Directive: &ldquo;{r.prompt}&rdquo;
                </div>
              )}
            </div>
            {/* Apply AND Dismiss are both maintainer-level (M1) — the server
                enforces admin|maintainer for each, so hide them from lower
                roles rather than render a button that 403s on click. */}
            {canApply && (
              <div className="op-rec-actions">
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => onApply(r.id)}
                  title={
                    r.kind === "accept_completion"
                      ? "Apply the operator's recommendation (asks before merging)"
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
