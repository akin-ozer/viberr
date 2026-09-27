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
 *
 * Ruling 527: a user message that steered a turn (`steeredInto`) sits in that
 * turn too, under the message the turn answered and above its reply, which
 * was written after the turn read it. So does one still waiting to steer the
 * live turn (`turn.steering`), so it does not move when the turn reads it.
 */
export interface ThreadMessage {
  id: string;
  seq: number;
  author: "user" | "controller";
  replyTo: string | null;
  steeredInto: string | null;
}

/** Ruling 527: the live turn's side of the order: the message it answers and
 *  the messages waiting to steer it. */
export interface LiveSteering {
  answering: string | null;
  steering: readonly string[];
}

export function inReplyOrder<M extends ThreadMessage>(
  messages: readonly M[],
  live: LiveSteering | null = null,
): M[] {
  const bySeq = [...messages].sort((a, b) => a.seq - b.seq);
  const asked = new Set(bySeq.filter((m) => m.author === "user").map((m) => m.id));
  const steered = new Map<string, M[]>();
  const replies = new Map<string, M[]>();
  const anchors: M[] = [];
  for (const m of bySeq) {
    const into = m.author === "controller" ? m.replyTo : steeredInto(m, live);
    if (into && asked.has(into)) {
      const group = m.author === "controller" ? replies : steered;
      const list = group.get(into);
      if (list) list.push(m);
      else group.set(into, [m]);
    } else {
      anchors.push(m);
    }
  }
  const out: M[] = [];
  for (const m of anchors) {
    out.push(m);
    if (m.author === "user") out.push(...(steered.get(m.id) ?? []), ...(replies.get(m.id) ?? []));
  }
  return out;
}

/** Ruling 527: the turn a user message steered, or is waiting to steer. */
function steeredInto(m: ThreadMessage, live: LiveSteering | null): string | null {
  if (m.steeredInto) return m.steeredInto;
  return live?.answering && live.steering.includes(m.id) ? live.answering : null;
}

/**
 * Ruling 465: where "is working…" goes in a reply-ordered transcript — after
 * the message the live turn answers and any reply already posted to it (an
 * answer is posted before the turn's compaction ends, U39-30). Null when that
 * message is not in the list, and the row then goes at the end. Ruling 527:
 * after the messages that steered the turn or wait to, too.
 */
export function workingRowAfter(
  ordered: readonly ThreadMessage[],
  live: LiveSteering,
): string | null {
  const answering = live.answering;
  if (!answering) return null;
  const at = ordered.findIndex((m) => m.id === answering);
  if (at < 0) return null;
  let last = at;
  while (last + 1 < ordered.length) {
    const m = ordered[last + 1]!;
    const into = m.author === "controller" ? m.replyTo : steeredInto(m, live);
    if (into !== answering) break;
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
