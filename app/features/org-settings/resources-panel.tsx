import { useEffect, useState } from "react";
import { StoreBrowser } from "~/features/kb-browser/store-browser";
import type { GagentView } from "~/server/org/gagents.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { Icon } from "~/ui/icon";
import { useToast } from "~/ui/toast";
import { ConfirmDelete } from "./mini-modal";
import { useOrgAction } from "./use-org-action";
import { useBusyRow, rel } from "./resource-helpers";
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

/** Delete-confirm tail naming the grants that are about to be dropped
 *  (P14-KM-09). "Templates" because project deployments carry their own copies
 *  and are rewritten separately by `updateResourceReferences`. */
function grantTail(templates: number): string {
  return templates > 0
    ? ` The grant is dropped from ${templates} agent template${templates === 1 ? "" : "s"} and from every project that deployed them.`
    : " No agent template grants it.";
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
  stages,
}: {
  kbs: KbView[];
  mcps: McpView[];
  skills: SkillView[];
  gagents: GagentView[];
  stages: StageDef[];
}) {
  const [modal, setModal] = useState<ResourceModal | null>(null);
  const [browsing, setBrowsing] = useState<{ kind: "kb" | "skill"; id: string } | null>(null);
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
  const usedBy = (key: "skills" | "mcps" | "kbs", slug: string) =>
    gagents.filter((a) => a[key].includes(slug)).length;

  const doDelete = () => {
    if (!confirm) return;
    const { kind, item } = confirm;
    if (kind === "kb") rowAction.submit({ intent: "kb-delete", kbId: item.id });
    if (kind === "mcp") rowAction.submit({ intent: "mcp-delete", mcpId: item.id });
    if (kind === "skill") rowAction.submit({ intent: "skill-delete", skillId: item.id });
    if (kind === "agent") rowAction.submit({ intent: "agent-delete", profileId: item.id });
    setConfirm(null);
  };

  const browsingKb = browsing?.kind === "kb" ? (kbs.find((k) => k.id === browsing.id) ?? null) : null;
  const browsingSkill =
    browsing?.kind === "skill" ? (skills.find((s) => s.id === browsing.id) ?? null) : null;

  return (
    <div data-screen-label="Settings — Agent resources">
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
              push(
                "Detach " + a.name + " from its " + a.used + " project" +
                  (a.used === 1 ? "" : "s") + " first",
              );
              return;
            }
            setConfirm({ kind: "agent", item: a });
          }}
        />
      </div>
      <div className="def-note" style={{ marginTop: ".8rem" }}>
        <Icon name="shield" />
        <span>
          These are the shared base definitions. Each project's policy decides which
          profiles are eligible, which of their context resources may load, and what they
          may do — without changing the global.
        </span>
      </div>

      {modal && modal.kind === "kb" && (
        <KBModal key={modal.item?.id ?? "new"} initial={modal.item} onClose={() => setModal(null)} />
      )}
      {modal && modal.kind === "mcp" && (
        <McpModal
          key={modal.item?.id ?? "new"}
          initial={modal.item}
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
        />
      )}
      {browsingSkill && (
        <StoreBrowser
          title={browsingSkill.name}
          subMono={browsingSkill.uri + "/ · SKILL.md + supporting files"}
          metaTail={"updated " + rel(browsingSkill.updatedAt)}
          tree={browsingSkill.tree}
          resource={{ kind: "skill", id: browsingSkill.id }}
          onClose={() => setBrowsing(null)}
        />
      )}

      {confirm && (
        <ConfirmDelete
          what={confirm.item.name}
          detail={
            confirm.kind === "kb"
              ? "The index is removed from the store." +
                grantTail(usedBy("kbs", confirm.item.dir))
              : confirm.kind === "mcp"
                ? // P14-KM-09: this said "profiles referencing this server" with
                  // no idea how many there were — the last guardrail before a
                  // destructive change was the only blind one of the three.
                  "Its tools disappear from every run." +
                  grantTail(usedBy("mcps", confirm.item.name))
                : confirm.kind === "skill"
                  ? "store://skills/" + confirm.item.name + "/ is deleted." +
                    grantTail(usedBy("skills", confirm.item.name))
                  : "The base definition is deleted. It isn't deployed anywhere."
          }
          onCancel={() => setConfirm(null)}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}
