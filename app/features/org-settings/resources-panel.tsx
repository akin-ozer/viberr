import { useState } from "react";
import { FolderIco } from "~/features/kb-browser/icons";
import { StoreBrowser } from "~/features/kb-browser/store-browser";
import type { GagentView } from "~/server/org/gagents.server";
import type {
  KbView,
  McpView,
  SkillView,
} from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import type { OrgSecretMetadata } from "~/server/secrets/org-secret-store.server";
import type {
  AgentResourceKind,
  AgentResourceUsage,
} from "~/server/org/resource-dependencies.server";
import { formatRelative } from "~/shared/dates/format";
import { useViewerTimeZone } from "~/shared/dates/use-viewer-time-zone";
import { slugify } from "~/shared/ids/slugify";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { useToast } from "~/ui/toast";
import { ConfirmDelete, EditIco, MiniModal } from "./mini-modal";
import { useOrgAction, type OrgAction, type OrgActionData } from "./use-org-action";

/**
 * Agent resources tab: knowledge bases, MCP servers, encrypted org secrets,
 * skills, and global agent profiles (the org
 * TEMPLATE layer 9A's project roster consumes) — plus the StoreBrowser
 * popup over the real store folders. Honest deltas: re-index re-scans the
 * real folder (doc counts are real), MCP "test" is a real initialize +
 * tools/list handshake (tool counts are never fabricated), timestamps render relative
 * from ISO. The skill-delete confirm uses the folder form of the copy
 * (spec §8.6 recommendation).
 */

function rel(iso: string | null, timeZone: string): string {
  return iso ? formatRelative(iso, new Date(), timeZone) : "never";
}

/** Shared modal-close-with-inline-error fetcher wiring. */
function useModalAction(onDone: (d: OrgActionData & { ok: true }) => void) {
  const [err, setErr] = useState<string | null>(null);
  const push = useToast();
  const action = useOrgAction({
    onResult: (d) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.toast) push(d.toast);
      onDone(d);
    },
  });
  return { action, err, setErr };
}

// ------------------------------------------------------------------ modals

function KBModal({ initial, onClose }: { initial: KbView | null; onClose: () => void }) {
  const [name, setName] = useState(initial ? initial.name : "");
  const [refresh, setRefresh] = useState(initial ? initial.refresh : "on change");
  const { action, err, setErr } = useModalAction(() => onClose());
  const canSave = !action.busy && name.trim().length > 1;
  return (
    <MiniModal
      icon={<Icon name="memory" />}
      title={initial ? "Edit knowledge base" : "New knowledge base"}
      sub="A folder in the store — drop docs in, or let agents append"
      onClose={onClose}
      canSave={canSave}
      saveLabel={initial ? "Save changes" : "Create & index"}
      footHint={"store://kb/" + (slugify(name) || "name") + "/"}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        action.submit({
          intent: "kb-save",
          ...(initial ? { kbId: initial.id } : {}),
          name: name.trim(),
          refresh,
        });
      }}
    >
      <div className="field">
        <label className="flabel" htmlFor="kb-name">
          Name<span className="req">*</span>{" "}
          <span className="fhint">names its folder in the knowledge-base store</span>
        </label>
        <input
          id="kb-name"
          type="text"
          value={name}
          placeholder="e.g. Architecture notes"
          onChange={(e) => {
            setName(e.target.value);
            setErr(null);
          }}
          autoFocus
        />
      </div>
      <div className="field">
        <span className="flabel">Re-index</span>
        <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
          {(["manual", "on change", "nightly"] as const).map((r) => (
            <button type="button" key={r} className={refresh === r ? "on" : ""} onClick={() => setRefresh(r)}>
              {r}
            </button>
          ))}
        </span>
        <div className="def-note">
          <Icon name="file" />
          <span>
            Content is plain files inside the folder — inspectable and editable outside
            Viberr. Agents always read the live folder at run time; this only sets how
            often the browsed doc count is re-scanned.
          </span>
        </div>
      </div>
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

