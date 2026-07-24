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

/** A health check older than this reads as STALE — a green "up" dot for an
 * hours-old check over-implies "healthy now" (stdio MCPs are only re-checked on
 * save/test, never on page load). Amber + a "stale" hint keeps it honest. */
const MCP_HEALTH_STALE_MS = 60 * 60 * 1000;
function isStaleCheck(iso: string | null): boolean {
  return !!iso && Date.now() - new Date(iso).getTime() > MCP_HEALTH_STALE_MS;
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
          data-autofocus=""
        />
      </div>
      <div className="field">
        <span className="flabel">Re-index</span>
        <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
          {(["on change", "manual"] as const).map((r) => (
            <button type="button" key={r} className={refresh === r ? "on" : ""} onClick={() => setRefresh(r)}>
              {r}
            </button>
          ))}
        </span>
        <div className="def-note">
          <Icon name="file" />
          <span>
            Content is plain files inside the folder — inspectable and editable outside
            Viberr. This setting controls the <strong>doc count and freshness stamp</strong>{" "}
            only: <strong>on change</strong> re-scans automatically whenever a file in the
            folder changes, <strong>manual</strong> only when you click re-scan. It does not
            pin what an agent reads — every run loads the live folder either way.
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
  // The stored credential is sealed and never round-tripped to the client
  // (F7-MCP1); the edit field always starts empty. Blank on save keeps the
  // existing sealed value; a non-empty value replaces it.
  const [cred, setCred] = useState("");
  // P13-KM-06: blank means "keep the stored secret", so removing one needs an
  // explicit intent — without it a repointed server kept sending the old token.
  const [clearCred, setClearCred] = useState(false);
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
      footHint={
        transport === "stdio"
          ? "spawned per run — it runs with the server's own privileges"
          : "a real MCP handshake runs on save & test"
      }
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
          ...(clearCred ? { clearCred: "1" } : {}),
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
            data-autofocus=""
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
        <label className="flabel" htmlFor="mcp-cred">
          Credential{" "}
          <span className="fhint">
            optional · token / API key
            {initial?.hasCred ? " · a credential is set — leave blank to keep it" : ""}
          </span>
        </label>
        <input
          id="mcp-cred"
          type="password"
          className="mono"
          value={cred}
          disabled={clearCred}
          placeholder={
            clearCred
              ? "will be removed on save"
              : initial?.hasCred
                ? "•••••••• (unchanged)"
                : "paste a token or API key"
          }
          onChange={(e) => setCred(e.target.value)}
        />
        {initial?.hasCred && (
          <button
            type="button"
            className="btn sm ghost"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              setClearCred((v) => !v);
              setCred("");
            }}
          >
            {clearCred ? "Keep the stored credential" : "Remove the stored credential"}
          </button>
        )}
        <div className="def-note">
          <Icon name="lock" />
          <span>
            Encrypted at rest and injected only into the agent run (Authorization header
            or MCP_CREDENTIAL env). Never shown again, and never in task timelines,
            comments, or audit records.
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
          // P13-KM-18: an empty body means "keep what's on disk" (the editor
          // only round-trips a truncated read for very large files), so
          // BLANKING a SKILL.md was impossible from the UI — the server's
          // explicit `clearBody` escape hatch had no caller. Emptying the
          // editor on an existing skill now says so.
          ...(initial && body.trim() === "" ? { clearBody: "1" } : {}),
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
          data-autofocus=""
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

/**
 * KB grants are stored by store DIR. Older profiles (and anything written by the
 * pre-P13-KM-01 editor) carry the DISPLAY NAME, which resolves to nothing at run
 * time. Rewrite what we can recognize, so opening and saving a profile repairs
 * it instead of preserving an unresolvable string forever.
 */
