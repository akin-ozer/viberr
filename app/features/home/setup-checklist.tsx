import type { ReactNode } from "react";
import { Link } from "react-router";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { Icon } from "~/ui/icon";
import type { HomeSetupStep } from "./home-query.server";

/**
 * Ruling 532: Home's setup checklist. A numbered row per step, the steps the
 * viewer still owes open and the rest checked, until every one is done and the
 * card leaves Home (the loader sends null). The first step the viewer can take
 * leads: its sentence shows and its action is the primary one. Every other
 * open step keeps its own action in reach, so the order is advice, not a gate;
 * the one step that cannot start, a project with no GitHub connection to take
 * a repository from, says what it waits on instead.
 *
 * Each action opens the place the thing is done: GitHub and the new account in
 * Instance settings with their dialog already open, Claude or Codex on the
 * person's own Agent accounts (ruling 127: the only place either is connected),
 * and the first project in Home's own dialog.
 *
 * Ruling 614: the close in the head hides the card for the rest of the
 * session, and it is back with the next one while a step is still open. It
 * comes with the first project: on a Home with no project the card is the
 * page's only way to start one, and the loader keeps it there.
 */

interface StepView {
  title: string;
  /** Why the step matters, shown while it leads. */
  sentence: string;
  /** What a closed step shows on its right; null for nothing. */
  fact: string | null;
  action: ReactNode;
}

export function SetupChecklist({
  steps,
  onNewProject,
  onClose,
}: {
  steps: HomeSetupStep[];
  onNewProject: () => void;
  onClose: () => void;
}) {
  const done = steps.filter((step) => step.state === "done").length;
  const lead = steps.findIndex(
    (step) => step.state !== "done" && step.state !== "blocked",
  );
  const withGithub = steps.some((step) => step.id === "github");
  const closable = steps.some(
    (step) => step.id === "project" && step.state === "done",
  );
  return (
    <section
      className="setup"
      aria-labelledby="setup-title"
      data-screen-label="Setup"
    >
      <div className="setup-head">
        <h2 id="setup-title">Finish setting up</h2>
        <span className="setup-count">
          {done} of {steps.length}
          <span className="vh"> done</span>
        </span>
        <span className="setup-meter" aria-hidden="true">
          {steps.map((step, index) => (
            <span key={step.id} className={index < done ? "on" : undefined} />
          ))}
        </span>
        {closable && (
          <button
            type="button"
            className="icon-btn modal-close"
            aria-label="Hide for this session"
            title="Hide for this session"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      <ol className="setup-steps">
        {steps.map((step, index) => {
          const leads = index === lead;
          const view = stepView(step, { leads, withGithub, onNewProject });
          const state =
            step.state === "done" ? "done" : leads ? "lead" : "open";
          return (
            <li key={step.id} className="setup-step" data-state={state}>
              <span className="setup-mark" aria-hidden="true">
                {step.state === "done" ? <Icon name="check" /> : index + 1}
              </span>
              <span className="setup-text">
                <span className="setup-title">
                  {step.state === "done" && <span className="vh">Done: </span>}
                  {view.title}
                </span>
                {leads && <span className="setup-sentence">{view.sentence}</span>}
              </span>
              {step.state === "done" ? (
                view.fact && <span className="setup-fact">{view.fact}</span>
              ) : (
                view.action
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function stepView(
  step: HomeSetupStep,
  {
    leads,
    withGithub,
    onNewProject,
  }: { leads: boolean; withGithub: boolean; onNewProject: () => void },
): StepView {
  const btn = leads ? "btn sm primary" : "btn sm";
  switch (step.id) {
    case "github":
      return {
        title: "GitHub",
        sentence:
          step.state === "failed"
            ? `${step.owner}'s token failed its last check, so agents can't push.`
            : "Agents push branches and open pull requests through a GitHub token.",
        fact:
          step.state === "done"
            ? step.owner + (step.more > 0 ? ` +${step.more}` : "")
            : null,
        action:
          step.state === "failed" ? (
            <Link
              className={btn}
              to={`/org/settings?tab=connections&update=${encodeURIComponent(step.connectionId)}`}
            >
              Update token
            </Link>
          ) : (
            <Link className={btn} to="/org/settings?tab=connections&add=1">
              Connect GitHub
            </Link>
          ),
      };
    case "account":
      return {
        title: "Your own account",
        sentence:
          "You're signed in as the default admin. Create your own account and use it from now on.",
        fact: null,
        action: (
          <Link className={btn} to="/org/settings?tab=users&add=admin">
            Create account
          </Link>
        ),
      };
    case "agents":
      return {
        title: "Claude or Codex",
        sentence:
          step.state === "stale"
            ? `Your ${BACKEND_LABEL[step.backend]} sign-in is gone from this server.`
            : "Agents on the tasks you own run on your own account.",
        fact:
          step.state === "done"
            ? step.backends.map((backend) => BACKEND_LABEL[backend]).join(", ")
            : null,
        action: (
          // `AGENT_ACCOUNTS_ANCHOR` (shared/page-anchors.ts), spelled here as
          // ruling 457 lets a closure with no room spell a label: importing it
          // put that module on Home as a chunk of its own and split the one
          // the task page and the controller share. The Home and Profile
          // tests hold the two ends to one spelling.
          <Link className={btn} to="/profile#agent-accounts">
            {step.state === "stale" ? "Sign in again" : "Connect"}
          </Link>
        ),
      };
    case "project":
      return {
        title: "First project",
        sentence: "A board, its repository, and what agents may do on their own.",
        fact: null,
        action:
          step.state === "blocked" ? (
            <span className="setup-wait">
              {withGithub ? "After GitHub" : "Waits on an admin to connect GitHub"}
            </span>
          ) : (
            <button type="button" className={btn} onClick={onNewProject}>
              New project
            </button>
          ),
      };
  }
}