function McpModal({ initial, onClose }: { initial: McpView | null; onClose: () => void }) {
  const [name, setName] = useState(initial ? initial.name : "");
  const [transport, setTransport] = useState<"HTTP" | "stdio">(
    initial ? initial.transport : "HTTP",
  );
  const [target, setTarget] = useState(initial ? initial.target : "");
  const [authText, setAuthText] = useState(
    initial
      ? Object.entries(initial.auth)
          .map(([name, ref]) => `${name}=${ref}`)
          .join("\n")
      : "",
  );
  const { action, err, setErr } = useModalAction(() => onClose());
  const auth = Object.fromEntries(
    authText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const split = line.indexOf("=");
        return split > 0
          ? [line.slice(0, split).trim(), line.slice(split + 1).trim()]
          : ["", ""];
      }),
  );
  const validAuth = Object.entries(auth).every(
    ([key, ref]) => Boolean(key) && /^secret:\/\/org\/[a-z0-9-]+$/.test(ref),
  );
  const canSave =
    !action.busy &&
    slugify(name).length > 1 &&
    target.trim().length > 3 &&
    validAuth;
  return (
    <MiniModal
      icon={<Icon name="cpu" />}
      title={initial ? "Edit MCP server" : "Add MCP server"}
      sub="Tools become loadable context for agent profiles"
      onClose={onClose}
      canSave={canSave}
      saveLabel={
        action.busy
          ? "Testing connection…"
          : initial
            ? "Save & re-test"
            : "Add & test connection"
      }
      footHint={transport === "stdio" ? "spawned per run, sandboxed" : "health-checked on save & test"}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        action.submit({
          intent: "mcp-save",
          ...(initial ? { mcpId: initial.id } : {}),
          name: slugify(name),
          transport,
          target: target.trim(),
          auth: JSON.stringify(auth),
        });
      }}
    >
      <div className="key-row">
        <div className="field">
          <label className="flabel" htmlFor="mcp-name">
            Server name<span className="req">*</span>
          </label>
          <input
            id="mcp-name"
            type="text"
            className="mono"
            value={name}
            placeholder="e.g. github-mcp"
            onChange={(e) => {
              setName(e.target.value);
              setErr(null);
            }}
            autoFocus
          />
        </div>
        <div className="field">
          <span className="flabel">Transport</span>
          <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
            <button type="button" className={transport === "HTTP" ? "on" : ""} onClick={() => setTransport("HTTP")}>
              HTTP
            </button>
            <button type="button" className={transport === "stdio" ? "on" : ""} onClick={() => setTransport("stdio")}>
              stdio
            </button>
          </span>
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="mcp-target">
          {transport === "stdio" ? "Command" : "Endpoint"}
          <span className="req">*</span>
        </label>
        <input
          id="mcp-target"
          type="text"
          className="mono"
          value={target}
          placeholder={
            transport === "stdio" ? "npx -y @mcp/server-postgres" : "https://mcp.internal:7801/sse"
          }
          onChange={(e) => {
            setTarget(e.target.value);
            setErr(null);
          }}
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="mcp-auth">
          Authentication mappings <span className="fhint">optional · one per line</span>
        </label>
        <textarea
          id="mcp-auth"
          className="mono"
          rows={3}
          value={authText}
          placeholder={
            transport === "stdio"
              ? "GITHUB_TOKEN=secret://org/github-token"
              : "Authorization=secret://org/mcp-token\nX-Account=secret://org/account-id"
          }
          onChange={(e) => {
            setAuthText(e.target.value);
            setErr(null);
          }}
        />
        <div className="def-note">
          <Icon name="lock" />
          <span>
            {transport === "HTTP" ? "Header name" : "Environment variable"} =
            secret reference. Values resolve only for a connection test or specialist
            spawn and never enter loaders, timelines, or audit records.
            {transport === "HTTP" && Object.keys(auth).length > 0
              ? " Authenticated HTTP MCP is Claude-only because Codex cannot express arbitrary header mappings."
              : ""}
          </span>
        </div>
      </div>
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

