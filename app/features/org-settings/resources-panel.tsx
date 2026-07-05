import { useEffect, useState } from "react";
import { FolderIco } from "~/features/kb-browser/icons";
import { StoreBrowser } from "~/features/kb-browser/store-browser";
import type { GagentView } from "~/server/org/gagents.server";
import type {
  KbView,
  McpView,
  SkillView,
} from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { formatRelative } from "~/shared/dates/format";
import { slugify } from "~/shared/ids/slugify";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { useToast } from "~/ui/toast";
import { ConfirmDelete, EditIco, MiniModal } from "./mini-modal";
import { useOrgAction, type OrgAction, type OrgActionData } from "./use-org-action";

/**
 * Agent resources tab (org-settings spec §4.3/§4.4): four CRUD panels —
 * knowledge bases, MCP servers, skills, global agent profiles (the org
 * TEMPLATE layer 9A's project roster consumes) — plus the StoreBrowser
 * popup over the real store folders. Honest deltas: re-index re-scans the
 * real folder (doc counts are real), MCP "test" is a real reachability
 * probe (tool counts are never fabricated), timestamps render relative
 * from ISO. The skill-delete confirm uses the folder form of the copy
 * (spec §8.6 recommendation).
 */

function rel(iso: string | null): string {
  return iso ? formatRelative(iso) : "never";
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
            <button key={r} className={refresh === r ? "on" : ""} onClick={() => setRefresh(r)}>
              {r}
            </button>
          ))}
        </span>
        <div className="def-note">
          <Icon name="file" />
          <span>
            Content is plain files inside the folder — inspectable and editable outside
            Viberr. Indexing just makes it retrievable for agents.
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
  const [cred, setCred] = useState(initial ? (initial.cred ?? "") : "");
  const { action, err, setErr } = useModalAction(() => onClose());
  const canSave = !action.busy && slugify(name).length > 1 && target.trim().length > 3;
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
          cred: cred.trim(),
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
            <button className={transport === "HTTP" ? "on" : ""} onClick={() => setTransport("HTTP")}>
              HTTP
            </button>
            <button className={transport === "stdio" ? "on" : ""} onClick={() => setTransport("stdio")}>
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
        <label className="flabel" htmlFor="mcp-cred">
          Credential <span className="fhint">optional · secret reference</span>
        </label>
        <input
          id="mcp-cred"
          type="text"
          className="mono"
          value={cred}
          placeholder="secret://mcp/…"
          onChange={(e) => setCred(e.target.value)}
        />
        <div className="def-note">
          <Icon name="lock" />
          <span>
            Referenced at runtime only. Secrets never appear in task timelines, comments,
            or audit records.
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
  const kbNames = kbs.map((k) => k.name);
  const match = (list: string[], names: string[]) => list.filter((x) => names.includes(x));
  const unmatched = (list: string[], names: string[]) => list.filter((x) => !names.includes(x));

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
    initial ? match(initial.kbs, kbNames) : [],
  );
  // Legacy template resource strings that don't match an org resource are
  // preserved untouched on save (documented deviation).
  const legacy = {
    skills: initial ? unmatched(initial.skills, skillNames) : [],
    mcps: initial ? unmatched(initial.mcps, mcpNames) : [],
    kbs: initial ? unmatched(initial.kbs, kbNames) : [],
  };
  const { action, err, setErr } = useModalAction(() => onClose());

  const stageOpts = stages.filter((s) => s.id !== "done");
  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const canSave = !action.busy && name.trim().length > 1 && selStages.length > 0;

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
              key={s.id}
              className={"pick-chip" + (selStages.includes(s.id) ? " on" : "")}
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
                  key={s.id}
                  className={"pick-chip mono" + (selSkills.includes(s.name) ? " on" : "")}
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
                  key={m.id}
                  className={"pick-chip mono" + (selMcps.includes(m.name) ? " on" : "")}
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
                  key={k.id}
                  className={"pick-chip" + (selKbs.includes(k.name) ? " on" : "")}
                  onClick={() => toggle(selKbs, setSelKbs, k.name)}
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
  | { kind: "skill"; item: SkillView }
  | { kind: "agent"; item: GagentView };

