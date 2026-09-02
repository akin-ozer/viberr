import { publishSseEvent } from "~/server/events/sse-broker.server";

export type OrgResourceKind = "kb" | "skill" | "mcp";

/**
 * F32-2 (pass 32): an org resource changed — publish the compact reference so
 * every open Settings tab revalidates. Live, a host-side file drop into a KB
 * folder re-indexed (log: docCount 1) while the Agent resources tab kept
 * "0 docs · re-scanned just now" until a manual reload; NFR4 promises
 * no-refresh propagation, and the stale stamp was actively misleading.
 *
 * Broadcast, not scoped: the resource catalog is instance-wide, and the org
 * Settings page holds a `user`-scoped stream (broadcasts reach every
 * connection). Reference-only, like every other event — the page reloads its
 * loader; nothing rides the wire but the kind and id.
 */
export function publishResourceUpdated(kind: OrgResourceKind, id: string): void {
  publishSseEvent(
    {
      type: "resource.updated",
      entityId: `${kind}:${id}`,
      occurredAt: new Date().toISOString(),
      data: { kind, id },
    },
    { broadcast: true },
  );
}