function SecretModal({
  initial,
  onClose,
}: {
  initial: OrgSecretMetadata | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [value, setValue] = useState("");
  const { action, err, setErr } = useModalAction(() => onClose());
  const canSave =
    !action.busy && slugify(name).length > 1 && value.length > 0;
  return (
    <MiniModal
      icon={<Icon name="lock" />}
      title={initial ? "Rotate org secret" : "Store org secret"}
      sub="Encrypted at rest; only its reference and suffix are visible later"
      onClose={onClose}
      canSave={canSave}
      saveLabel={initial ? "Rotate value" : "Store secret"}
      footHint={"secret://org/" + (slugify(name) || "name")}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        action.submit({
          intent: "secret-save",
          ...(initial ? { secretId: initial.id } : {}),
          name: slugify(name),
          value,
        });
      }}
    >
      <div className="field">
        <label className="flabel" htmlFor="secret-name">
          Name<span className="req">*</span>
        </label>
        <input
          id="secret-name"
          className="mono"
          value={name}
          disabled={Boolean(initial)}
          placeholder="e.g. billing-api-token"
          onChange={(event) => setName(event.target.value)}
          autoFocus={!initial}
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="secret-value">
          {initial ? "Replacement value" : "Secret value"}
          <span className="req">*</span>
        </label>
        <input
          id="secret-value"
          type="password"
          className="mono"
          value={value}
          autoComplete="new-password"
          onChange={(event) => {
            setValue(event.target.value);
            setErr(null);
          }}
          autoFocus={Boolean(initial)}
        />
        <div className="def-note">
          <Icon name="lock" />
          <span>
            Viberr will not show this value again. Rotate it here, then use the
            stable secret:// reference in MCP authentication mappings.
          </span>
        </div>
      </div>
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

function SkillModal({
  initial,
  onClose,
}: {
  initial: SkillView | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial ? initial.name : "");
  const [summary, setSummary] = useState(initial ? initial.summary : "");
  const [body, setBody] = useState(initial ? initial.body : "");
  const { action, err, setErr } = useModalAction(() => onClose());
  const canSave = !action.busy && slugify(name).length > 1 && summary.trim().length > 3;
  return (
    <MiniModal
      icon={<Icon name="bolt" />}
      title={initial ? "Edit skill" : "New skill"}
      sub="Reusable instructions an agent loads on demand"
      onClose={onClose}
      canSave={canSave}
      saveLabel={initial ? "Save changes" : "Create skill"}
      footHint={"store://skills/" + (slugify(name) || "name") + "/"}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        action.submit({
          intent: "skill-save",
          ...(initial ? { skillId: initial.id } : {}),
          name: slugify(name),
          summary: summary.trim(),
          body,
        });
      }}
    >
      <div className="field">
        <label className="flabel" htmlFor="sk-name">
          Skill name<span className="req">*</span>
        </label>
        <input
          id="sk-name"
          type="text"
          className="mono"
          value={name}
          placeholder="e.g. terraform-review"
          onChange={(e) => {
            setName(e.target.value);
            setErr(null);
          }}
          autoFocus
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="sk-sum">
          Summary<span className="req">*</span>{" "}
          <span className="fhint">shown to the operator when choosing context</span>
        </label>
        <input
          id="sk-sum"
          type="text"
          value={summary}
          placeholder="What does this skill teach the agent?"
          onChange={(e) => {
            setSummary(e.target.value);
            setErr(null);
          }}
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="sk-body">
          SKILL.md <span className="fhint">markdown</span>
        </label>
        <textarea
          id="sk-body"
          rows={body ? Math.min(18, body.split("\n").length + 2) : 6}
          value={body}
          placeholder={"## When reviewing a module\n- check state safety\n- flag drift between plan and apply\n- …"}
          onChange={(e) => setBody(e.target.value)}
        ></textarea>
      </div>
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

const match = (list: string[], names: string[]) => {
  const set = new Set(names);
  return list.filter((x) => set.has(x));
};
const unmatched = (list: string[], names: string[]) => {
  const set = new Set(names);
  return list.filter((x) => !set.has(x));
};
const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
  set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/**
 * Profile templates historically stored a KB by display name, while the
 * runtime now stores its canonical folder id. Resolve every known alias to the
 * folder id and dedupe it before the modal renders/saves; otherwise a renamed
 * or migrated profile could carry both `Architecture notes` and
 * `architecture-notes`, with the legacy copy invisible and impossible to
 * remove from the picker.
 */
export function canonicalizeKbProfileRefs(
  refs: readonly string[],
  kbs: readonly Pick<KbView, "id" | "name" | "dir">[],
): { selected: string[]; legacy: string[] } {
  const aliases = new Map<string, string>();
  for (const kb of kbs) {
    aliases.set(kb.id, kb.dir);
    aliases.set(kb.name, kb.dir);
    aliases.set(kb.dir, kb.dir);
  }
  const selected = new Set<string>();
  const legacy: string[] = [];
  for (const ref of refs) {
    const canonical = aliases.get(ref);
    if (canonical) selected.add(canonical);
    else if (!legacy.includes(ref)) legacy.push(ref);
  }
  return { selected: [...selected], legacy };
}

function AgentModal({
  initial,
  stages,
  kbs,
  mcps,
  skills,
  onClose,
}: {
  initial: GagentView | null;
  stages: StageDef[];
  kbs: KbView[];
  mcps: McpView[];
  skills: SkillView[];
  onClose: () => void;
}) {
  const skillNames = skills.map((s) => s.name);
  const mcpNames = mcps.map((m) => m.name);
  // KB references are canonical folder ids (the runtime/catalog resolve
  // `store://kb/<dir>`), while the chip still renders the friendly name.
  const initialKbRefs = canonicalizeKbProfileRefs(initial?.kbs ?? [], kbs);

  const [name, setName] = useState(initial ? initial.name : "");
  const [backend, setBackend] = useState<"codex" | "claude">(
    initial ? initial.backend : "codex",
  );
  const [summary, setSummary] = useState(initial ? initial.summary : "");
  const [selStages, setSelStages] = useState<string[]>(initial ? initial.stages : ["impl"]);
  const [selSkills, setSelSkills] = useState<string[]>(
    initial ? match(initial.skills, skillNames) : [],
  );
  const [selMcps, setSelMcps] = useState<string[]>(
    initial ? match(initial.mcps, mcpNames) : [],
  );
  const [selKbs, setSelKbs] = useState<string[]>(
    initialKbRefs.selected,
  );
  // Legacy template resource strings that don't match an org resource are
  // preserved untouched on save (documented deviation).
  const legacy = {
    skills: initial ? unmatched(initial.skills, skillNames) : [],
    mcps: initial ? unmatched(initial.mcps, mcpNames) : [],
    kbs: initialKbRefs.legacy,
  };
  const { action, err, setErr } = useModalAction(() => onClose());

  const stageOpts = stages.filter((s) => s.id !== "done");
  const canSave = !action.busy && name.trim().length > 1 && selStages.length > 0;
  const selStageSet = new Set(selStages);
  const selSkillSet = new Set(selSkills);
  const selMcpSet = new Set(selMcps);
  const selKbSet = new Set(selKbs);

  return (
    <MiniModal
      icon={<AgentGlyph backend={backend} />}
      title={initial ? "Edit agent profile" : "New agent profile"}
      sub="Global base definition — projects grant eligibility & capabilities"
      onClose={onClose}
      canSave={canSave}
      saveLabel={initial ? "Save changes" : "Create profile"}
      footHint={
        initial && initial.used > 0
          ? "used in " + initial.used + " project" + (initial.used === 1 ? "" : "s") + " — changes apply on next run"
          : "not deployed yet"
      }
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        action.submit({
          intent: "agent-save",
          ...(initial ? { profileId: initial.id } : {}),
          name: name.trim(),
          backend,
          summary: summary.trim(),
          stages: JSON.stringify(selStages),
          skills: JSON.stringify([...selSkills, ...legacy.skills]),
          mcps: JSON.stringify([...selMcps, ...legacy.mcps]),
          kbs: JSON.stringify([...selKbs, ...legacy.kbs]),
        });
      }}
    >
      <div className="field">
        <label className="flabel" htmlFor="ga-name">
          Profile name<span className="req">*</span>
        </label>
        <input
          id="ga-name"
          type="text"
          value={name}
          placeholder="e.g. Security reviewer"
          onChange={(e) => {
            setName(e.target.value);
            setErr(null);
          }}
          autoFocus
        />
      </div>
      <div className="field">
        <span className="flabel">Backend</span>
        <div className="be-pick">
          <button
            type="button"
            className={"be-opt" + (backend === "codex" ? " on" : "")}
            onClick={() => setBackend("codex")}
            aria-pressed={backend === "codex"}
          >
            <AgentGlyph backend="codex" />
            <span>
              <span className="bnm">Codex</span>
            </span>
            <span className="bcheck">
              <Icon name="check" />
            </span>
          </button>
          <button
            type="button"
            className={"be-opt" + (backend === "claude" ? " on" : "")}
            onClick={() => setBackend("claude")}
            aria-pressed={backend === "claude"}
          >
            <AgentGlyph backend="claude" />
            <span>
              <span className="bnm">Claude Code</span>
            </span>
            <span className="bcheck">
              <Icon name="check" />
            </span>
          </button>
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="ga-sum">
          Role summary
        </label>
        <input
          id="ga-sum"
          type="text"
          value={summary}
          placeholder="One line the operator sees when assigning work"
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="field">
        <span className="flabel">
          Default eligible stages<span className="req">*</span>{" "}
          <span className="fhint">Done is human-only, always</span>
        </span>
        <div className="pick-chips">
          {stageOpts.map((s) => (
            <button
              type="button"
              key={s.id}
              className={"pick-chip" + (selStageSet.has(s.id) ? " on" : "")}
              onClick={() => toggle(selStages, setSelStages, s.id)}
            >
              <span className="sdot" style={{ background: s.color }}></span>
              {s.name}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span className="flabel">
          Loadable context <span className="fhint">what this profile may pull into a run</span>
        </span>
        <div className="ctx-groups">
          <div className="ctx-group">
            <span className="ctx-lbl">Skills</span>
            <div className="pick-chips">
              {skills.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={"pick-chip mono" + (selSkillSet.has(s.name) ? " on" : "")}
                  onClick={() => toggle(selSkills, setSelSkills, s.name)}
                >
                  {s.name}
                </button>
              ))}
              {skills.length === 0 && <span className="ctx-none">none defined</span>}
            </div>
          </div>
          <div className="ctx-group">
            <span className="ctx-lbl">MCP servers</span>
            <div className="pick-chips">
              {mcps.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={"pick-chip mono" + (selMcpSet.has(m.name) ? " on" : "")}
                  onClick={() => toggle(selMcps, setSelMcps, m.name)}
                >
                  {m.name}
                </button>
              ))}
              {mcps.length === 0 && <span className="ctx-none">none defined</span>}
            </div>
          </div>
          <div className="ctx-group">
            <span className="ctx-lbl">Knowledge bases</span>
            <div className="pick-chips">
              {kbs.map((k) => (
                <button
                  type="button"
                  key={k.id}
                  className={"pick-chip" + (selKbSet.has(k.dir) ? " on" : "")}
                  onClick={() => toggle(selKbs, setSelKbs, k.dir)}
                >
                  {k.name}
                </button>
              ))}
              {kbs.length === 0 && <span className="ctx-none">none defined</span>}
            </div>
          </div>
        </div>
      </div>
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

