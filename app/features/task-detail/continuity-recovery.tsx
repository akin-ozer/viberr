import { useEffect, useState } from "react";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { Icon } from "~/ui/icon";
import { LocalRelative } from "~/ui/local-time";
import { Pill, type PillKind } from "~/ui/pill";

/**
 * Continuity Recovery Panel — D18, the fifth and last of the UX spec's custom
 * "identity layer" components (Task Status Card, Decision Packet, Execution
 * Truth Strip, Mixed Timeline Item, Continuity Recovery Panel) and the only one
 * that was never built. Pass 18 shipped a partial: the warning-toned
 * `continuity` typed timeline event (`event-meta.ts`, `TYPED_KIND = risk`). A
 * typed event scrolls away; this is what makes the state legible and actionable
 * where the human is already looking.
 *
 * Spec §"Continuity Recovery Panel" — *purpose*: explain runtime-history
 * degradation without breaking trust in the system; *anatomy*: what is known,
 * what is missing, what remains authoritative, recovery path, escalation
 * options; *content guideline*: *lead with authoritative task truth, not
 * provider failure detail*; *accessibility*: distinguish warning from failure
 * and present recovery options in text. FR22 / NFR12 / NFR17 and PRD Journey 4
 * (Murat) are the requirements behind it.
 *
 * WHAT ACTUALLY HAPPENS, and why this panel reports rather than asks. Provider
 * transcripts are not durable (Claude Code sweeps after ~30 days; recreating
 * `docker-data` takes `$CODEX_HOME/sessions` with it). `resumeRun`
 * (`run-service.server.ts`) probes the stored session id with
 * `probeSessionContinuity` BEFORE handing it to the SDK, and on `missing` it
 * does the recovery itself, in one shot: it stamps the dead run with a
 * classified `session_missing` error line, writes the `continuity` typed event
 * to the task file, and re-enters `startRun` with NO `resumeSessionId` and a
 * canonical-anchor preamble. There is no moment where a human is asked "resume
 * or start fresh" — resume is not on the table (the transcript is gone) and the
 * fresh start already happened by the time anyone can look. So this panel does
 * NOT offer a resume/fresh-start choice: that would be a control naming an
 * outcome no server path can promise. It states what was lost, what still holds,
 * where the recovery stands, and routes to the three things that DO exist:
 * inspect the thread's console (FR23), ask the operator, continue by comment.
 *
 * WHERE THE STATE COMES FROM. Two client-visible sources, both already on the
 * page, deliberately unioned:
 *
 *  - `task.timeline` — the canonical `continuity` event, written to `task.md`
 *    by `noteContinuityReset` and projected into `task_events`. This is the
 *    proof that a break happened and the only source of WHEN.
 *  - `runtime` — the affected agent's run group. Runs group per agent
 *    (`<kind>:<profileId>`, stable across resumes — `run-projection.server.ts`),
 *    so the dead run and the fresh re-anchored run land in ONE group: the
 *    group whose console window holds a `…session_missing`-tagged line is the
 *    thread that lost its history, and its representative run's lifecycle
 *    says where recovery stands. The projection reports that marker as the
 *    group's `sessionMissing`, with the dead session id read out of the line's
 *    stored WIRE envelope (`{reason:"session_missing", session_id}`), never
 *    parsed out of display text (`run-projection.server.ts`). This panel used
 *    to scan `lines` and `raw` for it, which only worked while the page
 *    carried every group's window; ruling 457 ships console lines on a hard
 *    load only, so the server finds the marker for it.
 *
 * Bounded by construction, and that is the retirement rule rather than a bug:
 * the loader ships a 30-event timeline slice (`timeline-slice.ts`) and a bounded
 * console window per group (`RunLogWindow`, NFR5). The panel therefore reports a
 * break that is still inside the task's RECENT history; once the task has moved
 * on past it, the panel retires and the record survives in the timeline, which
 * is where a months-old continuity reset belongs. It is never a permanent empty
 * panel and never a permanent full one.
 *
 * NOT SHIPPED, and deliberately not faked: a `continuity:` field on the task
 * frontmatter. That is the right home for this state (it would also feed the
 * board-card cue the spec asks for), but its writer is `run-service.server.ts`
 * and its reader is the `project.task` loader — neither in this change's scope.
 * A schema field nothing writes would be dead canon, so the panel derives from
 * what the page already holds and the gap is reported instead.
 */

/** The typed timeline event pass 18 landed (`TIMELINE_EVENT_TYPES`). */
export const CONTINUITY_EVENT_TYPE = "continuity";

/**
 * The heading of the panel this one points a human at for a new run. Exported
 * so the co-located test can assert `execution-profile.tsx` still renders this
 * exact string — the UX19-4 rule: naming a control that then cannot be found is
 * worse than naming none.
 */
