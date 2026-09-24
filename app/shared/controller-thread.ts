/**
 * Ruling 465 (F40-8): a controller transcript in REPLY order.
 *
 * A user message takes its `seq` when it is recorded, which for a message sent
 * while a turn works is when it is QUEUED. In `seq` order the transcript read
 * part 1, part 2, part 3, reply, correction, reply, reply, with nothing tying
 * a reply to the message it answered. In reply order each controller row that
 * names the message it answers (`replyTo`) sits directly under that message,
 * in the order it was written; user messages and unlinked notes keep their
 * `seq` order. A reply whose message is not in the list (a digest's window cut
 * it off) keeps its own place.
 *
 * One home for the rule: the controller page, the dock and the turn prompt's
 * digest all read the conversation through it.
 */
export interface ThreadMessage {
  id: string;
  seq: number;
  author: "user" | "controller";
  replyTo: string | null;
}

export function inReplyOrder<M extends ThreadMessage>(messages: readonly M[]): M[] {
  const bySeq = [...messages].sort((a, b) => a.seq - b.seq);
  const asked = new Set(bySeq.filter((m) => m.author === "user").map((m) => m.id));
  const replies = new Map<string, M[]>();
  const anchors: M[] = [];
  for (const m of bySeq) {
    if (m.author === "controller" && m.replyTo && asked.has(m.replyTo)) {
      const list = replies.get(m.replyTo);
      if (list) list.push(m);
      else replies.set(m.replyTo, [m]);
    } else {
      anchors.push(m);
    }
  }
  const out: M[] = [];
  for (const m of anchors) {
    out.push(m);
    if (m.author === "user") out.push(...(replies.get(m.id) ?? []));
  }
  return out;
}

/**
 * Ruling 465: where "is working…" goes in a reply-ordered transcript — after
 * the message the live turn answers and any reply already posted to it (an
 * answer is posted before the turn's compaction ends, U39-30). Null when that
 * message is not in the list, and the row then goes at the end.
 */
export function workingRowAfter(
  ordered: readonly ThreadMessage[],
  answering: string | null,
): string | null {
  if (!answering) return null;
  const at = ordered.findIndex((m) => m.id === answering);
  if (at < 0) return null;
  let last = at;
  while (
    last + 1 < ordered.length &&
    ordered[last + 1]!.author === "controller" &&
    ordered[last + 1]!.replyTo === answering
  ) {
    last += 1;
  }
  return ordered[last]!.id;
}

/** The ids of the user messages some controller row in the list answers. */
export function answeredMessageIds(messages: readonly ThreadMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.author === "controller" && m.replyTo) out.add(m.replyTo);
  }
  return out;
}
