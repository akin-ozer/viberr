import { useState } from "react";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon, type IconName } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { useRefusalShake } from "~/ui/use-refusal-shake";
import { TASK_RECOMMENDATIONS_ANCHOR } from "~/shared/page-anchors";
import { reachesAcceptance } from "./reaches-acceptance";

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
 * (F19-3 / F19-26 / ruling 97). The panel owns no fetcher and no confirm state:
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
  /** accept_completion — ruling 99: the work revision the offer was authored
   *  against; the card says "for revision <sha7>" so a reader can tell whether
   *  the offer still describes the branch. */
  forHeadSha?: string;
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

/** Ruling 286: the one recommendation whose Apply or Dismiss is in flight. */
export interface RecommendationInFlight {
  recId: string;
  action: "apply" | "dismiss";
}

export function OperatorRecommendations({
  recommendations,
  targeted = false,
  canApply,
  busy,
  inFlight = null,
  onApply,
  onDismiss,
  acceptanceRefusal = null,
  terminalStageId = null,
}: {
  recommendations: RecommendationView[];
  /** Ruling 302: a recommendation's notification opened the cards
   *  (`#recommendations`). */
  targeted?: boolean;
  /** admin|maintainer — gates the Apply button (server re-checks). */
  canApply: boolean;
  busy: boolean;
  /** Ruling 286: which card's request is in flight, so THAT button shows it —
   *  the loader spinning where its glyph was and a label naming the work —
   *  while every other control just waits. Applying an acceptance merges on
   *  GitHub, which takes seconds; the confirm has closed by then, and a card
   *  that merely dimmed read as refused, not as working. */
  inFlight?: RecommendationInFlight | null;
  /** Page-owned: an `accept_completion` (or terminal-stage `transition`) Apply
   *  reaches the acceptance confirm before it submits (F19-3). */
  onApply: (recId: string) => void;
  onDismiss: (recId: string) => void;
  /** Ruling 95 (pass 35, F35-12 (c)): the acceptance gate's standing refusal
   *  (`acceptance.blockedReason`), or null. An acceptance card renders it as
   *  a keyed alert and its Apply refuses the click instead of opening a
   *  confirm the server would answer 409 (ruling 288's shape: the control
   *  stays, the refusal sentence is the alert). */
  acceptanceRefusal?: string | null;
  /** The terminal stage id, so a `transition` card into it counts as an
   *  acceptance card too. */
  terminalStageId?: string | null;
}) {
  // A refused Apply re-keys the alert so the sentence is announced again.
  const [refused, setRefused] = useState<{ id: string; n: number } | null>(null);
  // Ruling 284: the note shakes once per refused click. A note that comes
  // back when the gate blocks again, after a refresh, answers no click.
  const refusalShake = useRefusalShake(refused ? `${refused.id}:${refused.n}` : null);
  if (recommendations.length === 0) return null;
  return (
    <div
      className="panel op-recs"
      id={TASK_RECOMMENDATIONS_ANCHOR}
      tabIndex={-1}
      data-targeted={targeted || undefined}
    >
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
                {r.kind === "accept_completion" && r.forHeadSha && (
                  <span className="op-rec-revision">
                    for revision <code>{r.forHeadSha.slice(0, 7)}</code>
                  </span>
                )}
              </div>
              {/* U39-7: the operator writes its reason the way it writes every
                  comment, with `code` and **bold**, and the card printed the
                  backticks ("Reviewer approved `9471594`"). The one-line
                  micro-format renderer, not markdown: a card is one line. */}
              {r.detail && (
                <div className="op-rec-detail">
                  <RichText text={r.detail} />
                </div>
              )}
              {/* Hunt 2026-08-29: `prompt` is the DIRECTIVE Apply hands the
                  run. It was never rendered, so whenever the operator supplied
                  a separate `reason` the human approved an instruction they
                  had not seen. Shown only when it adds information the detail
                  line does not already carry verbatim. */}
              {r.kind === "run_agent" && r.prompt && r.prompt !== r.detail && (
                <div className="op-rec-prompt">
                  Directive: &ldquo;<RichText text={r.prompt} />&rdquo;
                </div>
              )}
              {acceptanceRefusal && reachesAcceptance(r, terminalStageId) && (
                <p
                  key={`refusal-${r.id}-${refused?.id === r.id ? refused.n : 0}`}
                  // Ruling 284: the note stands on its own before any click;
                  // it shakes only as the answer to a refused one.
                  className={"deny-note spaced" + (refused?.id === r.id && refusalShake.shake ? " refused" : "")}
                  onAnimationEnd={refused?.id === r.id ? refusalShake.onAnimationEnd : undefined}
                  role="alert"
                >
                  <Icon name="alert" />
                  <span>
                    <strong>Not acceptable now.</strong> {acceptanceRefusal}
                  </span>
                </p>
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
                  aria-busy={inFlight?.recId === r.id && inFlight.action === "apply"}
                  onClick={() => {
                    // Ruling 95: an acceptance the gate refuses is not offered;
                    // the click re-announces the reason instead of submitting.
                    if (acceptanceRefusal && reachesAcceptance(r, terminalStageId)) {
                      setRefused((cur) => ({ id: r.id, n: cur?.id === r.id ? cur.n + 1 : 1 }));
                      return;
                    }
                    onApply(r.id);
                  }}
                  title={
                    inFlight?.recId === r.id && inFlight.action === "apply"
                      ? reachesAcceptance(r, terminalStageId)
                        ? "Accepting the completion; the merge follows when GitHub is reachable"
                        : "Applying the recommendation"
                      : r.kind === "accept_completion"
                        ? "Apply the operator's recommendation (asks before merging)"
                        : "Apply the operator's recommendation"
                  }
                >
                  <GlyphSwap
                    rest="check"
                    alt="loader"
                    on={inFlight?.recId === r.id && inFlight.action === "apply"}
                    spinAlt
                  />
                  {inFlight?.recId === r.id && inFlight.action === "apply"
                    ? reachesAcceptance(r, terminalStageId)
                      ? "Accepting…"
                      : "Applying…"
                    : "Apply"}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  aria-busy={inFlight?.recId === r.id && inFlight.action === "dismiss"}
                  onClick={() => onDismiss(r.id)}
                  title="Dismiss without acting"
                >
                  {inFlight?.recId === r.id && inFlight.action === "dismiss" ? (
                    <>
                      <Icon name="loader" className="spin" />
                      Dismissing…
                    </>
                  ) : (
                    "Dismiss"
                  )}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