// ------------------------------------------------------------------ panel

type ResourceConfirm =
  | { kind: "kb"; item: KbView }
  | { kind: "mcp"; item: McpView }
  | { kind: "secret"; item: OrgSecretMetadata }
  | { kind: "skill"; item: SkillView }
  | { kind: "agent"; item: GagentView };

type ResourceModal =
  | { kind: "kb"; item: KbView | null }
  | { kind: "mcp"; item: McpView | null }
  | { kind: "secret"; item: OrgSecretMetadata | null }
  | { kind: "skill"; item: SkillView | null }
  | { kind: "agent"; item: GagentView | null };

/** Busy-row tracking for spin icons (re-index / test connection). */
function useBusyRow(action: OrgAction): [string | null, (id: string) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  const settled = action.fetcher.state === "idle" && Boolean(action.fetcher.data);
  return [settled ? null : busyId, setBusyId];
}

function KbPanel({
  kbs,
  usedBy,
  reindexing,
  onNew,
  onBrowse,
  onReindex,
  onEdit,
  onDelete,
}: {
  kbs: KbView[];
  usedBy: (id: string, name: string) => AgentResourceUsage[];
  reindexing: string | null;
  onNew: () => void;
  onBrowse: (kb: KbView) => void;
  onReindex: (kb: KbView) => void;
  onEdit: (kb: KbView) => void;
  onDelete: (kb: KbView) => void;
}) {
  const timeZone = useViewerTimeZone();
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="memory" />
        <h2>Knowledge bases</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            New
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {kbs.map((kb) => {
          const usages = usedBy(kb.id, kb.name);
          return (
            <div className="rsrc-row" key={kb.id}>
            <span className="rsrc-main">
              <b>
                <button type="button" className="linkish" onClick={() => onBrowse(kb)}>
                  {kb.name}
                </button>
              </b>
              <span className="sub mono">
                store://kb/{kb.dir}/ · {kb.fileCount} docs
              </span>
              <span className="sub">
                read live · re-scanned {rel(kb.lastIndexedAt, timeZone)}
                {usages.length > 0
                  ? " · " + usages.length + " reference" + (usages.length === 1 ? "" : "s")
                  : ""}
              </span>
              {usages.length > 0 && (
                <span className="sub resource-used-by">
                  used by {usages.map((usage) => usage.label).join(" · ")}
                </span>
              )}
            </span>
            <span className="rsrc-acts">
              <button
                type="button"
                className="stg-x"
                title="Browse files"
                aria-label={"Browse files in " + kb.name}
                onClick={() => onBrowse(kb)}
              >
                <FolderIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Re-scan folder — refresh the doc count"
                aria-label={"Re-scan " + kb.name}
                onClick={() => onReindex(kb)}
              >
                <Icon name="refresh" className={reindexing === kb.id ? "spin" : ""} />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Edit"
                aria-label={"Edit " + kb.name}
                onClick={() => onEdit(kb)}
              >
                <EditIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Delete"
                aria-label={"Delete " + kb.name}
                onClick={() => onDelete(kb)}
              >
                <Icon name="x" />
              </button>
            </span>
            </div>
          );
        })}
        {kbs.length === 0 && <div className="empty">No knowledge bases yet.</div>}
      </div>
    </section>
  );
}

