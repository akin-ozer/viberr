import { toolIdentity, type ToolIdentity } from "~/shared/mcp-tools";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import {
  agentMessageProse,
  commandNote,
  consoleCodeBlock,
  fileChangeChips,
  filePathOf,
  hiddenArguments,
  toolChip,
  type ConsoleCodeBlock,
  type FileChangeChip,
  type HiddenArguments,
  type ToolChip,
} from "./runs-helpers";
import type { LogLine, RunView } from "./runtime-types";
import type { OlderLogState, StreamedLine, ThreadView } from "./run-log-store";
import { consoleTodos, type TodoSnapshot } from "./console-todos";
import { editDiff, type EditDiff } from "./edit-diff";

/**
 * What the run panels read off a run and its console before they draw
 * (ruling 700(e), the large-component split of `runs-panels.tsx` on the task
 * page's recipe): the Agent logs footer's sentence and the retry it offers,
 * what the console box says about its own history, a console line's shapes
 * and a wait row's figures. Pure functions of the run and the store's thread,
 * no React; a panel or a row calls each at most once per render.
 *
 * Ruling 457: backend labels and count plurals are spelled inline here, as in
 * `runs-panels.tsx`, not through `BACKEND_LABEL` / `countLabel` (why:
 * shared/text/backend-label.ts, shared/text/plural.ts).
 */

/** P13-UI-57: the projection ships the ISO so the CLIENT renders the clock in
 *  the viewer's zone. During SSR + hydration the UTC form is rendered instead
 *  (`hydrated: false`) — the server's zone and the viewer's differ, and a
 *  zone-dependent first paint is a hydration text mismatch (React #418). A
 *  seeded/mock label that isn't an ISO is shown verbatim. */
function finishedClock(value: string, hydrated: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  return hydrated ? formatClock(value) : formatClockUTC(value);
}

// ------------------------------------------------- the Agent logs footer

/** The retry on the other backend that a failed run's console offers, and
 *  what its footer says about it. */
export interface RetryOffer {
  /** The run failed because its backend was unavailable (UI-38). */
  backendUnavailable: boolean;
  /** The backend a retry would run on, when the projection names one. */
  altBackend: "claude" | "codex" | null;
  altLabel: string;
  /** A retry would run AND this viewer may start it: the button shows. */
  canRetryBackend: boolean;
  /** What the footer's sentence ends on: the offer, or why there is none. */
  retryClause: string;
}

export function retryOffer(
  cur: RunView,
  retryBackends: readonly ("claude" | "codex")[] | undefined,
  /** The page handed the panel an `onRetryBackend`. */
  canDispatch: boolean,
): RetryOffer {
  // UI-38: the FAILURE EXPLANATION describes the RUN, not the viewer.
  // `backendUnavailable` is a property of the run (the projection carries it);
  // `canRetryBackend` additionally requires an `onRetryBackend` handler, which
  // the page withholds from anyone without `run-agents` AND while any run is
  // streaming — so a contributor (and everyone during a concurrent run) was told
  // a quota failure was a "continuity error — see the blocked packet", pointing
  // at a packet that need not exist. Only the BUTTON is grant-gated now.
  // Ruling 350: the CLASS describes the run whatever its kind. The kind gate
  // that used to sit here was for the retry clause, which keeps its own gate
  // below (`retryOffered`); on the class it sent an operator drive or a
  // controller turn refused for `unavailable` to the unclassified sentence —
  // "continuity error; see the blocked packet" — and a controller turn has no
  // packet at all.
  const backendUnavailable = cur.state === "error" && !!cur.failedBackendUnavailable;
  // Ruling 127: the retry OFFER needs somebody to bill, which is a different
  // question from why this run failed. The projection withholds `altBackend`
  // when the run had no principal at all (an unowned task), and `retryBackends`
  // is the task owner's live connection set — the same question the blocked
  // packet asks before offering `retry_other_backend` (run-failure-remedy.server.ts),
  // so the button and the packet cannot tell two stories about one task.
  const altBackend = cur.altBackend ?? null;
  const retryPossible =
    backendUnavailable &&
    altBackend !== null &&
    (retryBackends?.includes(altBackend) ?? false);
  const canRetryBackend = retryPossible && canDispatch;
  const altLabel = altBackend === "codex" ? "Codex" : "Claude";
  // Ruling 127: the offer, and when there is none, WHY there is none. A run
  // that failed on quota with an owner who never connected the other backend
  // gets no button on any surface (the blocked packet withholds
  // `retry_other_backend` for the same reason), so the console names the
  // owner's missing connection rather than leaving the absent control
  // unexplained. `retryBackends === undefined` is "not asked", and claims
  // nothing about the owner.
  // Pass 34 review: the "isn't connected" clause is about a retry this panel
  // can offer, and only an AGENT run has one — an operator or controller run
  // has no other backend to move to, so appending it there stated a
  // credential fact that was often false and always irrelevant.
  const retryOffered = cur.kind === "primary" || cur.kind === "reviewer";
  const retryClause = canRetryBackend
    ? `. Retry on ${altLabel}`
    : retryPossible
      ? ". A maintainer can retry it on the other backend"
      : retryOffered && altBackend !== null && retryBackends !== undefined
        ? `. ${altLabel} isn't connected for the task owner, so there is no other backend to retry on`
        : "";
  return { backendUnavailable, altBackend, altLabel, canRetryBackend, retryClause };
}