const kbDirsOf = (list: string[], kbs: KbView[]) => {
  const byDir = new Set(kbs.map((k) => k.dir));
  const nameToDir = new Map(kbs.map((k) => [k.name, k.dir]));
  const out: string[] = [];
  for (const entry of list) {
    const dir = byDir.has(entry) ? entry : nameToDir.get(entry);
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out;
};

/** Grants that match neither a dir nor a display name — preserved untouched. */
const kbLegacyOf = (list: string[], kbs: KbView[]) => {
  const known = new Set([...kbs.map((k) => k.dir), ...kbs.map((k) => k.name)]);
  return list.filter((x) => !known.has(x));
};
const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
  set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

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
  // P13-KM-01: a KB grant is stored — and resolved at run time — by its store
  // DIRECTORY (`readKbBody` reads `${DATA_ROOT}/kb/<dir>`). This picker used to
  // key on the display NAME, so granting "P13 facts" wrote `kb: ["P13 facts"]`
  // and every run silently got zero bytes while both UIs showed it attached.
  // `kbDirsOf` also repairs an existing display-name grant on open.

  const [name, setName] = useState(initial ? initial.name : "");
  const [backend, setBackend] = useState<"codex" | "claude">(
    initial ? initial.backend : "codex",
  );
  const [summary, setSummary] = useState(initial ? initial.summary : "");
  // P13-AP-01: the persona (the agent's system prompt) is edited on its own,
  // separately from the one-line blurb the operator reads. Editing the blurb no
  // longer flattens the persona.
  const [persona, setPersona] = useState(initial ? initial.persona : "");
  // P11-47: default a new profile's eligible stages to a real work stage that
  // exists, not a hardcoded "impl" that silently references nothing if the org
  // stage template renames/removes it. Prefer a stage literally named "impl",
  // else the middle non-terminal stage, else the first.
  const workStages = stages.filter((s) => s.id !== "done");
  const defaultStage =
    workStages.find((s) => s.id === "impl")?.id ??
    workStages[Math.floor(workStages.length / 2)]?.id ??
    workStages[0]?.id;
  const [selStages, setSelStages] = useState<string[]>(
    initial ? initial.stages : defaultStage ? [defaultStage] : [],
  );
  const [selSkills, setSelSkills] = useState<string[]>(
    initial ? match(initial.skills, skillNames) : [],
  );
  const [selMcps, setSelMcps] = useState<string[]>(
    initial ? match(initial.mcps, mcpNames) : [],
  );
  const [selKbs, setSelKbs] = useState<string[]>(
    initial ? kbDirsOf(initial.kbs, kbs) : [],
  );
  // Legacy template resource strings that don't match an org resource are
  // preserved untouched on save (documented deviation).
  const legacy = {
    skills: initial ? unmatched(initial.skills, skillNames) : [],
    mcps: initial ? unmatched(initial.mcps, mcpNames) : [],
    kbs: initial ? kbLegacyOf(initial.kbs, kbs) : [],
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
          ? "adopted by " +
            initial.used +
            " project" +
            (initial.used === 1 ? "" : "s") +
            " — each keeps its own copy; re-adopt to pick up this edit"
          : "a template — add it to a project from Agents → Add from library"
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
          persona: persona.trim(),
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
          data-autofocus=""
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
          Role summary{" "}
          <span className="fhint">the OPERATOR reads this when choosing an agent</span>
        </label>
        <input
          id="ga-sum"
          type="text"
          value={summary}
          placeholder="One line the operator sees when assigning work"
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="def-note">
        <Icon name="shield" />
        <span>
          A template starts with <strong>delivery withheld</strong> — it can read,
          validate and comment, but not write to the repository. Capability policy is a
          per-project decision: open the profile in a project&rsquo;s Agents page to grant
          branch, commit or pull-request rights there.
        </span>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="ga-persona">
          Persona / instructions{" "}
          <span className="fhint">
            the agent's working instructions — its system prompt on every run; markdown ok
          </span>
        </label>
        <textarea
          id="ga-persona"
          className="ta"
          rows={6}
          value={persona}
          placeholder="How this agent works: its responsibilities, standards, reporting format…"
          onChange={(e) => setPersona(e.target.value)}
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
                  title={k.uri + "/"}
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
  usedBy: (slug: string) => number;
  reindexing: string | null;
  onNew: () => void;
  onBrowse: (kb: KbView) => void;
  onReindex: (kb: KbView) => void;
  onEdit: (kb: KbView) => void;
  onDelete: (kb: KbView) => void;
}) {
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
        {kbs.map((kb) => (
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
                read live · re-scanned {rel(kb.lastIndexedAt)}
                {usedBy(kb.dir) > 0
                  ? " · " + usedBy(kb.dir) + " template" + (usedBy(kb.dir) === 1 ? "" : "s")
                  : ""}
              </span>
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
        ))}
        {kbs.length === 0 && <div className="empty">No knowledge bases yet.</div>}
      </div>
    </section>
  );
}

function McpPanel({
  mcps,
  testing,
  onNew,
  onTest,
  onEdit,
  onDelete,
}: {
  mcps: McpView[];
  testing: string | null;
  onNew: () => void;
  onTest: (m: McpView) => void;
  onEdit: (m: McpView) => void;
  onDelete: (m: McpView) => void;
}) {
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
        {mcps.map((m) => (
          <div className="rsrc-row" key={m.id}>
            {(() => {
              const stale = m.up === true && isStaleCheck(m.lastCheckedAt);
              return (
                <span
                  className={
                    "stat-dot" +
                    (stale ? " stale" : m.up === true ? " up" : m.up === false ? " down" : "")
                  }
                  title={
                    stale
                      ? "last check passed but is stale — retest to confirm"
                      : m.up === true
                        ? "connected"
                        : m.up === false
                          ? "unreachable"
                          : "not health-checked"
                  }
                ></span>
              );
            })()}
            <span className="rsrc-main">
              <b className="mono-b">{m.name}</b>
              <span className="sub mono">
                {m.transport} · {m.target}
              </span>
              <span className="sub">
                {m.up === true
                  ? (m.tools !== null ? m.tools + " tools · " : "reachable · ") +
                    "checked " + rel(m.lastCheckedAt) +
                    (isStaleCheck(m.lastCheckedAt) ? " · stale, retest" : "")
                  : m.up === false
                    ? "unreachable · checked " + rel(m.lastCheckedAt)
                    : /* P13-UI-16: defensive — every save/test writes `up`, so a
                         null only appears for a row written outside Viberr. */
                      "not health-checked yet"}
                {m.hasCred ? " · auth: configured" : ""}
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
        ))}
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
  usedBy: (slug: string) => number;
  onNew: () => void;
  onBrowse: (s: SkillView) => void;
  onEdit: (s: SkillView) => void;
  onDelete: (s: SkillView) => void;
}) {
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
        {skills.map((s) => (
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
                {s.fileCount === 1 ? "" : "s"} · updated {rel(s.updatedAt)}
                {usedBy(s.name) > 0
                  ? " · " + usedBy(s.name) + " template" + (usedBy(s.name) === 1 ? "" : "s")
                  : ""}
              </span>
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
        ))}
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
                {/* P13-AP-09: the row subtitle is the SHORT blurb. It used to
                    render the markdown body — i.e. the agent's entire persona —
                    so a seeded profile printed a 600-word system prompt here. */}
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
    <div className="rsrc-wrap" data-screen-label="Settings — Agent resources">
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