function SecretPanel({
  secrets,
  onNew,
  onRotate,
  onDelete,
}: {
  secrets: OrgSecretMetadata[];
  onNew: () => void;
  onRotate: (secret: OrgSecretMetadata) => void;
  onDelete: (secret: OrgSecretMetadata) => void;
}) {
  const timeZone = useViewerTimeZone();
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="lock" />
        <h2>Org secrets</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            Add
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {secrets.map((secret) => (
          <div className="rsrc-row" key={secret.id}>
            <span className="rsrc-main">
              <b className="mono-b">{secret.name}</b>
              <span className="sub mono">{secret.ref}</span>
              <span className="sub">
                {secret.masked} · rotated {rel(secret.updatedAt, timeZone)}
              </span>
            </span>
            <span className="rsrc-acts">
              <button
                type="button"
                className="stg-x"
                title="Rotate value"
                aria-label={"Rotate " + secret.name}
                onClick={() => onRotate(secret)}
              >
                <Icon name="refresh" />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Delete"
                aria-label={"Delete " + secret.name}
                onClick={() => onDelete(secret)}
              >
                <Icon name="x" />
              </button>
            </span>
          </div>
        ))}
        {secrets.length === 0 && (
          <div className="empty">No org secrets yet.</div>
        )}
      </div>
    </section>
  );
}