/** The Agent logs footer: what the shown run is doing, or how it ended. */
export function logsFooter(cur: RunView, hydrated: boolean, offer: RetryOffer): string {
  if (cur.state === "running") {
    // A controller turn's record is its transcript (ruling 99), not a task.
    return cur.kind === "controller"
      ? "streaming: raw output stays here as evidence, never in the transcript"
      : "streaming: raw output stays here as evidence, never in the task record";
  }
  if (cur.lifecycle === "queued") {
    // UI-57: a QUEUED run is not an idle thread. The strip renders only for
    // `running`, so a queued run used to show a "queued" pill next to the
    // footer "thread alive — no run executing", which contradicted it.
    // Ruling 701: a queued run's step, when it has one, is what it waits for
    // in place of a slot (the summary of its session's last run).
    return `queued: ${cur.step ?? "waiting for a runtime slot"}; output appears once it starts`;
  }
  if (cur.lifecycle === "interrupted") return interruptedFooter(cur);
  if (cur.state === "done") return finishedFooter(cur, hydrated);
  if (cur.state === "error") return failedFooter(cur, offer);
  return "thread alive, no run executing";
}

/** Pass 35 U35-7: a restart is a reason, not a person. Boot recovery
 *  re-invokes the operator for a task run it interrupted (a controller turn
 *  gets a note on its conversation instead), so the footer says what already
 *  happened rather than "resumable". */
function interruptedFooter(cur: RunView): string {
  if (cur.interruptedBy) {
    // Ruling 350: the row knows WHO stopped it and whether a session
    // existed — not whether the task still takes a run. Both live
    // person-interrupts on this instance were closure interrupts
    // (ruling 177 refuses every re-run on a closed task) and the
    // footer promised "resumable" on each; ruling 207(g)'s note
    // already says "there is no thread to resume" when no session
    // was reported, and the footer said the opposite beside it.
    return cur.sid
      ? `interrupted by ${cur.interruptedBy.label.split(" ")[0]}; the thread can be resumed where the task still takes a run`
      : `interrupted by ${cur.interruptedBy.label.split(" ")[0]} before a session existed, so there is no thread to resume`;
  }
  if (cur.interruptedReason !== "restart") return "interrupted; the thread stays resumable";
  if (cur.kind === "controller") return "interrupted by a restart; the conversation carries a note";
  // Ruling 338: this said "the operator was re-invoked", and the
  // panel holds no fact about whether one was. Recovery stamps
  // the identical row state on a re-invoked orphan and on one
  // its crash-loop guard REFUSED to re-invoke
  // (`RECOVERY_REINVOKE_CAP`, 3 in 30 minutes), and records the
  // refusal only as an audit row and a note on the task.
  //
  // Live: 250 restart renderings on this board, 6 of them on
  // capped runs — SHOP-27, SHOP-34 (twice, two boots), SHOP-35,
  // SHOP-36, SHOP-38 — and on every one the task's own timeline
  // says the opposite, one panel away: "Viberr did NOT re-invoke
  // the operator for it… Run the operator from this page when
  // you are ready." A person who believes the footer does not
  // do the one thing the note asks. At the 13:01:50Z boot,
  // SHOP-34/35/38 sat two and a half hours until a human
  // commented by hand.
  //
  // This is ruling 198's defect surviving in the second surface
  // a person opens when a run stops. The panel knows the run was
  // cut by a restart and nothing more, so that is all it says —
  // and it points at the record that does know. A stronger
  // sentence would need a real `recoveryReinvoked` field
  // written on both branches, which is more than the lie is
  // worth.
  return "interrupted by a restart; the task record says what recovery did";
}

