import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { revealTarget, useHashTarget } from "~/ui/use-hash-target";
import {
  correctionAnchor,
  KB_CORRECTIONS_ANCHOR,
  KB_PROPOSALS_ANCHOR,
  proposalAnchor,
} from "~/shared/page-anchors";
import type {
  KbCorrectionsView,
  KbCorrectionView,
  KbProposalView,
} from "./controller-query.server";
import { CONNECT_TO_SEND } from "./not-connected";
import { useOpResultToast, type ActionResult } from "./op-result";

/**
 * Ruling 498: what the board's agents changed in the knowledge every run
 * reads, where the owner looks, with Undo.
 *
 * Rulings 378 and 483 queued every correction here as a proposal, and each
 * Promote asked the controller for a turn. The owner, 2026-09-26: "proposal
 * spam is exhausting, it should be easier to get them merged to the kb. No
 * human can approve all of these while inspecting them thoroughly." An agent's
 * correction is now written as it is made; this panel is the record a person
 * reads afterwards: what each passage was, what it is now, the evidence, the
 * task and the agent, and for an org admin an Undo that puts the passage back
 * (direct and audited, never a controller turn: an undo is the recorded edit in
 * reverse, with nothing to compose).
 *
 * The proposals agents filed before ruling 498 still stand in their documents
 * until someone closes them, so they are listed under the corrections with
 * ruling 483's Promote and Dismiss, which ask the controller in this
 * conversation, and a Promote all that asks once for the lot.
 */

/** Ruling 497's reveal, for the places this panel holds: the panel, a
 *  correction's entry, the proposals list and a proposal's entry (a proposal's
 *  notification opens `#proposal-kp-…`; a correction's timeline entry and a
 *  reply naming its id open `#correction-kc-…`). */
function isKnowledgeTarget(id: string): boolean {
  return (
    id === KB_CORRECTIONS_ANCHOR ||
    id === KB_PROPOSALS_ANCHOR ||
    id.startsWith(correctionAnchor("")) ||
    id.startsWith(proposalAnchor(""))
  );
}

/** An entry the panel no longer lists (a proposal closed since, a correction
 *  older than the newest shown) leaves its list, or the panel, in view: that
 *  is still where the link was pointing. */
function revealKnowledge(id: string): HTMLElement | null {
  const target =
    document.getElementById(id) ??
    (id.startsWith(proposalAnchor("")) ? document.getElementById(KB_PROPOSALS_ANCHOR) : null) ??
    document.getElementById(KB_CORRECTIONS_ANCHOR);
  if (target) revealTarget(target);
  return target;
}

/** The request each proposal button sends, in the words the controller acts on. */
function proposalRequest(
  action: "promote" | "dismiss",
  p: Pick<KbProposalView, "id" | "kb" | "doc">,
): string {
  return action === "promote"
    ? `Promote knowledge-base proposal ${p.id} in ${p.kb}/${p.doc}: read the document, write the correction into its settled text in place of the line it corrects, and close the proposal with resolve_kb_proposal.`
    : `Dismiss knowledge-base proposal ${p.id} in ${p.kb}/${p.doc} with resolve_kb_proposal, leaving the settled text as it is. I decided against it on the Controller page.`;
}

/** Ruling 498: the one request that clears the proposals filed before it. */
function promoteAllRequest(count: number): string {
  return (
    `Promote all ${count} open knowledge-base proposals on this board (get_project lists them in openProposals). ` +
    "For each: read its document, write the correction into its settled text in place of the line it corrects, and close it with resolve_kb_proposal. " +
    "Dismiss one the document already reflects or another proposal supersedes, and say why. Answer with one line per proposal."
  );
}

