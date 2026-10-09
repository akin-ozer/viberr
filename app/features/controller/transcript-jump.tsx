import type { TranscriptJump } from "./transcript-follow";
import { Icon } from "~/ui/icon";

/**
 * Ruling 320: the transcript's way back to its newest message, the last thing
 * in the box it scrolls (the page's transcript and the dock's), pinned to that
 * box's foot while the reader is above the newest message (app.css
 * `.ctl-jump`).
 *
 * Ruling 320 leaves a reader who has scrolled up to history where they are
 * when a reply lands, and nothing on screen said one had: the words went to a
 * screen reader only (ruling 320). The jump says "New reply" then, on the
 * accent face, and takes the reader to its first line; otherwise "Latest"
 * takes them where opening the thread would. A thread measured 12,625px long
 * on a phone, and scrolling was the only way back.
 *
 * The jump leaves as its place comes into view, so the focus it held goes to
 * the message it showed rather than to nothing.
 */
export function TranscriptJumpButton({ jump }: { jump: TranscriptJump | null }) {
  if (!jump) return null;
  const reply = jump.kind === "reply";
  return (
    <div className="ctl-jump">
      <button
        type="button"
        className={reply ? "btn sm primary" : "btn sm"}
        onClick={(event) => {
          const hadFocus = event.currentTarget === document.activeElement;
          const shown = jump.go();
          if (hadFocus && shown) {
            shown.tabIndex = -1;
            shown.focus({ preventScroll: true });
          }
        }}
      >
        <Icon name="arrow" className="r90" />
        {reply ? "New reply" : "Latest"}
      </button>
    </div>
  );
}