/** A run or turn that finished. */
function finishedFooter(cur: RunView, hydrated: boolean): string {
  // Ruling 148: a missing timestamp is said by leaving the clause
  // out, not by a "−" mid-sentence — "run finished at −;" read as a
  // broken template rather than as the fact. Same treatment as
  // `SessionIdChip` in runs-panels.tsx, and worse here because the glyph
  // landed inside a sentence instead of in a value slot.
  // Ruling 419(d): a controller conversation is not re-engaged,
  // it is continued, and the way to do that is the composer.
  if (cur.kind === "controller") {
    return (
      (cur.finished ? "turn finished at " + finishedClock(cur.finished, hydrated) : "turn finished") +
      "; send a message to continue the conversation"
    );
  }
  return cur.finished
    ? "run finished at " + finishedClock(cur.finished, hydrated) + "; thread can be re-engaged"
    : "run finished; thread can be re-engaged";
}

/** Ruling 130(a): the SENTENCE follows the classified failure for every run
 *  kind; the retry clause follows the OFFER. */
function failedFooter(cur: RunView, offer: RetryOffer): string {
  const provider = cur.backend === "codex" ? "Codex" : "Claude";
  const { retryClause } = offer;
  switch (cur.failureKind) {
    case "quota":
      return `${provider} refused this run: the account's usage window is spent (the error line names the reset and the account remedy)${retryClause}`;
    case "auth":
      return `${provider} refused this run: the account was rejected by the provider (an organization restriction or a rejected credential; the error line names the remedy)${retryClause}`;
    case "overloaded":
      // The provider's side, not the account's: the sentence
      // must not send the reader to a quota or account remedy.
      // U35-11: unless the request never reached the provider,
      // which is this deployment's network path, not its side.
      return cur.failureOrigin === "local"
        ? `${provider} could not be reached from this deployment: the connection failed before the provider answered; nothing about the account is wrong, check the network path and retry in a few minutes${retryClause}`
        : `${provider} could not serve this run: the provider was overloaded or failed on its side; nothing about the account is wrong, retry in a few minutes${retryClause}`;
    case "max_budget":
      // Ruling 175 / ruling 350: the pill above already says "cut off ·
      // spending cap"; the footer said "continuity error" beneath it.
      return "cut off by the instance's spending cap (Instance settings → Max spend per Claude run): not a task failure; continue the run or raise the cap";
    case "max_turns":
      return "cut off at the run's turn cap: not a task failure; continue the run";
    case "idle_timeout":
      return "stopped after producing nothing for the whole idle window: the run hung, it did not fail; re-run it";
    case "tool_loop":
      // Ruling 598: the error line names the call and its answer.
      return "stopped for sending one tool call and getting the same answer again and again (the error line names both): redirect it with what the tool said";
    case "session_missing":
      return "the provider session this run tried to resume no longer exists; a fresh run re-anchored on the task record is the recovery";
  }
  if (offer.backendUnavailable) {
    // Ruling 127: the same `run·unavailable` classification now
    // also covers "the account this run bills has not connected
    // the backend", so the footer states the CLASS and lets the
    // run's own error line (which names the person and the
    // remedy) carry the specifics, instead of asserting a quota
    // failure that may not have happened.
    // The retry clause follows the OFFER, not the viewer's
    // grant: with nobody to bill on the other backend there is
    // no retry to advertise, and the run's own error line
    // carries the real remedy (own the task, connect the
    // account).
    return `${provider} could not run this (quota, rate limit, or an account that cannot run it)${retryClause}`;
  }
  // Ruling 350: only a specialist's failure raises the packet the
  // old sentence pointed at; an operator drive or a controller
  // turn is sent to the record it does have.
  return cur.kind === "primary" || cur.kind === "reviewer"
    ? "stream ended on a continuity error; see the blocked packet"
    : "stream ended on a continuity error; the error line above carries what the provider said";
}