export function KnowledgePanel({
  corrections,
  proposals,
  projectSlug,
  canResolve,
  csrf,
  available,
  sending,
  onAsk,
}: {
  corrections: KbCorrectionsView;
  /** The proposals filed before ruling 498 that still stand. */
  proposals: KbProposalView[];
  projectSlug: string;
  /** Org admins: an undo, a promote and a dismiss edit an org knowledge base. */
  canResolve: boolean;
  csrf: string;
  /** The viewer's Claude is connected, so the controller can be asked. */
  available: boolean;
  /** A message to the controller is on its way. */
  sending: boolean;
  onAsk: (text: string) => void;
}) {
  const undo = useFetcher<ActionResult>();
  useOpResultToast(undo);
  const [confirmUndo, setConfirmUndo] = useState<KbCorrectionView | null>(null);
  const [reason, setReason] = useState("");
  const undoing = undo.state !== "idle" ? String(undo.formData?.get("id") ?? "") : null;
  const taskHref = (key: string) =>
    `/projects/${encodeURIComponent(projectSlug)}/tasks/${encodeURIComponent(key)}`;
  const { shown, total } = corrections;
  const targeted = useHashTarget(isKnowledgeTarget, true, revealKnowledge);
  return (
    <section
      className="panel ctl-proposals"
      id={KB_CORRECTIONS_ANCHOR}
      aria-labelledby="kb-corrections-h"
    >
      <div className="panel-head">
        <Icon name="edit" />
        <h2 id="kb-corrections-h">Knowledge base</h2>
        <span className="fine xs dim ctl-proposals-count" data-correction-count>
          {total} corrected
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="empty sm">
          No corrections yet. An agent writes one when its work proves a knowledge-base line wrong.
        </p>
      ) : (
        <ul className="ctl-proposal-list">
          {shown.map((c) => (
            <li
              key={c.id}
              id={correctionAnchor(c.id)}
              tabIndex={-1}
              className="ctl-proposal"
              data-correction={c.id}
              data-targeted={correctionAnchor(c.id) === targeted || undefined}
            >
              <div className="ctl-proposal-head">
                <Pill kind="info" sm>
                  {c.rulings ? "Ruling" : "Knowledge base"}
                </Pill>
                {c.undone && (
                  <Pill kind="neutral" sm>
                    Undone
                  </Pill>
                )}
                <span className="mono ctl-proposal-doc">
                  {c.kb}/{c.doc}
                </span>
              </div>
              {c.replaced !== null && (
                <p className="fine ctl-correction-side">
                  <span className="dim">Was </span>
                  <del>{c.replaced}</del>
                </p>
              )}
              <p className="ctl-proposal-text ctl-correction-side">
                <span className="dim fine">{c.replaced === null ? "Added " : "Now "}</span>
                {c.text}
              </p>
              <details className="fine xs ctl-correction-evidence">
                <summary>
                  <span>Evidence</span>
                  <Icon name="chevron" className="disc-chev" />
                </summary>
                <p className="ctl-proposal-evidence">{c.evidence}</p>
              </details>
              <p className="fine xs dim">
                <Link className="linkish" to={taskHref(c.taskKey)}>
                  {c.taskKey}
                </Link>
                {` · ${c.filedBy} · `}
                <LocalDayDotTime iso={c.at} />
                {" · "}
                <span className="mono">{c.id}</span>
              </p>
              <div className="ctl-proposal-acts">
                {c.undone ? (
                  <span className="fine xs dim">
                    Undone by {c.undone.by} · <LocalDayDotTime iso={c.undone.at} />
                    {c.undone.reason ? `: ${c.undone.reason}` : ""}
                  </span>
                ) : canResolve ? (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={undoing !== null}
                    aria-busy={undoing === c.id || undefined}
                    onClick={() => {
                      setReason("");
                      setConfirmUndo(c);
                    }}
                  >
                    {undoing === c.id && <Icon name="loader" className="spin" />}
                    {undoing === c.id ? "Undoing…" : "Undo"}
                  </button>
                ) : (
                  <span className="fine xs dim">An org admin can undo a correction.</span>
                )}
                {c.docHref && (
                  <Link className="linkish fine xs" to={c.docHref}>
                    Open document
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > shown.length && (
        <p className="fine xs dim ctl-proposals-note">
          The newest {shown.length} of {total}. The audit log keeps the rest for 90 days.
        </p>
      )}
      {proposals.length > 0 && (
        <LegacyProposals
          proposals={proposals}
          canResolve={canResolve}
          available={available}
          sending={sending}
          onAsk={onAsk}
          taskHref={taskHref}
          targeted={targeted}
        />
      )}
      {confirmUndo && (
        <ConfirmDialog
          screenLabel="Undo correction dialog"
          title={`Undo ${confirmUndo.id}?`}
          body={
            (confirmUndo.replaced === null
              ? `The text it added to ${confirmUndo.kb}/${confirmUndo.doc} is removed.`
              : `${confirmUndo.kb}/${confirmUndo.doc} goes back to what it said before.`) +
            " The task that made it is told, and an agent that tries to write it again is refused and shown your reason."
          }
          confirmLabel="Undo correction"
          cancelLabel="Keep it"
          busy={undoing !== null}
          onCancel={() => setConfirmUndo(null)}
          onConfirm={() => {
            const body = new FormData();
            body.set("_csrf", csrf);
            body.set("intent", "kb-correction-undo");
            body.set("id", confirmUndo.id);
            if (reason.trim()) body.set("reason", reason.trim());
            undo.submit(body, { method: "post" });
          }}
        >
          <label className="field confirm-reason">
            <span className="flabel">Why (optional; an agent that tries again is shown this)</span>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </ConfirmDialog>
      )}
    </section>
  );
}

/**
 * Ruling 483's proposals that documents still hold: each can be promoted or
 * dismissed through the controller as before, and Promote all asks once.
 */
function LegacyProposals({
  proposals,
  canResolve,
  available,
  sending,
  onAsk,
  taskHref,
  targeted,
}: {
  proposals: KbProposalView[];
  canResolve: boolean;
  available: boolean;
  sending: boolean;
  onAsk: (text: string) => void;
  taskHref: (key: string) => string;
  /** The id the URL's hash names, when the panel claims it. */
  targeted: string | null;
}) {
  const [asked, setAsked] = useState<{ id: string; action: "promote" | "dismiss" | "all" } | null>(
    null,
  );
  const [confirmDismiss, setConfirmDismiss] = useState<KbProposalView | null>(null);
  const ask = (action: "promote" | "dismiss", p: KbProposalView) => {
    setAsked({ id: p.id, action });
    onAsk(proposalRequest(action, p));
  };
  const inFlight = (action: "promote" | "dismiss" | "all", id: string) =>
    sending && asked?.id === id && asked.action === action;
  return (
    <div id={KB_PROPOSALS_ANCHOR} className="ctl-proposals" data-proposal-count={proposals.length}>
      <div className="ctl-proposal-head">
        <h3 className="fine">Open proposals ({proposals.length})</h3>
        {canResolve && proposals.length > 1 && (
          <button
            type="button"
            className="btn sm"
            disabled={!available || sending}
            title={available ? undefined : CONNECT_TO_SEND}
            aria-busy={inFlight("all", "all") || undefined}
            onClick={() => {
              setAsked({ id: "all", action: "all" });
              onAsk(promoteAllRequest(proposals.length));
            }}
          >
            {inFlight("all", "all") && <Icon name="loader" className="spin" />}
            {inFlight("all", "all") ? "Asking…" : "Promote all"}
          </button>
        )}
      </div>
      <p className="fine xs dim ctl-proposals-note">
        Filed before corrections were written straight into the document. They stay beside the
        lines they name until someone closes them.
      </p>
      <ul className="ctl-proposal-list">
        {proposals.map((p) => (
          <li
            key={p.id}
            id={proposalAnchor(p.id)}
            tabIndex={-1}
            className="ctl-proposal"
            data-proposal={p.id}
            data-targeted={proposalAnchor(p.id) === targeted || undefined}
          >
            <div className="ctl-proposal-head">
              <Pill kind="info" sm>
                {p.rulings ? "Ruling" : "Knowledge base"}
              </Pill>
              <span className="mono ctl-proposal-doc">
                {p.kb}/{p.doc}
              </span>
            </div>
            {p.line && (
              <p className="fine">
                <span className="dim">Corrects </span>
                <q>{p.line}</q>
              </p>
            )}
            <p className="ctl-proposal-text">{p.correction}</p>
            {p.evidence && (
              <p className="fine xs ctl-proposal-evidence">
                <span className="dim">Evidence: </span>
                {p.evidence}
              </p>
            )}
            <p className="fine xs dim">
              {p.taskKey ? (
                <Link className="linkish" to={taskHref(p.taskKey)}>
                  {p.taskKey}
                </Link>
              ) : (
                "A task"
              )}
              {p.filedBy ? ` · ${p.filedBy}` : ""}
              {p.filedOn ? ` · ${p.filedOn}` : ""}
              {" · "}
              <span className="mono">{p.id}</span>
            </p>
            <div className="ctl-proposal-acts">
              {canResolve ? (
                <>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!available || sending}
                    title={available ? undefined : CONNECT_TO_SEND}
                    aria-busy={inFlight("promote", p.id) || undefined}
                    onClick={() => ask("promote", p)}
                  >
                    {inFlight("promote", p.id) && <Icon name="loader" className="spin" />}
                    {inFlight("promote", p.id) ? "Asking…" : "Promote"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={!available || sending}
                    title={available ? undefined : CONNECT_TO_SEND}
                    aria-busy={inFlight("dismiss", p.id) || undefined}
                    onClick={() => setConfirmDismiss(p)}
                  >
                    {inFlight("dismiss", p.id) && <Icon name="loader" className="spin" />}
                    {inFlight("dismiss", p.id) ? "Asking…" : "Dismiss"}
                  </button>
                </>
              ) : (
                <span className="fine xs dim">An org admin promotes or dismisses proposals.</span>
              )}
              {p.docHref && (
                <Link className="linkish fine xs" to={p.docHref}>
                  Open document
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
      {canResolve && (
        <p className="fine xs dim ctl-proposals-note">
          Promote and Dismiss ask the controller here; it edits the document.
        </p>
      )}
      {confirmDismiss && (
        <ConfirmDialog
          screenLabel="Dismiss proposal dialog"
          title={`Dismiss ${confirmDismiss.id}?`}
          body={
            `The controller removes the proposal from ${confirmDismiss.kb}/${confirmDismiss.doc} and ` +
            "leaves the settled text as it is. Runs stop reading the correction; the task's timeline keeps the record of it."
          }
          confirmLabel="Dismiss proposal"
          cancelLabel="Keep it"
          busy={sending}
          onCancel={() => setConfirmDismiss(null)}
          onConfirm={() => ask("dismiss", confirmDismiss)}
        />
      )}
    </div>
  );
}
