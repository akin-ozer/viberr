/**
 * U39-24: the zone a person reads times in, for the one reader that writes
 * times as prose, the controller.
 *
 * Every rendered time on the page is the viewer's local clock (`format.ts`).
 * Every instant a tool hands the controller is a UTC ISO string. So it wrote
 * "The move went through as yours at 00:57:02" in a bubble the page stamped
 * 03:57, to a person three hours east of UTC. The browser knows the zone and
 * posts it with the message; the server states it in the turn's context.
 *
 * Pure and client-safe: the composers read the zone here, and the server
 * validates what they posted here.
 */

/** Longest IANA zone name accepted from a form. The longest real one is 30. */
const TIME_ZONE_MAX_CHARS = 64;

/** The viewer's IANA zone as the browser resolves it, or "" when it cannot say. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/**
 * A zone this runtime knows, in its canonical spelling, or null.
 *
 * A browser posted it, so it is untrusted: anything `Intl` refuses, or
 * anything too long to be a zone name, is dropped rather than quoted into a
 * prompt.
 */
export function normalizeTimeZone(raw: string | null | undefined): string | null {
  const zone = raw?.trim() ?? "";
  if (!zone || zone.length > TIME_ZONE_MAX_CHARS) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** "GMT+03:00": the zone's offset at that instant. */
export function zoneOffsetLabel(zone: string, at: Date): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? zone;
}

/** "04:40": the 24-hour clock in that zone, the form the page prints. */
export function zoneClock(zone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}
