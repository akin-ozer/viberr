import { useState } from "react";
import { StoreBrowser } from "~/features/kb-browser/store-browser";
import type { GagentView } from "~/server/org/gagents.server";
import type { ProjectCustomStages } from "~/server/org/org-view.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { countLabel } from "~/shared/text/plural";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { ConfirmDelete } from "./confirm-delete";
import { KBModal, McpModal, SkillModal } from "./resource-modals";
import { AgentModal } from "./agent-template-modal";
import {
  AgentPanel,
  KbPanel,
  McpPanel,
  RelativeStamp,
  SkillPanel,
  UpdatedStamp,
} from "./resource-rows";
import {
  useResourceBrowsing,
  useResourcePosts,
  useWarmingRevalidation,
} from "./resources-panel-actions";
import {
  liveMcp,
  removalDetail,
  removalLabel,
  type ResourceConfirm,
  type ResourceModal,
} from "./resources-panel-derive";

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
 * Ruling 689(e) split the panel again along the task-page recipe: its state
 * and posts live in `resources-panel-actions.ts` (hooks), and what it reads
 * off that state, the removal confirm's copy among it, in
 * `resources-panel-derive.ts`.
 */

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
  projectStages,
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
  /** Ruling 618: the agent editor's Custom stages, by project. */
  projectStages: ProjectCustomStages[];
}) {
  const [modal, setModal] = useState<ResourceModal | null>(null);
  const [confirm, setConfirm] = useState<ResourceConfirm | null>(null);
  const {
    setBrowsing,
    linkedDoc,
    setPendingSkillBrowse,
    setPendingKbBrowse,
    browsingKb,
    browsingSkill,
  } = useResourceBrowsing(kbs, skills);
  const push = useToast();
  const { reindexing, testing, reindex, test, remove } = useResourcePosts();
  useWarmingRevalidation(mcps);

  /**
   * How many GLOBAL TEMPLATES reference this resource.
   *
   * P13-KM-08: this compared against the row `id` (a `kb_…`/`sk_…` value that
   * never appears in a grant) and the display `name`, but a grant stores the
   * store SLUG — so the KB count was structurally always 0 while the skill
   * count only worked because a skill's name IS its folder. Callers now pass
   * the slug. The label says "templates" because project deployments carry
   * their own copies and are not counted here.
   *
   * Counted server-side over the profile FILES, not from `gagents`: that list
   * is the specialist CRUD list and excludes the controller and operator
   * templates, while the delete rewrites EVERY profile file. Deriving it here
   * told an admin "Nothing grants it" about the three resources the shipped
   * store attaches to those two templates, right before the delete took them.
   */
  const usedBy = (key: "skills" | "mcps" | "kbs", slug: string) =>
    templateGrants[key][slug] ?? 0;
  // A2: how many PROJECT DEPLOYMENTS grant it (computed server-side by walking
  // every project.md — `org-view.server.getOrgSettingsView`). The delete drops
  // those grants too, so the confirm must disclose them, not just the templates.
  const projectGrantsFor = (key: "skills" | "mcps" | "kbs", slug: string) =>
    projectGrants[key][slug] ?? 0;
  // Each editor remounts per row it edits ("new" for a create).
  const editorKey = modal?.item?.id ?? "new";

  return (
    <div data-screen-label="Settings · Agent resources">
      <div className="rsrc-grid">
        <KbPanel
          kbs={kbs}
          usedBy={(slug) => usedBy("kbs", slug)}
          reindexing={reindexing}
          onNew={() => setModal({ kind: "kb", item: null })}
          onBrowse={(kb) => setBrowsing({ kind: "kb", id: kb.id })}
          onReindex={reindex}
          onEdit={(kb) => setModal({ kind: "kb", item: kb })}
          onDelete={(kb) => setConfirm({ kind: "kb", item: kb })}
        />

        <McpPanel
          mcps={mcps}
          usedBy={(slug) => usedBy("mcps", slug)}
          testing={testing}
          onNew={() => setModal({ kind: "mcp", item: null })}
          onTest={test}
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

      {modal?.kind === "kb" && (
        <KBModal
          key={editorKey}
          initial={modal.item}
          onClose={() => setModal(null)}
          onFilesCreated={setPendingKbBrowse}
        />
      )}
      {modal?.kind === "mcp" && (
        <McpModal
          key={editorKey}
          initial={liveMcp(modal.item, mcps)}
          usedBy={modal.item ? usedBy("mcps", modal.item.name) : 0}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "skill" && (
        <SkillModal
          key={editorKey}
          initial={modal.item}
          onClose={() => setModal(null)}
          onFilesCreated={setPendingSkillBrowse}
        />
      )}
      {modal?.kind === "agent" && (
        <AgentModal
          key={editorKey}
          initial={modal.item}
          stages={stages}
          projectStages={projectStages}
          kbs={kbs}
          mcps={mcps}
          skills={skills}
          onClose={() => setModal(null)}
        />
      )}

      {browsingKb && (
        <StoreBrowser
          title={browsingKb.name}
          // The folder path alone (owner request 2026-10-01): the browser's own
          // note already says this is the real folder on disk.
          subMono={browsingKb.uri + "/"}
          metaTail={
            <>
              re-scanned <RelativeStamp iso={browsingKb.lastIndexedAt} />
            </>
          }
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
          metaTail={<UpdatedStamp iso={browsingSkill.updatedAt} />}
          tree={browsingSkill.tree}
          resource={{ kind: "skill", id: browsingSkill.id }}
          onClose={() => setBrowsing(null)}
        />
      )}

      {confirm && (
        <ConfirmDelete
          what={confirm.item.name}
          confirmLabel={removalLabel(confirm.kind)}
          detail={removalDetail(confirm, usedBy, projectGrantsFor)}
          onCancel={() => setConfirm(null)}
          onConfirm={() => remove(confirm)}
        />
      )}
    </div>
  );
}
