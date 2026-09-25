import { useEffect, useState } from "react";
import { useRevalidator, useSearchParams } from "react-router";
import { StoreBrowser } from "~/features/kb-browser/store-browser";
import type { GagentView } from "~/server/org/gagents.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { countLabel } from "~/shared/text/plural";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { ConfirmDelete } from "./confirm-delete";
import { useOrgAction } from "./use-org-action";
import { useBusyRow, rel, updatedLabel } from "./resource-helpers";
import { KBModal, McpModal, SkillModal } from "./resource-modals";
import { AgentModal } from "./agent-template-modal";
import { AgentPanel, KbPanel, McpPanel, SkillPanel } from "./resource-rows";

/**
 * Agent resources tab (org-settings spec §4.3/§4.4): four CRUD panels —
 * knowledge bases, MCP servers, skills, global agent profiles (the org
 * TEMPLATE layer 9A's project roster consumes) — plus the StoreBrowser
 * popup over the real store folders. Honest deltas: re-index re-scans the
 * real folder (doc counts are real), MCP "test" is a real reachability
 * probe (tool counts are never fabricated), timestamps render relative
 * from ISO. The skill-delete confirm uses the folder form of the copy
 * (spec §8.6 recommendation).
 *
 * Pass 16 split this file (1471 lines) along its existing seams — a pure
 * structural refactor, no behaviour or copy change. What stayed here is the
 * orchestration: which modal/confirm is open, which row is busy, and the
 * governed submissions. The pieces live in `resource-helpers.ts`,
 * `resource-modals.tsx`, `agent-template-modal.tsx` and `resource-rows.tsx`.
 */

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

// ------------------------------------------------------------------ panel

type ResourceConfirm =
  | { kind: "kb"; item: KbView }
  | { kind: "mcp"; item: McpView }
  | { kind: "skill"; item: SkillView }
  | { kind: "agent"; item: GagentView };

type ResourceModal =
  | { kind: "kb"; item: KbView | null }
  | { kind: "mcp"; item: McpView | null }
  | { kind: "skill"; item: SkillView | null }
  | { kind: "agent"; item: GagentView | null };


