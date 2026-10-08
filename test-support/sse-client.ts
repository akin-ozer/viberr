import { connectSseClient, type SseScope } from "~/server/events/sse-broker.server";

/** A watcher on the real SSE broker, as an open tab's stream holds it: what
 *  the broker wrote it, and the event names and `data:` payloads in order. */
export function recordSse(userId: string, scopes: SseScope[] = [{ kind: "user" }]) {
  const writes: string[] = [];
  const handle = connectSseClient({
    userId,
    scopes,
    lastEventId: null,
    write: (chunk) => {
      writes.push(chunk);
    },
  });
  const field = (prefix: string) =>
    writes
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length));
  return {
    writes,
    wire: () => writes.join(""),
    names: () => field("event: "),
    data: () => field("data: "),
    close: () => handle.close(),
  };
}
