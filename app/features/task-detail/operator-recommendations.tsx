import { useState } from "react";
import { AcceptConfirm, useAcceptDisclosure } from "./accept-confirm";
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
 * One card kind is NOT one-click: `accept_completion` reaches the same merge
 * writer as the Accept button, so Apply opens the shared acceptance confirm
 * first (F19-3 / ruling 20). The panel therefore has to sit inside the task
 * page's `AcceptDisclosureProvider`.
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
  run_specialist: "Run specialist",
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
  // F19-3 (live-reproduced on VC-1): "Apply" on an `accept_completion` card runs
  // `acceptCompletion` — it merged PR #147 and moved the task to Done from ONE
  // click, with no dialog anywhere in the path. Ruling 20 (R15-1) requires every
  // acceptance to state what merges first, and ruling 53 already closed the
  // board's drag and Move menu; the card the operator writes was the one entry
  // point still merging on a bare click. It opens the SAME confirm the Accept
  // button does, with the page's disclosure — never a second, thinner one.
  const { disclosure, blockedReason } = useAcceptDisclosure();
  const [pendingAccept, setPendingAccept] = useState<RecommendationView | null>(
    null,
  );
  const onApplyClick = (rec: RecommendationView) => {
    if (busy) return;
    if (rec.kind === "accept_completion") {
      setPendingAccept(rec);
      return;
    }
    onApply(rec.id);
  };
  if (recommendations.length === 0) return null;
  return (
    <>
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
                    onClick={() => onApplyClick(r)}
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
      {pendingAccept && (
        <AcceptConfirm
          disclosure={disclosure}
          via={{ kind: "recommendation", title: pendingAccept.label }}
          blockedReason={blockedReason}
          busy={busy}
          onCancel={() => setPendingAccept(null)}
          onConfirm={() => {
            const rec = pendingAccept;
            setPendingAccept(null);
            onApply(rec.id);
          }}
        />
      )}
    </>
  );
}