export const EXECUTION_PANEL_LABEL = "Execution profile";

/** Where recovery stands for one affected thread. */
export type ContinuityProgress =
  /** A fresh run for that agent is queued or streaming right now. */
  | "running"
  /** The agent completed a run after re-anchoring. */
  | "recovered"
  /** The newest run ended in error or was interrupted — nothing landed. */
  | "stalled"
  /** No run group could be identified (member gate, or paged out of the window). */
  | "unknown";

export interface ContinuityAgent {
  /** Run-group id — the Agent-logs selection key (`RunView.id`). */
  threadId: string;
  name: string;
  /** "Operator" | "Delivering agent" | "Reviewer" — the engagement, in UI words. */
  roleLabel: string;
  backendLabel: string;
  /** The provider session that is gone, when the wire envelope carried it. */
  sessionId: string | null;
  progress: ContinuityProgress;
}

export interface ContinuityLoss {
  /** ISO of the canonical `continuity` event; null when only the run marker survives. */
  occurredAt: string | null;
  /** Threads whose provider history is gone. Empty ⇒ timeline-only evidence. */
  agents: ContinuityAgent[];
}

function roleLabelOf(run: RunView): string {
  if (run.op || run.kind === "operator") return "Operator";
  return run.kind === "reviewer" ? "Reviewer" : "Delivering agent";
}

function progressOf(run: RunView): ContinuityProgress {
  if (run.lifecycle === "running" || run.lifecycle === "queued") return "running";
  if (run.lifecycle === "finished") return "recovered";
  return "stalled";
}

/**
 * Pure derivation — the panel renders iff this returns non-null. Exported so
 * the state machine is testable without a DOM.
 */
export function deriveContinuityLoss(input: {
  /** Newest-first timeline slice as the loader ships it. */
  timeline: TimelineEventRender[];
  runtime: RunView[];
}): ContinuityLoss | null {
  const event =
    input.timeline.find((e) => e.type === CONTINUITY_EVENT_TYPE) ?? null;

  const agents: ContinuityAgent[] = [];
  for (const run of input.runtime) {
    if (!run.sessionMissing) continue;
    agents.push({
      threadId: run.id,
      name: run.who.name,
      roleLabel: roleLabelOf(run),
      backendLabel: BACKEND_LABEL[run.backend],
      sessionId: run.sessionMissing.sessionId,
      progress: progressOf(run),
    });
  }

  if (!event && agents.length === 0) return null;
  return { occurredAt: event?.occurredAt ?? null, agents };
}

/** The panel's headline state, as the header pill renders it. */
interface ContinuityStatus {
  kind: PillKind;
  label: string;
}

/** Pill text carries the state; colour never carries it alone (spec §state semantics). */
function statusPill(agents: ContinuityAgent[]): ContinuityStatus {
  if (agents.length === 0) return { kind: "risk", label: "context lost" };
  if (agents.some((a) => a.progress === "running"))
    return { kind: "risk", label: "re-anchored · running" };
  if (agents.every((a) => a.progress === "recovered"))
    return { kind: "ready", label: "re-anchored · recovered" };
  if (agents.some((a) => a.progress === "stalled"))
    return { kind: "risk", label: "re-anchored · no run since" };
  return { kind: "risk", label: "context lost" };
}

function progressSentence(agent: ContinuityAgent): string {
  switch (agent.progress) {
    case "running":
      return `${agent.name} is running again now, working from this record.`;
    case "recovered":
      return `${agent.name} has completed a run since, working from this record.`;
    case "stalled":
      return `${agent.name} has not completed a run since. Nothing was delivered by the interrupted thread.`;
    default:
      return `The timeline entry below names the thread that lost its history.`;
  }
}

