import { useState } from "react";
import { Link } from "react-router";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { revealTarget, useHashTarget } from "~/ui/use-hash-target";
import { KB_PROPOSALS_ANCHOR, proposalAnchor } from "~/shared/page-anchors";
import type { KbProposalView } from "./controller-query.server";
import { CONNECT_TO_SEND } from "./not-connected";

/**
 * Ruling 483 (F40-59): the project's open knowledge-base proposals, where the
 * owner looks, with the door that closes one.
 *
 * Live on WEB-1 the operator filed two ruling proposals, and the only place
 * they appeared was the timeline, as "Review verdict · Ruling contradicted by
 * evidence", with no link to the document and no control. They scrolled away
 * and were never promoted, and the next packet asked the owner to act on the
 * "not binding" build command.
 *
 * Promoting one edits a knowledge base's settled text, which is a person's
 * decision carried out by the controller (the pass-39 model, ruling 378): the
 * buttons SEND that request to the controller in this conversation, and the
 * controller walks `resolve_kb_proposal`. Nothing here writes the document.
 */

/** Ruling 497: a proposal's notification opens its entry here
 *  (`#proposal-kp-…`); the panel itself is `#kb-proposals`. */
function isProposalTarget(id: string): boolean {
  return id === KB_PROPOSALS_ANCHOR || id.startsWith(proposalAnchor(""));
}

/** An entry that is no longer open (promoted or dismissed since) leaves the
 *  panel, which is still where the notification was pointing. */
function revealProposal(id: string): boolean {
  const target = document.getElementById(id) ?? document.getElementById(KB_PROPOSALS_ANCHOR);
  if (!target) return false;
  revealTarget(target);
  return true;
}

/** The request each button sends, in the words the controller acts on. */
export function proposalRequest(
  action: "promote" | "dismiss",
  p: Pick<KbProposalView, "id" | "kb" | "doc">,
): string {
  return action === "promote"
    ? `Promote knowledge-base proposal ${p.id} in ${p.kb}/${p.doc}: read the document, write the correction into its settled text in place of the line it corrects, and close the proposal with resolve_kb_proposal.`
    : `Dismiss knowledge-base proposal ${p.id} in ${p.kb}/${p.doc} with resolve_kb_proposal, leaving the settled text as it is. I decided against it on the Controller page.`;
}

export function ProposalsPanel({
  proposals,
  projectSlug,
  canResolve,
  available,
  sending,
  onAsk,
}: {
  proposals: KbProposalView[];
  projectSlug: string;
  /** Org admins: promoting or dismissing edits an org knowledge base. */
  canResolve: boolean;
  /** The viewer's Claude is connected, so the controller can be asked. */
  available: boolean;
  /** A message to the controller is on its way. */
  sending: boolean;
  onAsk: (text: string) => void;
}) {
  const [asked, setAsked] = useState<{ id: string; action: "promote" | "dismiss" } | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState<KbProposalView | null>(null);
  const ask = (action: "promote" | "dismiss", p: KbProposalView) => {
    setAsked({ id: p.id, action });
    onAsk(proposalRequest(action, p));
  };
  const inFlight = (action: "promote" | "dismiss", p: KbProposalView) =>
    sending && asked?.id === p.id && asked.action === action;
  const targeted = useHashTarget(isProposalTarget, true, revealProposal);
  return (
    <section className="panel ctl-proposals" id={KB_PROPOSALS_ANCHOR} aria-labelledby="kb-proposals-h">
      <div className="panel-head">
        <Icon name="edit" />
        <h2 id="kb-proposals-h">Proposals</h2>
        <span className="fine xs dim ctl-proposals-count" data-proposal-count>
          {proposals.length} open
        </span>
      </div>
      {proposals.length === 0 ? (
        <p className="empty sm">Nothing to review.</p>
      ) : (
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
                  <Link
                    className="linkish"
                    to={`/projects/${encodeURIComponent(projectSlug)}/tasks/${encodeURIComponent(p.taskKey)}`}
                  >
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
                      aria-busy={inFlight("promote", p) || undefined}
                      onClick={() => ask("promote", p)}
                    >
                      {inFlight("promote", p) && <Icon name="loader" className="spin" />}
                      {inFlight("promote", p) ? "Asking…" : "Promote"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={!available || sending}
                      title={available ? undefined : CONNECT_TO_SEND}
                      aria-busy={inFlight("dismiss", p) || undefined}
                      onClick={() => setConfirmDismiss(p)}
                    >
                      {inFlight("dismiss", p) && <Icon name="loader" className="spin" />}
                      {inFlight("dismiss", p) ? "Asking…" : "Dismiss"}
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
      )}
      {canResolve && proposals.length > 0 && (
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
          onConfirm={() => {
            ask("dismiss", confirmDismiss);
            setConfirmDismiss(null);
          }}
        />
      )}
    </section>
  );
}
