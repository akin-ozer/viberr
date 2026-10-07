import { useEffect, useState } from "react";
import { useRevalidator, useSearchParams } from "react-router";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { useBusyRow } from "./resource-helpers";
import type { ResourceConfirm } from "./resources-panel-derive";
import { useOrgAction } from "./use-org-action";

/**
 * The Agent resources tab's state and posts (ruling 689(e), the split of
 * `resources-panel.tsx`): which store folder's browser is open and the
 * creates waiting to open one, the row posts (removal, re-scan, connection
 * test) with their busy rows, and the re-read while a server installs. The
 * panel calls them in the order its state and fetchers always registered, so
 * each fetcher keeps its key. No component lives here, so the module is not a
 * Fast Refresh boundary.
 */

/** The store browser: the folder it is open on, the document a
 *  knowledge-base proposal's link names, and the files-mode creates that open
 *  it once the revalidated list delivers the new row. */
export function useResourceBrowsing(kbs: KbView[], skills: SkillView[]) {
  // Ruling 483: `?kb=<dir>&doc=<path>` arrives from a knowledge-base proposal's
  // "Open document" and opens that base's browser on that document.
  const [searchParams] = useSearchParams();
  const linkedKb = kbs.find((k) => k.dir === searchParams.get("kb")) ?? null;
  const [browsing, setBrowsing] = useState<{ kind: "kb" | "skill"; id: string } | null>(
    () => (linkedKb ? { kind: "kb", id: linkedKb.id } : null),
  );
  const linkedDoc =
    linkedKb && browsing?.kind === "kb" && browsing.id === linkedKb.id
      ? (searchParams.get("doc") ?? undefined)
      : undefined;
  // A files-mode skill create hands straight off to the store browser: the
  // action only returns a toast, so we wait for the revalidated skills list
  // to deliver the new row and open its browser then.
  const [pendingSkillBrowse, setPendingSkillBrowse] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingSkillBrowse) return;
    const hit = skills.find((s) => s.name === pendingSkillBrowse);
    if (hit) {
      setBrowsing({ kind: "skill", id: hit.id });
      setPendingSkillBrowse(null);
    }
  }, [skills, pendingSkillBrowse]);
  // The KB twin (owner request 2026-08-20): a files-mode KB create waits for
  // the revalidated list, then opens the new folder's browser. Matched on the
  // store DIR — the modal's slugified name — not the display name.
  const [pendingKbBrowse, setPendingKbBrowse] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingKbBrowse) return;
    const hit = kbs.find((k) => k.dir === pendingKbBrowse);
    if (hit) {
      setBrowsing({ kind: "kb", id: hit.id });
      setPendingKbBrowse(null);
    }
  }, [kbs, pendingKbBrowse]);
  const browsingKb = browsing?.kind === "kb" ? (kbs.find((k) => k.id === browsing.id) ?? null) : null;
  const browsingSkill =
    browsing?.kind === "skill" ? (skills.find((s) => s.id === browsing.id) ?? null) : null;
  return {
    setBrowsing,
    linkedDoc,
    setPendingSkillBrowse,
    setPendingKbBrowse,
    browsingKb,
    browsingSkill,
  };
}

/** The row posts: a removal, a knowledge base's re-scan and an MCP server's
 *  connection test, the last two with the row they spin on. */
export function useResourcePosts() {
  const rowAction = useOrgAction();
  const reindexAction = useOrgAction();
  const testAction = useOrgAction();
  const [reindexing, setReindexing] = useBusyRow(reindexAction);
  const [testing, setTesting] = useBusyRow(testAction);
  return {
    reindexing,
    testing,
    reindex: (kb: KbView) => {
      setReindexing(kb.id);
      reindexAction.submit({ intent: "kb-reindex", kbId: kb.id });
    },
    test: (m: McpView) => {
      setTesting(m.id);
      testAction.submit({ intent: "mcp-test", mcpId: m.id });
    },
    remove: (confirm: ResourceConfirm) => {
      const { kind, item } = confirm;
      if (kind === "kb") rowAction.submit({ intent: "kb-delete", kbId: item.id });
      if (kind === "mcp") rowAction.submit({ intent: "mcp-delete", mcpId: item.id });
      if (kind === "skill") rowAction.submit({ intent: "skill-delete", skillId: item.id });
      if (kind === "agent") rowAction.submit({ intent: "agent-delete", profileId: item.id });
      // No setConfirm(null): the dialog plays its exit, then its onCancel
      // clears it (ruling 459).
    },
  };
}

/**
 * R19-18: while any MCP server is installing on first use, re-read the page
 * every 20s so its dot turns green (or red) by itself.
 *
 * A poll rather than an SSE event because the event vocabulary is a closed
 * typed union routed by user/project/task scope, and an org-settings row fits
 * none of them — a new name plus a new scope would be a lot of plumbing for
 * one transient state. It costs nothing when nothing is installing: the
 * effect only arms while `warming` is true, and revalidation is the app's
 * normal update mechanism (no optimistic UI).
 */
export function useWarmingRevalidation(mcps: McpView[]) {
  const warming = mcps.some((m) => m.warmingSince !== null);
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!warming) return;
    const id = setInterval(() => void revalidator.revalidate(), 20_000);
    return () => clearInterval(id);
    // `revalidator` is stable enough to omit; re-arming on every render would
    // reset the 20s window each time the page re-read itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warming]);
}
