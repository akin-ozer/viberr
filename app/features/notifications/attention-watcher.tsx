import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { useCsrfToken } from "~/ui/csrf-input";
import { onLiveFrame } from "~/features/live-updates/use-live-updates";
import {
  ATTENTION_URL,
  attentionSchema,
  desktopAlertState,
  showDesktopAlert,
  takeUnhandled,
  titleWithCount,
  type AttentionItem,
} from "./desktop-alerts";

/**
 * Ruling 481(c) (F40-51): a decision that only the owner can take reached him
 * only if a Viberr tab was in front of him. A notification was a row and an
 * SSE event, and the one signal outside the page was the bell's badge, inside
 * the page. On pass 40 a goal chain of five links sat behind WEB-3's
 * owner-only packet, and what reached the owner was a driver's chat message.
 *
 * Mounted once by `root.tsx` for a signed-in tab. It keeps two things:
 *
 * - the tab's TITLE carries the count of unread decisions (an operator
 *   packet, an agent's question, a recommendation to approve), so a tab in
 *   the strip says "(1) WEB-3 · … · Viberr" without being opened;
 * - when the person switched Desktop notifications on for this browser
 *   (Profile), a new decision shows a system notification while no Viberr
 *   tab has their attention. Clicking it marks the row read and opens where
 *   the bell would.
 *
 * It reads `/resources/attention`: on mount, when this tab's live stream
 * hands it a `notification.created` or `notification.read`, when the tab
 * gains or loses attention, and every `ATTENTION_POLL_MS` while it has not
 * got it. A hidden tab holds no stream (ruling 301), so that last short read
 * is the only way a background tab hears; it never holds a connection.
 */

/** A hidden or unfocused tab reads the snapshot this often. */
const ATTENTION_POLL_MS = 60_000;

/** The person is looking at this tab: it is visible and its window has focus. */
function attended(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Keeps `document.title` prefixed with `count` while the page's own title
 * (React Router's `<Meta>` renders it) changes underneath. The prefix is
 * re-applied whenever `<head>` changes, and taken off when the count drops
 * to zero or the watcher unmounts, so the page's title is never lost.
 */
function useCountedTitle(count: number): void {
  useEffect(() => {
    if (count <= 0) return;
    let written: { base: string; full: string } | null = null;
    const apply = () => {
      const now = document.title;
      // Our own write reads back unchanged; anything else is the page's.
      const base = written && now === written.full ? written.base : now;
      const full = titleWithCount(base, count);
      written = { base, full };
      if (now !== full) document.title = full;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (written && document.title === written.full) document.title = written.base;
    };
  }, [count]);
}

export function AttentionWatcher() {
  const [waiting, setWaiting] = useState(0);
  useCountedTitle(waiting);

  // A click on a desktop notification does what a click on the bell's row
  // does (`top-bell.tsx`): mark it read, then open it. Read through a ref: the
  // notification outlives the render that showed it.
  const navigate = useNavigate();
  const csrf = useCsrfToken();
  const read = useFetcher();
  const latest = useRef({ navigate, csrf, submit: read.submit });
  useEffect(() => {
    latest.current = { navigate, csrf, submit: read.submit };
  });

  useEffect(() => {
    let stopped = false;
    let primed = false;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const open = (item: AttentionItem) => {
      const { navigate: go, csrf: token, submit } = latest.current;
      const form = new FormData();
      form.set("_csrf", token);
      form.set("intent", "read");
      form.append("id", item.id);
      void submit(form, { method: "post", action: "/notifications/read" });
      if (item.href) void go(item.href);
    };

    const refresh = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const response = await fetch(ATTENTION_URL, { headers: { Accept: "application/json" } });
        if (!response.ok || stopped) return;
        const snapshot = attentionSchema.safeParse(await response.json());
        if (!snapshot.success || stopped) return;
        setWaiting(snapshot.data.waiting);
        // Every tab records what it saw, attended or not, so a row the
        // person already met on screen is never announced by another tab.
        const fresh = takeUnhandled(snapshot.data.items, !primed);
        primed = true;
        if (fresh.length > 0 && !attended() && desktopAlertState() === "on") {
          // Oldest first, so the newest ends on top of the stack.
          for (const item of fresh.toReversed()) showDesktopAlert(item, () => open(item));
        }
      } catch {
        // A failed read changes nothing; the next trigger reads again.
      } finally {
        running = false;
        if (again && !stopped) {
          again = false;
          void refresh();
        }
      }
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (stopped || attended()) return;
      timer = setTimeout(() => {
        timer = null;
        void refresh();
        schedule();
      }, ATTENTION_POLL_MS);
    };
    const onAttention = () => {
      void refresh();
      schedule();
    };

    void refresh();
    schedule();
    const offCreated = onLiveFrame("notification.created", () => void refresh());
    const offRead = onLiveFrame("notification.read", () => void refresh());
    window.addEventListener("focus", onAttention);
    window.addEventListener("blur", schedule);
    document.addEventListener("visibilitychange", onAttention);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      offCreated();
      offRead();
      window.removeEventListener("focus", onAttention);
      window.removeEventListener("blur", schedule);
      document.removeEventListener("visibilitychange", onAttention);
    };
  }, []);

  return null;
}
