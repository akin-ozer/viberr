import { useEffect, useId, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { TaskDecisionView } from "~/routes/task-decision";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";
import type { ReviewRowView } from "./review-helpers";

/**
 * Ruling 304: one row's decision, answered without leaving the Review queue.
 *
 * The dialog reads its task's decision when it opens (`…/decision`,
 * `readTaskDecision`, which reads what the task page reads) and draws the task
 * page's own regions from it (`TaskDecisionDialogBody`), so there is no second
 * rendering of a decision to drift: the decision card with its description,
 * observations and options (the recommended one marked), the completion packet
 * inside the decision that offers acceptance or on its own card, and, while
 * the task stands at the boundary and no option offers it, the page's Accept
 * control. Every answer posts to the task page's action through the page's own
 * hooks and the one acceptance ceremony (ruling 97), so a refusal, an audit row
 * and a toast are that action's. "Open task" is a link to the task page on
 * every state of the dialog, its failures included.
 *
 * An answered decision leaves the queue (the page revalidates after the
 * answer, and on the live event of anybody else's), and the dialog closes with
 * it; a decision that still stands, or a new one, stays drawn as the server
 * reads it now.
 */

/** What the dialog says when the decision cannot be shown: its read failed, or
 *  the body's chunk did not arrive. */
const UNREADABLE = "This decision could not be loaded. Open the task to answer it.";

type TaskPageModule = typeof import("~/features/task-detail/task-detail-page");

let bodyModule: Promise<TaskPageModule> | null = null;
let loadedBody: TaskPageModule["TaskDecisionDialogBody"] | null = null;

/** Starts (once) fetching the dialog's body: the task page's own chunk
 *  (ruling 11), which the queue's first paint does not need and the task page
 *  shares. A failed fetch is forgotten, so the next intent retries. */
function loadBody(): Promise<TaskPageModule> {
  if (!bodyModule) {
    const pending = import("~/features/task-detail/task-detail-page");
    bodyModule = pending;
    pending.then(
      (module) => {
        loadedBody = module.TaskDecisionDialogBody;
      },
      () => {
        bodyModule = null;
      },
    );
  }
  return bodyModule;
}

/** A pointer over a decision's row, or the focus on it, starts the fetch. */
export const preloadDecisionBody = () => void loadBody().catch(() => undefined);

export function ReviewDecisionDialog({
  projectSlug,
  row,
  listed,
  onClose,
}: {
  projectSlug: string;
  /** The row that opened the dialog, as it stood: the dialog's heading. */
  row: ReviewRowView;
  /** The queue still lists the row; false once its decision is answered. */
  listed: boolean;
  /** Unmounts the dialog, after its exit (ruling 287). */
  onClose: () => void;
}) {
  const { ref, close } = useDialog(onClose);
  const headingId = useId();
  const taskHref = `/projects/${projectSlug}/tasks/${row.key}`;
  const decision = useFetcher<TaskDecisionView>();
  const load = decision.load;
  useEffect(() => {
    void load(`${taskHref}/decision`);
  }, [load, taskHref]);
  useEffect(() => {
    if (!listed) close();
  }, [listed, close]);
  // The body's chunk, fetched beside the read (an intent on the row usually
  // started it already).
  const [Body, setBody] = useState(() => loadedBody);
  const [bodyFailed, setBodyFailed] = useState(false);
  useEffect(() => {
    if (Body) return;
    let live = true;
    loadBody().then(
      (module) => {
        if (live) setBody(() => module.TaskDecisionDialogBody);
      },
      () => {
        if (live) setBodyFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [Body]);
  const view = decision.data;
  return (
    <dialog
      ref={ref}
      className="modal-card modal-wide"
      aria-labelledby={headingId}
      data-screen-label="Review decision dialog"
    >
      <div className="modal-head">
        <div className="mh-main">
          <h2 id={headingId}>
            {row.key} · {row.title}
          </h2>
          <div className="mh-sub">
            {row.stageName}
            {row.packet ? ` · ${row.packet.kind}` : ""}
          </div>
        </div>
        <button type="button" className="icon-btn modal-close" onClick={close} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="modal-body">
        {view?.ok === false || bodyFailed ? (
          <p className="deny-note" role="alert">
            <Icon name="alert" />
            <span>{UNREADABLE}</span>
          </p>
        ) : view === undefined || Body === null ? (
          <p className="empty sm" role="status">
            Reading the decision…
          </p>
        ) : (
          <Body view={view} taskHref={taskHref} />
        )}
      </div>
      <div className="modal-foot">
        <span className="foot-hint">
          An answer here is the task page&apos;s own, recorded on the task.
        </span>
        <div className="foot-actions">
          <Link className="btn" to={taskHref}>
            Open task
            <Icon name="chevron" className="ico-end" />
          </Link>
        </div>
      </div>
    </dialog>
  );
}
