import { useState } from "react";
import { FolderIco } from "~/features/kb-browser/icons";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { slugify } from "~/shared/ids/slugify";
import { Icon } from "~/ui/icon";
import { EditIco, MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";

/**
 * The knowledge-base / MCP-server / skill editors for the Agent-resources tab.
 * Split out of `resources-panel.tsx` (pass 16, pure structural refactor —
 * no behaviour or copy change). The agent-template editor is the odd one out
 * and lives in `agent-template-modal.tsx`.
 */

export function KBModal({ initial, onClose }: { initial: KbView | null; onClose: () => void }) {
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
        <span className="mini-seg self-start" role="group" aria-label="Re-index">
          {(["on change", "manual"] as const).map((r) => (
            <button type="button" key={r} className={refresh === r ? "on" : ""} aria-pressed={refresh === r} onClick={() => setRefresh(r)}>
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

export function McpModal({
  initial,
  usedBy,
  onClose,
}: {
  initial: McpView | null;
  /** Global templates granting this server (P14-KM-09). */
  usedBy: number;
  onClose: () => void;
}) {
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
          {/* N20-5: the name is slugified before saving (`_`→`-`, spaces
              collapsed), so typing `viberr_browser` or "My Server" silently
              becomes `viberr-browser` / `my-server` — and a reserved-name
              refusal then quoted a name the admin never typed. Show the slug
              the moment it differs, so the rewrite is never a surprise. */}
          {slugify(name) && slugify(name) !== name.trim() && (
            <span className="fhint mono">
              will be saved as <b className="mono-b">{slugify(name)}</b>
            </span>
          )}
        </div>
        <div className="field">
          <span className="flabel">Transport</span>
          <span className="mini-seg self-start" role="group" aria-label="Transport">
            <button type="button" className={transport === "HTTP" ? "on" : ""} aria-pressed={transport === "HTTP"} onClick={() => setTransport("HTTP")}>
              HTTP
            </button>
            <button type="button" className={transport === "stdio" ? "on" : ""} aria-pressed={transport === "stdio"} onClick={() => setTransport("stdio")}>
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
      {/* P14-KM-09/KM-01: renaming a server rewrites every grant that names it
          (KB and skill renames always did; the MCP leg didn't, which orphaned
          them silently). Say how many grants are at stake before the rename. */}
      {initial && usedBy > 0 && (
        <div className="def-note">
          <Icon name="agents" />
          <span>
            {usedBy} agent template{usedBy === 1 ? "" : "s"} grant{usedBy === 1 ? "s" : ""}{" "}
            <strong>{initial.name}</strong>. Renaming it rewrites their grants;
            projects that already deployed those templates are rewritten too.
          </span>
        </div>
      )}
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
            className="btn sm ghost self-start"
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

export function SkillModal({
  initial,
  onClose,
  onFilesCreated,
}: {
  initial: SkillView | null;
  onClose: () => void;
  /** Files-mode create landed — the parent opens the store browser on the new
   *  skill folder so upload / GitHub import / New document are one click away. */
  onFilesCreated: (name: string) => void;
}) {
  const [name, setName] = useState(initial ? initial.name : "");
  const [summary, setSummary] = useState(initial ? initial.summary : "");
  const [body, setBody] = useState(initial ? initial.body : "");
  // One entry point, two ways to give the skill content (owner request
  // 2026-07-25): write SKILL.md right here, or create the folder and add
  // content through the store browser (upload files/folder, Add from GitHub,
  // New document). Edit mode keeps the classic editor only.
  const [mode, setMode] = useState<"write" | "files">("write");
  const filesMode = !initial && mode === "files";
  const { action, err, setErr } = useModalAction(() => {
    onClose();
    if (filesMode) onFilesCreated(slugify(name));
  });
  const canSave =
    !action.busy &&
    slugify(name).length > 1 &&
    (filesMode || summary.trim().length > 3);
  return (
    <MiniModal
      icon={<Icon name="bolt" />}
      title={initial ? "Edit skill" : "New skill"}
      sub="Reusable instructions an agent loads on demand"
      onClose={onClose}
      canSave={canSave}
      saveLabel={
        initial
          ? "Save changes"
          : filesMode
            ? "Create & add files"
            : "Create skill"
      }
      footHint={"store://skills/" + (slugify(name) || "name") + "/"}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        action.submit({
          intent: "skill-save",
          ...(initial ? { skillId: initial.id } : {}),
          name: slugify(name),
          summary: filesMode ? "" : summary.trim(),
          body: filesMode ? "" : body,
          contentMode: filesMode ? "files" : "write",
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
      {!initial && (
        <div className="field">
          <span className="flabel">Content</span>
          <div
            role="radiogroup"
            aria-label="How the skill gets its content"
            className="mode-radios"
          >
            <button
              type="button"
              role="radio"
              aria-checked={mode === "write"}
              className={"btn sm" + (mode === "write" ? "" : " ghost")}
              onClick={() => setMode("write")}
            >
              <EditIco />
              Write SKILL.md
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "files"}
              className={"btn sm" + (mode === "files" ? "" : " ghost")}
              onClick={() => setMode("files")}
            >
              <FolderIco />
              Start from files
            </button>
          </div>
          {filesMode && (
            <div className="def-note">
              <Icon name="shield" />
              <span>
                Creates the empty skill folder and opens its file browser —
                upload files or a folder, import from GitHub, or write
                documents there. The summary comes from your SKILL.md&apos;s
                frontmatter <span className="mono">description:</span> once it
                lands (or add one via Edit).
              </span>
            </div>
          )}
        </div>
      )}
      {!filesMode && (
        <>
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
        </>
      )}
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}