export function ContinuityRecoveryPanel({
  timeline,
  runtime,
  runsVisible = true,
  canRunAgents = false,
  onOpenConsole,
  onAsk,
}: {
  /** The loader's newest-first timeline slice (`task.timeline`). */
  timeline: TimelineEventRender[];
  /** The per-task run projection (`runtime`) — one entry per agent group. */
  runtime: RunView[];
  /** UI-30: false ⇒ the viewer is not a project member and the loader withheld
   *  `lines`/`raw`/`sid`, so there is no console to open and no session id to
   *  name. The panel still reports the break from the canonical timeline. */
  runsVisible?: boolean;
  /** Whether the viewer may start runs — decides whether the continuation note
   *  names the Execution profile panel, which only shows Run to that tier. */
  canRunAgents?: boolean;
  /** Select + scroll to an agent group's console (`useLogSelection.onViewLogs`). */
  onOpenConsole?: (threadId: string) => void;
  /** The page's "Ask operator" signal — prefills and focuses the composer. */
  onAsk?: () => void;
}) {
  const loss = deriveContinuityLoss({ timeline, runtime });

  // A consequential state change has to be ANNOUNCED, not merely rendered
  // (spec §accessibility). A live region that arrives already populated is not
  // reliably spoken — the region has to exist first and CHANGE — so the text is
  // filled a tick after mount. A macrotask, NOT requestAnimationFrame: rAF is
  // suspended entirely in hidden/background tabs (live-verified in the Browser
  // pane), which would leave the region empty until the tab is refocused.
  // Visible copy never flickers because the announcement lives in its own
  // off-screen node.
  const named = loss?.agents[0]?.name ?? null;
  const announcement = loss
    ? `Continuity notice: ${
        named ? `${named}'s` : "an agent thread's"
      } runtime history was lost. The task record is intact.`
    : "";
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (!announcement) {
      setAnnounced("");
      return;
    }
    const id = setTimeout(() => setAnnounced(announcement), 0);
    return () => clearTimeout(id);
  }, [announcement]);

  if (!loss) return null;
  const status = statusPill(loss.agents);
  const subject = named ? `${named}` : "An agent thread";

  return (
    <section className="panel continuity-panel" aria-labelledby="continuity-heading">
      <p className="cont-live" role="status" aria-live="polite">
        {announced}
      </p>
      <div className="panel-head">
        <Icon name="refresh" />
        <h2 id="continuity-heading">Continuity recovery</h2>
        <span className="right">
          <Pill kind={status.kind} dot>
            {status.label}
          </Pill>
        </span>
      </div>

      {/* Lead with what still holds. The provider failure detail is below, in
          the grid, where someone who needs it will look for it. */}
      <p className="packet-lede">
        This task record is still the authority: the goal, decisions, timeline
        and branch references on this page are unchanged by the loss.{" "}
        {subject} lost its provider-side conversation history, re-anchored on
        this record and continued in a fresh session.
      </p>

      <div className="packet-obs flush">
        <div className="obs">
          <span className="k">still authoritative</span>
          <span>
            <code>task.md</code>: goal, decisions, timeline, execution refs and
            the delivered revision. Nothing in it depended on the lost session.
          </span>
        </div>

        {loss.agents.length === 0 ? (
          <div className="obs">
            <span className="k">lost</span>
            <span>
              One agent thread&rsquo;s provider session on this task. Its
              conversation cannot be replayed or exported; the run log it already
              produced is unchanged.
            </span>
          </div>
        ) : (
          loss.agents.map((agent) => (
            <div className="obs" key={agent.threadId}>
              <span className="k">lost</span>
              <span>
                {agent.roleLabel} <strong>{agent.name}</strong>:{" "}
                {agent.backendLabel} conversation history
                {agent.sessionId ? (
                  <>
                    {" "}
                    for session <code>{agent.sessionId}</code>
                  </>
                ) : null}
                . It cannot be replayed or exported; the run log it already
                produced is unchanged.
              </span>
            </div>
          ))
        )}

        {loss.agents.map((agent) => (
          <div className="obs" key={agent.threadId + ":since"}>
            <span className="k">since then</span>
            <span>{progressSentence(agent)}</span>
          </div>
        ))}

        {loss.occurredAt && (
          <div className="obs">
            <span className="k">continuity lost</span>
            <span>
              <LocalRelative iso={loss.occurredAt} />
            </span>
          </div>
        )}
      </div>

      {/* The continuation path, named in text rather than duplicated as a
          control this panel does not own (spec: "present recovery options in
          text"). Both routes end in the same place — an agent reading this
          record — and neither restores the conversation, which is the one thing
          a reader must not be left hoping for. */}
      <p className="hint">
        To continue, @mention{" "}
        {named ? <strong>{named}</strong> : "the agent"} in a comment below
        {canRunAgents ? (
          <>
            {" "}
            or start a run from <strong>{EXECUTION_PANEL_LABEL}</strong>
          </>
        ) : null}
        . It picks up from this record. The lost conversation is not restored by
        either.
      </p>

      <div className="packet-actions">
        {runsVisible &&
          onOpenConsole &&
          loss.agents.map((agent) => (
            <button
              key={agent.threadId}
              type="button"
              className="btn ghost"
              onClick={() => onOpenConsole(agent.threadId)}
            >
              <Icon name="term" />
              Open {agent.name}&rsquo;s console
            </button>
          ))}
        {onAsk && (
          <button type="button" className="btn ghost" onClick={onAsk}>
            <Icon name="message" />
            Ask operator
          </button>
        )}
      </div>
    </section>
  );
}
