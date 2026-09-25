import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Ruling 476(c) and (d): how a controller transcript (the page's and the
 * dock's) meets a reply, for the eye and for a screen reader. One home, so the
 * two surfaces cannot disagree about either.
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

/**
 * Ruling 476(c) (F40-23): a reply that lands is shown from its first line.
 *
 * Both transcripts set `scrollTop = scrollHeight` whenever the message count or
 * the working flag changed. Live at 375px the newest reply was 1,017px in a
 * 452px box, so a person who had waited minutes for it met its last
 * paragraphs; under ruling 465's reply order a reply to a message with queued
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
 */
export function useTranscriptFollow(
  boxRef: RefObject<HTMLElement | null>,
  messages: readonly TranscriptMessage[],
  fresh: ReadonlySet<string>,
  working: boolean,
  openKey: string,
): void {
  const opened = useRef<string | null>(null);
  const newestReply = useRef<string | null>(null);
  const wasWorking = useRef(working);
  useEffect(() => {
    const box = boxRef.current;
    const started = working && !wasWorking.current;
    wasWorking.current = working;
    const latestReply = newest(messages.filter((m) => m.author === "controller"))?.id ?? null;
    if (!box) {
      // The next box is a new element, scrolled to its top: that is an open.
      opened.current = null;
      return;
    }
    const anchor = newestReply.current;
    newestReply.current = latestReply;
    if (opened.current !== openKey) {
      opened.current = openKey;
      const last = newest(messages);
      place(box, last?.author === "controller" ? last.id : null);
      return;
    }
    const anchorTop = anchor === null ? null : messageTop(box, anchor);
    const following = anchorTop === null || box.scrollTop + box.clientHeight > anchorTop;
    const reply = newest(messages.filter((m) => m.author === "controller" && fresh.has(m.id)));
    if (reply) {
      if (following) place(box, reply.id);
      return;
    }
    if (messages.some((m) => m.author === "user" && fresh.has(m.id))) {
      place(box, null);
      return;
    }
    if (started && following) place(box, null);
  }, [boxRef, messages, fresh, working, openKey]);
}

/** How long a reply's gist may run in the announcement. */
const GIST_MAX = 160;

/**
 * The first sentence of a reply as plain words: markdown's marks and link
 * targets dropped, code blocks skipped, cut at the first sentence end.
 */
export function replyGist(text: string): string {
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
 * Ruling 476(d) (F40-24): the sentence a screen reader hears about a turn, for
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
