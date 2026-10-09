import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/**
 * Ruling 320 and (d): how a controller transcript (the page's and the
 * dock's) meets a reply, for the eye and for a screen reader. One home, so the
 * two surfaces cannot disagree about either. Ruling 320: and how a reader who
 * has scrolled away gets back.
 */

/** What these rules read of a transcript row. */
export interface TranscriptMessage {
  id: string;
  seq: number;
  author: "user" | "controller";
  text: string;
}

/** Room above a reply's first line when it is brought to the top of the box. */
const READ_INSET = 8;

/** The row with the highest `seq` of `rows`, or null. */
function newest<M extends TranscriptMessage>(rows: readonly M[]): M | null {
  let out: M | null = null;
  for (const m of rows) if (!out || m.seq > out.seq) out = m;
  return out;
}

/** Where a message's first line sits inside the box's scrolled content. */
function messageTop(box: HTMLElement, id: string): number | null {
  for (const el of box.querySelectorAll<HTMLElement>("[data-message-id]")) {
    if (el.dataset.messageId !== id) continue;
    return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  }
  return null;
}

/** Puts `id`'s first line at the top of the box, or the box at its end when
 *  `id` is null (the browser clamps both). */
function place(box: HTMLElement, id: string | null): void {
  const top = id === null ? null : messageTop(box, id);
  box.scrollTop = top === null ? box.scrollHeight : Math.max(0, top - READ_INSET);
}

/** About a line: a first line that has just come into view, or an end the
 *  box is a line short of, needs no jump. */
const JUMP_EDGE = 32;

/** Whether `id`'s first line, or the box's end when `id` is null, sits below
 *  what the reader can see. */
function below(box: HTMLElement, id: string | null): boolean {
  const bottom = box.scrollTop + box.clientHeight;
  if (id === null) return box.scrollHeight - bottom > JUMP_EDGE;
  const top = messageTop(box, id);
  return top !== null && top > bottom - JUMP_EDGE;
}

/**
 * Ruling 320: the way back for a reader who has scrolled away from the newest
 * message. `reply` is a reply that landed while they read history, which
 * ruling 320 leaves where it is; `newest` is the place an open would show.
 */
export type JumpKind = "reply" | "newest";

export interface TranscriptJump {
  kind: JumpKind;
  /** Brings the place into view and returns the message it shows, for the
   *  focus to follow. */
  go: () => HTMLElement | null;
}

/**
 * Ruling 320 (F40-23): a reply that lands is shown from its first line.
 *
 * Both transcripts set `scrollTop = scrollHeight` whenever the message count or
 * the working flag changed. Live at 375px the newest reply was 1,017px in a
 * 452px box, so a person who had waited minutes for it met its last
 * paragraphs; under ruling 320's reply order a reply to a message with queued
 * messages behind it sits ABOVE them, and the scroll went about 13,000px past
 * the answer to the last queued message.
 *
 * - Opening a transcript (a thread, the dock's panel, its transcript after the
 *   thread list) shows the newest reply from its first line when a reply is
 *   the newest message, and the end otherwise.
 * - A controller message that arrives puts its first line at the top of the
 *   box, unless the reader has scrolled up above the newest reply they had,
 *   reading history: then nothing moves.
 * - The person's own message, which they just sent, goes to the end; so does
 *   a turn that starts while the reader follows the thread.
 *
 * `fresh` is `useFreshMessageIds` for the same messages; `openKey` names what
 * makes this a newly opened transcript.
 *
 * Ruling 320: the reader who has scrolled away is offered the way back, the
 * transcript's jump (`TranscriptJumpButton`), null while nothing is below
 * them. A reply the rule above left where it landed is `reply` until the
 * reader has been to it, and the jump puts its first line at the top of the
 * box; otherwise `newest` goes where an open would.
 */