// ------------------------------------------------------- the console box

/** Ruling 457 (owner decision 2): what the console says while a thread the
 *  page did not carry lines for fills itself with one request, or once that
 *  request failed; null once the thread is in. */
export function historyNotice(thread: ThreadView | null): { ev: "meta" | "err"; text: string | null } | null {
  if (thread === null || thread.status === "unloaded" || thread.status === "loading") {
    return { ev: "meta", text: "loading this console…" };
  }
  return thread.status === "failed" ? { ev: "err", text: thread.loadError } : null;
}

/** P13-D-11: the note beside "load older lines": how many lines are withheld,
 *  or why the last page failed. */
export function olderNote(older: OlderLogState): string {
  return older.error
    ? " · " + older.error
    : ` · ${older.withheld} earlier line${older.withheld === 1 ? "" : "s"} not loaded`;
}

// ---------------------------------------------------------- console rows

/**
 * P19-RC1: the three shapes the projection already distinguishes and the
 * console used to flatten, read off a line only when `raw` is off — under it
 * the stored envelope prints verbatim, unchanged, and none of these is
 * computed.
 */
export interface LineParts {
  chip: ToolChip | null;
  /** Ruling 499: an edit drawn as its diff. */
  diff: EditDiff | null;
  /** Ruling 499: a to-do list drawn as its steps. */
  todos: TodoSnapshot | null;
  /** The file a call read, when no diff names it. */
  path: string | null;
  /** Ruling 366(d): what the one-line summary cut, if anything worth a click. */
  hidden: HiddenArguments | null;
  /** Ruling 366(d): Bash's description, for the row itself. */
  note: string | null;
  files: FileChangeChip[] | null;
  code: ConsoleCodeBlock | null;
  /** The row's own words, or null when the block below IS the text. */
  text: string | null;
  /** The row draws a block below its words: a diff, a to-do list, the files
   *  it changed or its output. */
  blocks: boolean;
  /** The cut arguments, while their disclosure is open. */
  args: { input: NonNullable<LogLine["input"]>; keys: readonly string[] } | null;
}

export function lineParts(display: LogLine, open: boolean): LineParts {
  const chip = toolChip(display);
  // Ruling 499: an edit drawn as its diff, a to-do list as its steps. What
  // they draw in full is no longer cut from the row.
  const diff = editDiff(display);
  const todos = consoleTodos(display);
  const path = diff ? null : filePathOf(display);
  // Ruling 366(d): what the one-line summary cut, if anything worth a click,
  // and Bash's description for the row itself.
  const hidden = hiddenArguments(display, diff?.drawn ?? todos?.drawn ?? []);
  const note = commandNote(display);
  const files = fileChangeChips(display);
  const code = consoleCodeBlock(display);
  // N20-18: a Codex final message is the raw outcome-envelope JSON; fold it to
  // the prose it wraps so it reads like Claude's `assistant`.
  const prose = agentMessageProse(display);
  return {
    chip,
    diff,
    todos,
    path,
    hidden,
    note,
    files,
    code,
    // When the text IS the block below, printing it here too would render the
    // whole dump twice; a to-do list's count is the card's own header.
    text: code || todos ? null : (prose ?? display.text),
    blocks: Boolean(diff || todos || files || code),
    args: hidden !== null && open && display.input ? { input: display.input, keys: hidden.keys } : null,
  };
}

/** A wait row's figures, read off the last heartbeat it folded (ruling 366(e)). */
export interface WaitFacts {
  last: LogLine;
  who: ToolIdentity;
  /** The provider's last figure, when it came with its instant: the count runs
   *  on from it. With no instant or no figure there is nothing honest to count
   *  from, and the row prints the static words. */
  from: number | null;
  /** The heartbeat's own instant. */
  at: string | null;
}

export function waitFacts(lines: readonly StreamedLine[]): WaitFacts {
  const last = lines[lines.length - 1]!.display;
  const reported = last.progress?.elapsed ?? null;
  const at = last.progress?.at ?? null;
  return { last, who: toolIdentity(last.name ?? ""), from: at !== null ? reported : null, at };
}