function McpPanel({
  mcps,
  usedBy,
  testing,
  onNew,
  onTest,
  onEdit,
  onDelete,
}: {
  mcps: McpView[];
  usedBy: (id: string, name: string) => AgentResourceUsage[];
  testing: string | null;
  onNew: () => void;
  onTest: (m: McpView) => void;
  onEdit: (m: McpView) => void;
  onDelete: (m: McpView) => void;
}) {
  const timeZone = useViewerTimeZone();
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="cpu" />
        <h2>MCP servers</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            Add
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {mcps.map((m) => {
          const usages = usedBy(m.id, m.name);
          return (
            <div className="rsrc-row" key={m.id}>
            <span
              className={"stat-dot" + (m.up === true ? " up" : m.up === false ? " down" : "")}
              title={m.up === true ? "connected" : m.up === false ? "unreachable" : "not health-checked"}
            ></span>
            <span className="rsrc-main">
              <b className="mono-b">{m.name}</b>
              <span className="sub mono">
                {m.transport} · {m.target}
              </span>
              {usages.length > 0 && (
                <span className="sub resource-used-by">
                  used by {usages.map((usage) => usage.label).join(" · ")}
                </span>
              )}
              <span className="sub">
                {m.up === true
                  ? (m.tools !== null ? m.tools + " tools · " : "healthy · ") +
                    "checked " + rel(m.lastCheckedAt, timeZone)
                  : m.up === false
                    ? "unreachable · checked " + rel(m.lastCheckedAt, timeZone)
                    : "not health-checked yet"}
                {Object.keys(m.auth).length
                  ? " · auth: " +
                    Object.entries(m.auth)
                      .map(([name, ref]) => name + "→" + ref)
                      .join(", ")
                  : ""}
                {" · " + (m.codexSupported ? "Claude + Codex" : "Claude only")}
              </span>
            </span>
            <span className="rsrc-acts">
              <button
                type="button"
                className="stg-x"
                title="Test connection"
                aria-label={"Test " + m.name}
                onClick={() => onTest(m)}
              >
                <Icon name="refresh" className={testing === m.id ? "spin" : ""} />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Edit"
                aria-label={"Edit " + m.name}
                onClick={() => onEdit(m)}
              >
                <EditIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Remove"
                aria-label={"Remove " + m.name}
                onClick={() => onDelete(m)}
              >
                <Icon name="x" />
              </button>
            </span>
            </div>
          );
        })}
        {mcps.length === 0 && <div className="empty">No MCP servers yet.</div>}
      </div>
    </section>
  );
}

function SkillPanel({
  skills,
  usedBy,
  onNew,
  onBrowse,
  onEdit,
  onDelete,
}: {
  skills: SkillView[];
  usedBy: (id: string, name: string) => AgentResourceUsage[];
  onNew: () => void;
  onBrowse: (s: SkillView) => void;
  onEdit: (s: SkillView) => void;
  onDelete: (s: SkillView) => void;
}) {
  const timeZone = useViewerTimeZone();
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="bolt" />
        <h2>Skills</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            New
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {skills.map((s) => {
          const usages = usedBy(s.id, s.name);
          return (
            <div className="rsrc-row" key={s.id}>
            <span className="rsrc-main">
              <b className="mono-b">
                <button
                  type="button"
                  className="linkish"
                  onClick={() => onBrowse(s)}
                >
                  {s.name}
                </button>
              </b>
              <span className="sub">{s.summary}</span>
              <span className="sub mono">
                store://skills/{s.name}/ · {s.fileCount} file
                {s.fileCount === 1 ? "" : "s"} · updated {rel(s.updatedAt, timeZone)}
                {usages.length > 0
                  ? " · " + usages.length + " reference" + (usages.length === 1 ? "" : "s")
                  : ""}
              </span>
              {usages.length > 0 && (
                <span className="sub resource-used-by">
                  used by {usages.map((usage) => usage.label).join(" · ")}
                </span>
              )}
            </span>
            <span className="rsrc-acts">
              <button
                type="button"
                className="stg-x"
                title="Browse files"
                aria-label={"Browse files in " + s.name}
                onClick={() => onBrowse(s)}
              >
                <FolderIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Edit"
                aria-label={"Edit " + s.name}
                onClick={() => onEdit(s)}
              >
                <EditIco />
              </button>
              <button
                type="button"
                className="stg-x"
                title="Delete"
                aria-label={"Delete " + s.name}
                onClick={() => onDelete(s)}
              >
                <Icon name="x" />
              </button>
            </span>
            </div>
          );
        })}
        {skills.length === 0 && <div className="empty">No skills yet.</div>}
      </div>
    </section>
  );
}

