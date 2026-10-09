import { Link } from "react-router";
import { Icon } from "~/ui/icon";
import { CONTROLLER_NOT_CONNECTED_NOTE } from "~/shared/controller-not-connected";

/**
 * Ruling 137: what a viewer whose Claude is not connected reads, on the
 * controller page's composer and on the dock's (ruling 256), so the two tell
 * one story about one refusal.
 *
 * The controller bills the ASKER, so this is never "the deployment has no
 * credential" — it is one person's account, and the remedy is theirs. The
 * words are the server's own (`CONTROLLER_NOT_CONNECTED_NOTE`, ruling 12),
 * so the disabled composer and the refusal the transcript would record say the
 * same thing.
 *
 * Its own small module (ruling 11, FL-1): root mounts the dock on every page,
 * and taking these from `controller-page.tsx` put the whole controller page,
 * its run console and their packages into every route's first download.
 */
/** Where the sentence above sends a person, linked where it is printed. */
const AGENT_ACCOUNTS_PLACE = "Profile → Agent accounts";

/** What a control that cannot send yet says in its title (the knowledge
 *  panel's actions). Ruling 319: the composers' boxes no longer repeat it;
 *  the note below is said once, beside them. */
export const CONNECT_TO_SEND = "Connect Claude to send a message.";

/**
 * U39-10 (pass 39): ruling 137's sentence where a person can read it and act
 * on it. Both composers carried it as the PLACEHOLDER of a disabled textarea:
 * placeholder grey on a disabled field, cut after two lines on a phone (the
 * dock's box is two rows), and never a link. The product's own rule for a
 * disabled control is a visible note beside it (`.deny-note`), and this is
 * that note, with the place it names linked. Shared by the page and the dock
 * (ruling 256), so the two still tell one story.
 */
export function NotConnectedNote() {
  const [before, after] = CONTROLLER_NOT_CONNECTED_NOTE.split(AGENT_ACCOUNTS_PLACE);
  return (
    <p className="deny-note ctl-unavailable" data-not-connected>
      <Icon name="alert" />
      <span>
        {before}
        <Link className="linkish" to="/profile">
          {AGENT_ACCOUNTS_PLACE}
        </Link>
        {after}
      </span>
    </p>
  );
}