type ResourceModal =
  | { kind: "kb"; item: KbView | null }
  | { kind: "mcp"; item: McpView | null }
  | { kind: "skill"; item: SkillView | null }
  | { kind: "agent"; item: GagentView | null };

/** Busy-row tracking for spin icons (re-index / test connection). */
function useBusyRow(action: OrgAction): [string | null, (id: string) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => {
    if (action.fetcher.state === "idle" && action.fetcher.data) setBusyId(null);
  }, [action.fetcher.state, action.fetcher.data]);
  return [busyId, setBusyId];
}

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
  const push = useToast();
  const rowAction = useOrgAction();
  const reindexAction = useOrgAction();
  const testAction = useOrgAction();
  const [reindexing, setReindexing] = useBusyRow(reindexAction);
  const [testing, setTesting] = useBusyRow(testAction);

  const usedBy = (key: "skills" | "mcps" | "kbs", id: string, name: string) =>
    gagents.filter((a) => a[key].includes(id) || a[key].includes(name)).length;

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
    <div className="rsrc-wrap" data-screen-label="Settings — Agent resources">
      <div className="rsrc-grid">
        <section className="panel">
          <div className="panel-head">
            <Icon name="memory" />
            <h2>Knowledge bases</h2>
            <span className="right">
              <button className="btn sm" onClick={() => setModal({ kind: "kb", item: null })}>
                <Icon name="plus" />
                New
              </button>
            </span>
          </div>
          <div className="rsrc-list">
            {kbs.map((kb) => (
              <div className="rsrc-row" key={kb.id}>
                <span className="rsrc-main">
                  <b>
                    <button className="linkish" onClick={() => setBrowsing({ kind: "kb", id: kb.id })}>
                      {kb.name}
                    </button>
                  </b>
                  <span className="sub mono">
                    store://kb/{kb.dir}/ · {kb.fileCount} docs
                  </span>
                  <span className="sub">
                    re-index {kb.refresh} · indexed {rel(kb.lastIndexedAt)}
                    {usedBy("kbs", kb.id, kb.name) > 0
                      ? " · " + usedBy("kbs", kb.id, kb.name) + " profiles"
                      : ""}
                  </span>
                </span>
                <span className="rsrc-acts">
                  <button
                    className="stg-x"
                    title="Browse files"
                    aria-label={"Browse files in " + kb.name}
                    onClick={() => setBrowsing({ kind: "kb", id: kb.id })}
                  >
                    <FolderIco />
                  </button>
                  <button
                    className="stg-x"
                    title="Re-index now"
                    aria-label={"Re-index " + kb.name}
                    onClick={() => {
                      setReindexing(kb.id);
                      reindexAction.submit({ intent: "kb-reindex", kbId: kb.id });
                    }}
                  >
                    <Icon name="refresh" className={reindexing === kb.id ? "spin" : ""} />
                  </button>
                  <button
                    className="stg-x"
                    title="Edit"
                    aria-label={"Edit " + kb.name}
                    onClick={() => setModal({ kind: "kb", item: kb })}
                  >
                    <EditIco />
                  </button>
                  <button
                    className="stg-x"
                    title="Delete"
                    aria-label={"Delete " + kb.name}
                    onClick={() => setConfirm({ kind: "kb", item: kb })}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              </div>
            ))}
            {kbs.length === 0 && <div className="empty">No knowledge bases yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <Icon name="cpu" />
            <h2>MCP servers</h2>
            <span className="right">
              <button className="btn sm" onClick={() => setModal({ kind: "mcp", item: null })}>
                <Icon name="plus" />
                Add
              </button>
            </span>
          </div>
          <div className="rsrc-list">
            {mcps.map((m) => (
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
                  <span className="sub">
                    {m.up === true
                      ? (m.tools !== null ? m.tools + " tools · " : "reachable · ") +
                        "checked " + rel(m.lastCheckedAt)
                      : m.up === false
                        ? "unreachable · checked " + rel(m.lastCheckedAt)
                        : "not health-checked yet"}
                    {m.cred ? " · auth: " + m.cred : ""}
                  </span>
                </span>
                <span className="rsrc-acts">
                  <button
                    className="stg-x"
                    title="Test connection"
                    aria-label={"Test " + m.name}
                    onClick={() => {
                      setTesting(m.id);
                      testAction.submit({ intent: "mcp-test", mcpId: m.id });
                    }}
                  >
                    <Icon name="refresh" className={testing === m.id ? "spin" : ""} />
                  </button>
                  <button
                    className="stg-x"
                    title="Edit"
                    aria-label={"Edit " + m.name}
                    onClick={() => setModal({ kind: "mcp", item: m })}
                  >
                    <EditIco />
                  </button>
                  <button
                    className="stg-x"
                    title="Remove"
                    aria-label={"Remove " + m.name}
                    onClick={() => setConfirm({ kind: "mcp", item: m })}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              </div>
            ))}
            {mcps.length === 0 && <div className="empty">No MCP servers yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <Icon name="bolt" />
            <h2>Skills</h2>
            <span className="right">
              <button className="btn sm" onClick={() => setModal({ kind: "skill", item: null })}>
                <Icon name="plus" />
                New
              </button>
            </span>
          </div>
          <div className="rsrc-list">
            {skills.map((s) => (
              <div className="rsrc-row" key={s.id}>
                <span className="rsrc-main">
                  <b className="mono-b">
                    <button
                      className="linkish"
                      onClick={() => setBrowsing({ kind: "skill", id: s.id })}
                    >
                      {s.name}
                    </button>
                  </b>
                  <span className="sub">{s.summary}</span>
                  <span className="sub mono">
                    store://skills/{s.name}/ · {s.fileCount} file
                    {s.fileCount === 1 ? "" : "s"} · updated {rel(s.updatedAt)}
                    {usedBy("skills", s.id, s.name) > 0
                      ? " · " + usedBy("skills", s.id, s.name) + " profiles"
                      : ""}
                  </span>
                </span>
                <span className="rsrc-acts">
                  <button
                    className="stg-x"
                    title="Browse files"
                    aria-label={"Browse files in " + s.name}
                    onClick={() => setBrowsing({ kind: "skill", id: s.id })}
                  >
                    <FolderIco />
                  </button>
                  <button
                    className="stg-x"
                    title="Edit"
                    aria-label={"Edit " + s.name}
                    onClick={() => setModal({ kind: "skill", item: s })}
                  >
                    <EditIco />
                  </button>
                  <button
                    className="stg-x"
                    title="Delete"
                    aria-label={"Delete " + s.name}
                    onClick={() => setConfirm({ kind: "skill", item: s })}
                  >
                    <Icon name="x" />
                  </button>
                </span>
              </div>
            ))}
            {skills.length === 0 && <div className="empty">No skills yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <Icon name="agents" />
            <h2>Global agent profiles</h2>
            <span className="right">
              <button className="btn sm" onClick={() => setModal({ kind: "agent", item: null })}>
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
                      className="stg-x"
                      title="Edit"
                      aria-label={"Edit " + a.name}
                      onClick={() => setModal({ kind: "agent", item: a })}
                    >
                      <EditIco />
                    </button>
                    <button
                      className="stg-x"
                      title="Delete"
                      aria-label={"Delete " + a.name}
                      onClick={() => {
                        if (a.used > 0) {
                          push(
                            "Detach " + a.name + " from its " + a.used + " project" +
                              (a.used === 1 ? "" : "s") + " first",
                          );
                          return;
                        }
                        setConfirm({ kind: "agent", item: a });
                      }}
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
          root={browsingKb.uri}
          subMono={browsingKb.uri + "/ · re-index " + browsingKb.refresh}
          metaTail={"indexed " + rel(browsingKb.lastIndexedAt)}
          tree={browsingKb.tree}
          resource={{ kind: "kb", id: browsingKb.id }}
          onClose={() => setBrowsing(null)}
        />
      )}
      {browsingSkill && (
        <StoreBrowser
          title={browsingSkill.name}
          root={browsingSkill.uri}
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
              ? "The index is removed from the store. Profiles referencing it simply stop loading it — nothing else breaks."
              : confirm.kind === "mcp"
                ? "Profiles referencing this server lose its tools on their next run."
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