export function useTranscriptFollow(
  boxRef: RefObject<HTMLElement | null>,
  messages: readonly TranscriptMessage[],
  fresh: ReadonlySet<string>,
  working: boolean,
  openKey: string,
): TranscriptJump | null {
  const opened = useRef<string | null>(null);
  const newestReply = useRef<string | null>(null);
  const wasWorking = useRef(working);
  // Ruling 320: the reply left below a reader in history, and where an open
  // puts the box (the newest message's first line when it is a reply, else
  // the end).
  const held = useRef<string | null>(null);
  const home = useRef<string | null>(null);
  const [kind, setKind] = useState<JumpKind | null>(null);
  const measure = useCallback(() => {
    const box = boxRef.current;
    // A held reply the reader has scrolled to is read.
    if (box && held.current !== null && !below(box, held.current)) held.current = null;
    const target = held.current ?? home.current;
    setKind(box && below(box, target) ? (held.current === null ? "newest" : "reply") : null);
  }, [boxRef]);
  useEffect(() => {
    const box = boxRef.current;
    const started = working && !wasWorking.current;
    wasWorking.current = working;
    const latestReply = newest(messages.filter((m) => m.author === "controller"))?.id ?? null;
    const last = newest(messages);
    home.current = last?.author === "controller" ? last.id : null;
    if (!box) {
      // Another view holds the box (the dock's thread list or unavailable
      // note). The box that comes back keeps that view's offset, not the
      // transcript's: that is an open.
      opened.current = null;
      held.current = null;
      measure();
      return;
    }
    const anchor = newestReply.current;
    newestReply.current = latestReply;
    if (opened.current !== openKey) {
      opened.current = openKey;
      held.current = null;
      place(box, home.current);
    } else {
      const anchorTop = anchor === null ? null : messageTop(box, anchor);
      const following = anchorTop === null || box.scrollTop + box.clientHeight > anchorTop;
      const reply = newest(messages.filter((m) => m.author === "controller" && fresh.has(m.id)));
      if (reply) {
        if (following) place(box, reply.id);
        held.current = following ? null : reply.id;
      } else if (messages.some((m) => m.author === "user" && fresh.has(m.id))) {
        place(box, null);
        held.current = null;
      } else if (started && following) {
        place(box, null);
      }
    }
    measure();
  }, [boxRef, messages, fresh, working, openKey, measure]);
  // Ruling 320: the reader's own scrolling brings the jump and takes it away,
  // measured once a frame. `openKey` is also what names a new box.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [boxRef, openKey, measure]);
  const go = useCallback((): HTMLElement | null => {
    const box = boxRef.current;
    if (!box) return null;
    const target = held.current ?? home.current;
    held.current = null;
    place(box, target);
    measure();
    const rows = box.querySelectorAll<HTMLElement>("[data-message-id]");
    return target === null
      ? (rows[rows.length - 1] ?? null)
      : ([...rows].find((row) => row.dataset.messageId === target) ?? null);
  }, [boxRef, measure]);
  return useMemo(() => (kind === null ? null : { kind, go }), [kind, go]);
}

/** How long a reply's gist may run in the announcement. */
const GIST_MAX = 160;

/**
 * The first sentence of a reply as plain words: markdown's marks and link
 * targets dropped, code blocks skipped, cut at the first sentence end.
 */
function replyGist(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const end = plain.search(/[.!?](?=\s|$)/);
  const first = end >= 0 ? plain.slice(0, end + 1) : plain;
  return first.length > GIST_MAX ? `${first.slice(0, GIST_MAX - 1).trimEnd()}…` : first;
}

/**
 * Ruling 320 (F40-24): the sentence a screen reader hears about a turn, for
 * a `role="status"` region that is mounted at all times and only changes its
 * text (a region inserted together with its text is the one case screen
 * readers skip, docs/ui/surfaces.md).
 *
 * The page's only status region was the working row, inserted with its
 * sentence already in it, and removed when the turn settled, while the reply
 * went into a transcript with no live region. The dock's announcer beside its
 * button drops the thread on screen, so a reply there cleared it to "".
 *
 * "<name> is working" when a turn starts (only where `working` is passed: the
 * dock's button already says it), then "<name> replied: <first sentence>" when
 * a reply lands in the transcript on screen. The text stays until the next
 * one, so nothing is announced twice or cleared under the reader.
 */
export function useTurnAnnouncement(
  name: string,
  messages: readonly TranscriptMessage[],
  fresh: ReadonlySet<string>,
  working: boolean,
): string {
  const [said, setSaid] = useState("");
  const wasWorking = useRef(working);
  useEffect(() => {
    const started = working && !wasWorking.current;
    wasWorking.current = working;
    const reply = newest(messages.filter((m) => m.author === "controller" && fresh.has(m.id)));
    if (reply) setSaid(`${name} replied: ${replyGist(reply.text)}`);
    else if (started) setSaid(`${name} is working`);
  }, [name, messages, fresh, working]);
  return said;
}