export function ResourcesPanel({
  kbs,
  mcps,
  skills,
  gagents,
  // The loader always provides this (A2); it is optional here only so component
  // tests that render the panel directly need not build the map — an absent map
  // means "no project grants counted", i.e. the delete tail counts templates only.
  projectGrants = { kbs: {}, mcps: {}, skills: {} },
  templateGrants = { kbs: {}, mcps: {}, skills: {} },
  stages,
}: {
  kbs: KbView[];
  mcps: McpView[];
  skills: SkillView[];
  gagents: GagentView[];
  projectGrants?: {
    kbs: Record<string, number>;
    mcps: Record<string, number>;
    skills: Record<string, number>;
  };
  /** How many ORG TEMPLATES grant each resource, counted server-side over the
   *  profile FILES. Same optionality rule as `projectGrants` above. */
  templateGrants?: {
    kbs: Record<string, number>;
    mcps: Record<string, number>;
    skills: Record<string, number>;
  };
  stages: StageDef[];
}) {
  const [modal, setModal] = useState<ResourceModal | null>(null);
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
  const [confirm, setConfirm] = useState<ResourceConfirm | null>(null);
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
  const push = useToast();
  const rowAction = useOrgAction();
  const reindexAction = useOrgAction();
  const testAction = useOrgAction();
  const [reindexing, setReindexing] = useBusyRow(reindexAction);
  const [testing, setTesting] = useBusyRow(testAction);

  /**
   * How many GLOBAL TEMPLATES reference this resource.
   *
   * P13-KM-08: this compared against the row `id` (a `kb_…`/`sk_…` value that
   * never appears in a grant) and the display `name`, but a grant stores the
   * store SLUG — so the KB count was structurally always 0 while the skill
   * count only worked because a skill's name IS its folder. Callers now pass
   * the slug. The label says "templates" because project deployments carry
   * their own copies and are not counted here.
   */
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

  // Counted server-side over the profile FILES, not from `gagents`: that list
  // is the specialist CRUD list and excludes the controller and operator
  // templates, while the delete rewrites EVERY profile file. Deriving it here
  // told an admin "Nothing grants it" about the three resources the shipped
  // store attaches to those two templates, right before the delete took them.
  const usedBy = (key: "skills" | "mcps" | "kbs", slug: string) =>
    templateGrants[key][slug] ?? 0;
  // A2: how many PROJECT DEPLOYMENTS grant it (computed server-side by walking
  // every project.md — `org-view.server.getOrgSettingsView`). The delete drops
  // those grants too, so the confirm must disclose them, not just the templates.
  const projectGrantsFor = (key: "skills" | "mcps" | "kbs", slug: string) =>
    projectGrants[key][slug] ?? 0;

  const doDelete = () => {
    if (!confirm) return;
    const { kind, item } = confirm;
    if (kind === "kb") rowAction.submit({ intent: "kb-delete", kbId: item.id });
    if (kind === "mcp") rowAction.submit({ intent: "mcp-delete", mcpId: item.id });
    if (kind === "skill") rowAction.submit({ intent: "skill-delete", skillId: item.id });
    if (kind === "agent") rowAction.submit({ intent: "agent-delete", profileId: item.id });
    // No setConfirm(null): the dialog plays its exit, then its onCancel
    // clears it (ruling 459).
  };

  const browsingKb = browsing?.kind === "kb" ? (kbs.find((k) => k.id === browsing.id) ?? null) : null;
  const browsingSkill =
    browsing?.kind === "skill" ? (skills.find((s) => s.id === browsing.id) ?? null) : null;

  return (
    <div data-screen-label="Settings · Agent resources">
      <div className="rsrc-grid">
        <KbPanel
          kbs={kbs}
          usedBy={(slug) => usedBy("kbs", slug)}
          reindexing={reindexing}
          onNew={() => setModal({ kind: "kb", item: null })}
          onBrowse={(kb) => setBrowsing({ kind: "kb", id: kb.id })}
          onReindex={(kb) => {
            setReindexing(kb.id);
            reindexAction.submit({ intent: "kb-reindex", kbId: kb.id });
          }}
          onEdit={(kb) => setModal({ kind: "kb", item: kb })}
          onDelete={(kb) => setConfirm({ kind: "kb", item: kb })}
        />

        <McpPanel
          mcps={mcps}
          usedBy={(slug) => usedBy("mcps", slug)}
          testing={testing}
          onNew={() => setModal({ kind: "mcp", item: null })}
          onTest={(m) => {
            setTesting(m.id);
            testAction.submit({ intent: "mcp-test", mcpId: m.id });
          }}
          onEdit={(m) => setModal({ kind: "mcp", item: m })}
          onDelete={(m) => setConfirm({ kind: "mcp", item: m })}
        />

        <SkillPanel
          skills={skills}
          usedBy={(slug) => usedBy("skills", slug)}
          onNew={() => setModal({ kind: "skill", item: null })}
          onBrowse={(s) => setBrowsing({ kind: "skill", id: s.id })}
          onEdit={(s) => setModal({ kind: "skill", item: s })}
          onDelete={(s) => setConfirm({ kind: "skill", item: s })}
        />

        <AgentPanel
          gagents={gagents}
          stages={stages}
          onNew={() => setModal({ kind: "agent", item: null })}
          onEdit={(a) => setModal({ kind: "agent", item: a })}
          onDelete={(a) => {
            if (a.used > 0) {
              // D5: a refusal must not render the success tick.
              push(
                "Detach " + a.name + " from its " + countLabel(a.used, "project") + " first",
                "error",
              );
              return;
            }
            setConfirm({ kind: "agent", item: a });
          }}
        />
      </div>
      <div className="def-note spaced">
        <Icon name="shield" />
        <span>
          These are the shared base definitions. Each project's policy decides which
          profiles are eligible, which of their context resources may load, and what they
          may do, without changing the global.
        </span>
      </div>

      {modal && modal.kind === "kb" && (
        <KBModal
          key={modal.item?.id ?? "new"}
          initial={modal.item}
          onClose={() => setModal(null)}
          onFilesCreated={setPendingKbBrowse}
        />
      )}
      {modal && modal.kind === "mcp" && (
        <McpModal
          key={modal.item?.id ?? "new"}
          // Ruling 469: the row as the page holds it NOW, so a sign-in that
          // lands in the other tab (the callback publishes, this page
          // revalidates) reads "signed in" in the open editor.
          initial={modal.item ? (mcps.find((m) => m.id === modal.item?.id) ?? modal.item) : null}
          usedBy={modal.item ? usedBy("mcps", modal.item.name) : 0}
          onClose={() => setModal(null)}
        />
      )}
      {modal && modal.kind === "skill" && (
        <SkillModal
          key={modal.item?.id ?? "new"}
          initial={modal.item}
          onClose={() => setModal(null)}
          onFilesCreated={setPendingSkillBrowse}
        />
      )}
      {modal && modal.kind === "agent" && (
        <AgentModal
          key={modal.item?.id ?? "new"}
          initial={modal.item}
          stages={stages}
          kbs={kbs}
          mcps={mcps}
          skills={skills}
          onClose={() => setModal(null)}
        />
      )}

      {browsingKb && (
        <StoreBrowser
          title={browsingKb.name}
          subMono={browsingKb.uri + "/ · read live"}
          metaTail={"re-scanned " + rel(browsingKb.lastIndexedAt)}
          tree={browsingKb.tree}
          resource={{ kind: "kb", id: browsingKb.id }}
          onClose={() => setBrowsing(null)}
          {...(linkedDoc ? { initialDoc: linkedDoc } : {})}
        />
      )}
      {browsingSkill && (
        <StoreBrowser
          title={browsingSkill.name}
          subMono={browsingSkill.uri + "/ · SKILL.md + supporting files"}
          metaTail={updatedLabel(browsingSkill.updatedAt)}
          tree={browsingSkill.tree}
          resource={{ kind: "skill", id: browsingSkill.id }}
          onClose={() => setBrowsing(null)}
        />
      )}

      {confirm && (
        <ConfirmDelete
          what={confirm.item.name}
          // C6: name the outcome per resource kind, not a bare "Remove".
          confirmLabel={
            confirm.kind === "kb"
              ? "Remove knowledge base"
              : confirm.kind === "mcp"
                ? "Remove MCP server"
                : confirm.kind === "skill"
                  ? "Remove skill"
                  : "Remove agent profile"
          }
          detail={
            confirm.kind === "kb"
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
                  : "The base definition is deleted. It isn't deployed anywhere."
          }
          onCancel={() => setConfirm(null)}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}