function AgentPanel({
  gagents,
  stages,
  onNew,
  onEdit,
  onDelete,
}: {
  gagents: GagentView[];
  stages: StageDef[];
  onNew: () => void;
  onEdit: (a: GagentView) => void;
  onDelete: (a: GagentView) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <Icon name="agents" />
        <h2>Global agent profiles</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={onNew}>
            <Icon name="plus" />
            New
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {gagents.map((a) => {
          const res = a.skills.length + a.mcps.length + a.kbs.length;
          const stageNames = a.stages
            .map((id) => stages.find((s) => s.id === id)?.name || id)
            .join(" · ");
          return (
            <div className="rsrc-row" key={a.id}>
              <AgentGlyph backend={a.backend} />
              <span className="rsrc-main">
                <b>{a.name}</b>
                <span className="sub">{a.summary}</span>
                <span className="sub mono">
                  {a.backend === "claude" ? "Claude Code" : "Codex"} ·{" "}
                  {stageNames || "no stages"} · {res} context resources ·{" "}
                  {a.used > 0
                    ? "used in " + a.used + " project" + (a.used === 1 ? "" : "s")
                    : "not deployed"}
                </span>
              </span>
              <span className="rsrc-acts">
                <button
                  type="button"
                  className="stg-x"
                  title="Edit"
                  aria-label={"Edit " + a.name}
                  onClick={() => onEdit(a)}
                >
                  <EditIco />
                </button>
                <button
                  type="button"
                  className="stg-x"
                  title="Delete"
                  aria-label={"Delete " + a.name}
                  onClick={() => onDelete(a)}
                >
                  <Icon name="x" />
                </button>
              </span>
            </div>
          );
        })}
        {gagents.length === 0 && <div className="empty">No global agent profiles yet.</div>}
      </div>
    </section>
  );
}

