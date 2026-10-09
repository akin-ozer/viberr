import type { GagentView } from "~/server/org/gagents.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { countLabel } from "~/shared/text/plural";

/**
 * What the Agent resources tab reads off its state before it draws (ruling
 * 13(b), the split of `resources-panel.tsx`): which editor or removal
 * confirm is open, the row an open MCP editor reads, and what a removal
 * says it takes. Pure functions, no React.
 */

export type ResourceConfirm =
  | { kind: "kb"; item: KbView }
  | { kind: "mcp"; item: McpView }
  | { kind: "skill"; item: SkillView }
  | { kind: "agent"; item: GagentView };

export type ResourceModal =
  | { kind: "kb"; item: KbView | null }
  | { kind: "mcp"; item: McpView | null }
  | { kind: "skill"; item: SkillView | null }
  | { kind: "agent"; item: GagentView | null };

/** How many grants of a kind name a resource, by its store slug. */
export type GrantCount = (key: "skills" | "mcps" | "kbs", slug: string) => number;

/** Delete-confirm tail naming the grants that are about to be dropped (P14-KM-09
 *  / A2). BOTH org TEMPLATES and PROJECT DEPLOYMENTS are rewritten by
 *  `updateResourceReferences`, so the confirm counts both — the old copy counted
 *  only templates, so a resource used ONLY by a project agent read as "nothing
 *  uses this" right before the delete silently dropped that project grant. */
function grantTail(templates: number, projects: number): string {
  if (templates === 0 && projects === 0) return " Nothing grants it.";
  const parts: string[] = [];
  if (templates > 0) parts.push(countLabel(templates, "agent template"));
  if (projects > 0) parts.push(countLabel(projects, "project agent"));
  return ` The grant is dropped from ${parts.join(" and ")}.`;
}

/** Ruling 192: the row as the page holds it NOW, so a sign-in that lands in
 *  the other tab (the callback publishes, this page revalidates) reads
 *  "signed in" in the open editor. */
export function liveMcp(item: McpView | null, mcps: McpView[]): McpView | null {
  return item ? (mcps.find((m) => m.id === item.id) ?? item) : null;
}

/** C6: name the outcome per resource kind, not a bare "Remove". */
export function removalLabel(kind: ResourceConfirm["kind"]): string {
  return kind === "kb"
    ? "Remove knowledge base"
    : kind === "mcp"
      ? "Remove MCP server"
      : kind === "skill"
        ? "Remove skill"
        : "Remove agent profile";
}

/** What a removal takes with it, and the grants it drops. */
export function removalDetail(
  confirm: ResourceConfirm,
  usedBy: GrantCount,
  projectGrantsFor: GrantCount,
): string {
  return confirm.kind === "kb"
    ? // A2: the server `rmSync`s the whole document folder, not "the
      // index" — disclose the permanent data loss and the real count.
      `Permanently deletes the folder and its ${countLabel(confirm.item.fileCount, "file")}. This cannot be undone.` +
        grantTail(
          usedBy("kbs", confirm.item.dir),
          projectGrantsFor("kbs", confirm.item.dir),
        )
    : confirm.kind === "mcp"
      ? // P14-KM-09: this said "profiles referencing this server" with
        // no idea how many there were — the last guardrail before a
        // destructive change was the only blind one of the three.
        "Its tools disappear from every run." +
        grantTail(
          usedBy("mcps", confirm.item.name),
          projectGrantsFor("mcps", confirm.item.name),
        )
      : confirm.kind === "skill"
        ? "store://skills/" + confirm.item.name + "/ is deleted." +
          grantTail(
            usedBy("skills", confirm.item.name),
            projectGrantsFor("skills", confirm.item.name),
          )
        : "The base definition is deleted. It isn't deployed anywhere.";
}