export function ResourcesPanel({
  kbs,
  mcps,
  secrets,
  skills,
  gagents,
  stages,
  resourceUsages,
}: {
  kbs: KbView[];
  mcps: McpView[];
  secrets: OrgSecretMetadata[];
  skills: SkillView[];
  gagents: GagentView[];
  stages: StageDef[];
  resourceUsages?: AgentResourceUsage[];
}) {
  const timeZone = useViewerTimeZone();
  const [modal, setModal] = useState<ResourceModal | null>(null);
  const [browsing, setBrowsing] = useState<{ kind: "kb" | "skill"; id: string } | null>(null);
  const [confirm, setConfirm] = useState<ResourceConfirm | null>(null);
  const push = useToast();
  const rowAction = useOrgAction();
  const reindexAction = useOrgAction();
  const testAction = useOrgAction();
  const [reindexing, setReindexing] = useBusyRow(reindexAction);
  const [testing, setTesting] = useBusyRow(testAction);

  // Older render fixtures do not carry the dependency projection; retain a
  // template-only fallback there. Production always supplies the complete
  // global-template + project-deployment index from the loader.
  const fallbackUsages: AgentResourceUsage[] = gagents.flatMap((agent) =>
    ([
      ["skill", agent.skills],
      ["mcp", agent.mcps],
      ["kb", agent.kbs],
    ] as const).flatMap(([kind, refs]) =>
      refs.map((ref) => ({
        kind,
        ref,
        source: "global-template" as const,
        profileId: agent.id,
        profileName: agent.name,
        label: `Global profile · ${agent.name}`,
      })),
    ),
  );
  const dependencyIndex = resourceUsages ?? fallbackUsages;
  const usedBy = (
    kind: AgentResourceKind,
    aliases: readonly string[],
  ): AgentResourceUsage[] => {
    const wanted = new Set(aliases);
    return dependencyIndex.filter(
      (usage) => usage.kind === kind && wanted.has(usage.ref),
    );
  };
  const blockReferencedDelete = (
    kind: AgentResourceKind,
    aliases: readonly string[],
    label: string,
  ): boolean => {
    const usages = usedBy(kind, aliases);
    if (usages.length === 0) return false;
    push({
      kind: "error",
      text: `Can't delete ${label}; used by: ${[
        ...new Set(usages.map((usage) => usage.label)),
      ].join(", ")}.`,
    });
    return true;
  };

  const doDelete = () => {
    if (!confirm) return;
    const { kind, item } = confirm;
    if (kind === "kb") rowAction.submit({ intent: "kb-delete", kbId: item.id });
    if (kind === "mcp") rowAction.submit({ intent: "mcp-delete", mcpId: item.id });
    if (kind === "secret")
      rowAction.submit({ intent: "secret-delete", secretId: item.id });
    if (kind === "skill") rowAction.submit({ intent: "skill-delete", skillId: item.id });
    if (kind === "agent") rowAction.submit({ intent: "agent-delete", profileId: item.id });
    setConfirm(null);
  };

  const browsingKb = browsing?.kind === "kb" ? (kbs.find((k) => k.id === browsing.id) ?? null) : null;
  const browsingSkill =
    browsing?.kind === "skill" ? (skills.find((s) => s.id === browsing.id) ?? null) : null;

  return (
    <div className="rsrc-wrap" data-screen-label="Settings — Agent resources">
      <div className="rsrc-grid">
        <KbPanel
          kbs={kbs}
          usedBy={(id, name) => {
            const kb = kbs.find((item) => item.id === id);
            return usedBy("kb", [id, name, kb?.dir ?? ""]);
          }}
          reindexing={reindexing}
          onNew={() => setModal({ kind: "kb", item: null })}
          onBrowse={(kb) => setBrowsing({ kind: "kb", id: kb.id })}
          onReindex={(kb) => {
            setReindexing(kb.id);
            reindexAction.submit({ intent: "kb-reindex", kbId: kb.id });
          }}
          onEdit={(kb) => setModal({ kind: "kb", item: kb })}
          onDelete={(kb) => {
            if (blockReferencedDelete("kb", [kb.id, kb.name, kb.dir], `knowledge base ${kb.name}`)) return;
            setConfirm({ kind: "kb", item: kb });
          }}
        />

        <McpPanel
          mcps={mcps}
          usedBy={(id, name) => usedBy("mcp", [id, name])}
          testing={testing}
          onNew={() => setModal({ kind: "mcp", item: null })}
          onTest={(m) => {
            setTesting(m.id);
            testAction.submit({ intent: "mcp-test", mcpId: m.id });
          }}
          onEdit={(m) => setModal({ kind: "mcp", item: m })}
          onDelete={(m) => {
            if (blockReferencedDelete("mcp", [m.id, m.name], `MCP server ${m.name}`)) return;
            setConfirm({ kind: "mcp", item: m });
          }}
        />

        <SecretPanel
          secrets={secrets}
          onNew={() => setModal({ kind: "secret", item: null })}
          onRotate={(secret) => setModal({ kind: "secret", item: secret })}
          onDelete={(secret) => setConfirm({ kind: "secret", item: secret })}
        />

        <SkillPanel
          skills={skills}
          usedBy={(id, name) => usedBy("skill", [id, name])}
          onNew={() => setModal({ kind: "skill", item: null })}
          onBrowse={(s) => setBrowsing({ kind: "skill", id: s.id })}
          onEdit={(s) => setModal({ kind: "skill", item: s })}
          onDelete={(s) => {
            if (blockReferencedDelete("skill", [s.id, s.name], `skill ${s.name}`)) return;
            setConfirm({ kind: "skill", item: s });
          }}
        />

        <AgentPanel
          gagents={gagents}
          stages={stages}
          onNew={() => setModal({ kind: "agent", item: null })}
          onEdit={(a) => setModal({ kind: "agent", item: a })}
          onDelete={(a) => {
            if (a.used > 0) {
              push(
                a.usedBy?.length
                  ? "Detach " +
                    a.name +
                    " from: " +
                    a.usedBy
                      .map((project) => `${project.name} (${project.slug})`)
                      .join(", ") +
                    " first"
                  : "Detach " + a.name + " from its " + a.used + " project" +
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
        <McpModal key={modal.item?.id ?? "new"} initial={modal.item} onClose={() => setModal(null)} />
      )}
      {modal && modal.kind === "secret" && (
        <SecretModal
          key={modal.item?.id ?? "new"}
          initial={modal.item}
          onClose={() => setModal(null)}
        />
      )}
      {modal && modal.kind === "skill" && (
        <SkillModal key={modal.item?.id ?? "new"} initial={modal.item} onClose={() => setModal(null)} />
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
          metaTail={"re-scanned " + rel(browsingKb.lastIndexedAt, timeZone)}
          tree={browsingKb.tree}
          resource={{ kind: "kb", id: browsingKb.id }}
          onClose={() => setBrowsing(null)}
        />
      )}
      {browsingSkill && (
        <StoreBrowser
          title={browsingSkill.name}
          subMono={browsingSkill.uri + "/ · SKILL.md + supporting files"}
          metaTail={"updated " + rel(browsingSkill.updatedAt, timeZone)}
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
              ? "The index is removed from the store. Profiles referencing it simply stop loading it — nothing else breaks."
              : confirm.kind === "mcp"
                ? "Profiles referencing this server lose its tools on their next run."
                : confirm.kind === "secret"
                  ? "Deletion is allowed only after every MCP authentication mapping stops referencing it."
                : confirm.kind === "skill"
                  ? "store://skills/" + confirm.item.name + "/ is deleted. Profiles referencing it stop loading it."
                  : "The base definition is deleted. It isn't deployed anywhere."
          }
          onCancel={() => setConfirm(null)}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}
