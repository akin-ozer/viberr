import { useState } from "react";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { slugify } from "~/shared/ids/slugify";
import { Icon } from "~/ui/icon";
import { RadioSeg, RadioSegOption } from "~/ui/radio-seg";
import {
  McpCredentialField,
  McpGrantsAtStake,
  McpNameTransport,
  McpScopesField,
  McpTargetField,
  McpWriteToolsField,
} from "./mcp-modal-fields";
import { McpSignIn } from "./mcp-sign-in";
import { MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";
import { useMcpWriteTools } from "./resource-modals-draft";
import {
  credentialError,
  credentialReplaced,
  mcpDraftOf,
  mcpFootHint,
  mcpSaveLabel,
  repointDropsSignIn,
  signInServer,
} from "./resource-modals-derive";

/**
 * The knowledge-base / MCP-server / skill editors for the Agent-resources tab.
 * Split out of `resources-panel.tsx` (pass 16, pure structural refactor —
 * no behaviour or copy change). The agent-template editor is the odd one out
 * and lives in `agent-template-modal.tsx`. Ruling 695(e) split the MCP editor
 * along the task-page recipe: its write-tool draft lives in
 * `resource-modals-draft.ts` (a hook), what it reads off the row in
 * `resource-modals-derive.ts`, its fields in `mcp-modal-fields.tsx` and its
 * OAuth sign-in in `mcp-sign-in.tsx`.
 */

export function KBModal({
  initial,
  onClose,
  onFilesCreated,
}: {
  initial: KbView | null;
  onClose: () => void;
  /** Files-mode create landed — the parent opens the store browser on the new
   *  KB folder so upload / GitHub import / New document are one click away
   *  (owner request 2026-08-20: the same door the skill modal has). */
  onFilesCreated: (dir: string) => void;
}) {
  const [name, setName] = useState(initial ? initial.name : "");
  const [refresh, setRefresh] = useState(initial ? initial.refresh : "on change");
  // Mirrors SkillModal's two entry points: create the empty folder, or create
  // it and land in its file browser to add the starting docs. Server-side the
  // create is identical — the mode only changes where the human ends up.
  const [mode, setMode] = useState<"empty" | "files">("empty");
  const filesMode = !initial && mode === "files";
  // Ruling 459: a save plays the modal's exit (`done`). The files-mode hand-off
  // stays instant on purpose: it opens the store browser's own dialog, and a
  // modal still fading under it would restore the page's scroll on unmount.
  const [done, setDone] = useState(false);
  const { action, err, setErr } = useModalAction(() => {
    if (filesMode) {
      onClose();
      onFilesCreated(slugify(name));
    } else setDone(true);
  });
  const canSave = name.trim().length > 1;
  return (
    <MiniModal
      icon={<Icon name="memory" />}
      title={initial ? "Edit knowledge base" : "New knowledge base"}
      busy={action.busy}
      done={done}
      sub="A folder in the store. Drop docs in, or let agents append"
      onClose={onClose}
      canSave={canSave}
      saveLabel={
        initial
          ? "Save changes"
          : filesMode
            ? "Create & add files"
            : "Create & index"
      }
      footHint={<code className="mono">{"store://kb/" + (slugify(name) || "name") + "/"}</code>}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        const fields: Record<string, string> = {};
        fields.intent = "kb-save";
        if (initial) fields.kbId = initial.id;
        fields.name = name.trim();
        fields.refresh = refresh;
        action.submit(fields);
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
      {!initial && (
        <div className="field">
          <span className="flabel">Content</span>
          {/* Ruling 458(f), UI-58: a `role="radiogroup"` of plain buttons
              promises arrow keys it never wires and makes each radio its own
              tab stop. `RadioSeg` carries the same roles with the roving keys
              (one tab stop, ←/→, Home/End), and a choice commits on
              activation, not on focus — see its note. */}
          <RadioSeg
            className="mode-radios"
            label="How the knowledge base gets its content"
            value={mode}
            onChange={(next) => setMode(next === "files" ? "files" : "empty")}
          >
            <RadioSegOption
              value="empty"
              className={"btn sm" + (mode === "empty" ? "" : " ghost")}
            >
              <Icon name="memory" />
              Empty for now
            </RadioSegOption>
            <RadioSegOption
              value="files"
              className={"btn sm" + (mode === "files" ? "" : " ghost")}
            >
              <Icon name="folder" />
              Start from files
            </RadioSegOption>
          </RadioSeg>
          {filesMode && (
            <div className="def-note">
              <Icon name="file" />
              <span>
                Creates the folder and opens its file browser. Upload files or
                a folder, import from GitHub, or write documents there. Agents
                read the live folder from the first run.
              </span>
            </div>
          )}
        </div>
      )}
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
            Content is plain files inside the folder, inspectable and editable outside
            Viberr. This setting controls the <strong>doc count and freshness stamp</strong>{" "}
            only: <strong>on change</strong> re-scans automatically whenever a file in the
            folder changes, <strong>manual</strong> only when you click re-scan. It does not
            pin what an agent reads. Every run loads the live folder either way.
          </span>
        </div>
      </div>
      {err && (
        <div className="form-err">
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
  const opened = mcpDraftOf(initial);
  const [name, setName] = useState(opened.name);
  const [transport, setTransport] = useState<"HTTP" | "stdio">(opened.transport);
  const [target, setTarget] = useState(opened.target);
  // The stored credential is sealed and never round-tripped to the client
  // (F7-MCP1); the edit field always starts empty. Blank on save keeps the
  // existing sealed value; a non-empty value replaces it.
  const [cred, setCred] = useState("");
  // P13-KM-06: blank means "keep the stored secret", so removing one needs an
  // explicit intent — without it a repointed server kept sending the old token.
  const [clearCred, setClearCred] = useState(false);
  // Ruling 486(c): what the next OAuth sign-in asks for, as stored.
  const [scopes, setScopes] = useState(opened.scopes);
  const tools = useMcpWriteTools(initial);
  // Ruling 459: a save plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);
  const { action, err, errField, setErr } = useModalAction(() => setDone(true));
  // Ruling 514: a refusal about the credential (too short, or pasted over a
  // live sign-in this editor had not seen yet) is said at that field.
  const credErr = credentialError(err, errField);
  // Ruling 469(e): while signed in, the credential field gives way to a
  // sentence, and (ruling 514) what it held goes with it. A draft typed, or
  // filled in by the browser, before the sign-in landed used to ride the next
  // save unseen, where the server refused it as a pasted credential over the
  // live sign-in. Dropped while rendering, so no save sends it and a sign-out
  // brings the field back empty. Ruling 469: the sign-in is read live from the
  // row, which the panel keeps current.
  const credReplaced = credentialReplaced(initial, transport, target);
  if (credReplaced && (cred !== "" || clearCred || credErr !== null)) {
    setCred("");
    setClearCred(false);
    if (credErr !== null) setErr(null);
  }
  const signInRow = signInServer(initial, transport);
  const canSave = slugify(name).length > 1 && target.trim().length > 3;
  return (
    <MiniModal
      icon={<Icon name="cpu" />}
      title={initial ? "Edit MCP server" : "Add MCP server"}
      busy={action.busy}
      done={done}
      sub="Tools become loadable context for agent profiles"
      onClose={onClose}
      canSave={canSave}
      saveLabel={mcpSaveLabel(action.busy, !!initial)}
      footHint={mcpFootHint(transport)}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        const fields: Record<string, string> = {};
        fields.intent = "mcp-save";
        if (initial) fields.mcpId = initial.id;
        fields.name = slugify(name);
        fields.transport = transport;
        fields.target = target.trim();
        fields.cred = cred.trim();
        if (clearCred) fields.clearCred = "1";
        // Sent once the admin has seen a list (or had one saved): an add with
        // nothing to show yet stays unreviewed, so the names its first probe
        // discovers still arrive as a suggestion.
        if (tools.reviewed || tools.toolChoices.length > 0)
          fields.writeTools = JSON.stringify(tools.marked);
        // Ruling 486(c): only an HTTP server signs in, so only it asks for scopes.
        if (transport === "HTTP") fields.requestedScopes = scopes.trim();
        action.submit(fields);
      }}
    >
      <McpNameTransport
        name={name}
        setName={setName}
        transport={transport}
        setTransport={setTransport}
        setErr={setErr}
      />
      <McpTargetField transport={transport} target={target} setTarget={setTarget} setErr={setErr} />
      {repointDropsSignIn(initial, transport, target) && (
        <span className="fhint">
          Saving this drops the server&apos;s OAuth sign-in: its tokens were issued for the old
          endpoint. Sign in again afterwards.
        </span>
      )}
      <McpGrantsAtStake initial={initial} usedBy={usedBy} />
      <McpCredentialField
        replaced={credReplaced}
        hasCred={initial?.hasCred}
        cred={cred}
        setCred={setCred}
        clearCred={clearCred}
        setClearCred={setClearCred}
        credErr={credErr}
        setErr={setErr}
      />
      {transport === "HTTP" && <McpScopesField scopes={scopes} setScopes={setScopes} setErr={setErr} />}
      {signInRow && <McpSignIn mcp={signInRow} />}
      <McpWriteToolsField editing={!!initial} tools={tools} />
      {err && credErr === null && (
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

/** How a new skill gets its content (owner request 2026-07-25): written here,
 *  or from files added through the store browser. */
function SkillContentField({
  mode,
  setMode,
  filesMode,
}: {
  mode: "write" | "files";
  setMode: (mode: "write" | "files") => void;
  filesMode: boolean;
}) {
  return (
    <div className="field">
      <span className="flabel">Content</span>
      {/* Ruling 458(f): on `RadioSeg` for the same reason as KBModal's. */}
      <RadioSeg
        className="mode-radios"
        label="How the skill gets its content"
        value={mode}
        onChange={(next) => setMode(next === "files" ? "files" : "write")}
      >
        <RadioSegOption
          value="write"
          className={"btn sm" + (mode === "write" ? "" : " ghost")}
        >
          <Icon name="edit" />
          Write SKILL.md
        </RadioSegOption>
        <RadioSegOption
          value="files"
          className={"btn sm" + (mode === "files" ? "" : " ghost")}
        >
          <Icon name="folder" />
          Start from files
        </RadioSegOption>
      </RadioSeg>
      {filesMode && (
        <div className="def-note">
          <Icon name="shield" />
          <span>
            Creates the empty skill folder and opens its file browser.
            Upload files or a folder, import from GitHub, or write
            documents there. The summary comes from your SKILL.md&apos;s
            frontmatter <span className="mono">description:</span> once it
            lands (or add one via Edit).
          </span>
        </div>
      )}
    </div>
  );
}

/** A written skill's summary and SKILL.md. */
function SkillWriteFields({
  summary,
  setSummary,
  body,
  setBody,
  setErr,
}: {
  summary: string;
  setSummary: (summary: string) => void;
  body: string;
  setBody: (body: string) => void;
  setErr: (err: string | null) => void;
}) {
  return (
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
  // Ruling 459: as the knowledge-base modal, a save plays the exit and the
  // files-mode hand-off to the store browser stays instant.
  const [done, setDone] = useState(false);
  const { action, err, setErr } = useModalAction(() => {
    if (filesMode) {
      onClose();
      onFilesCreated(slugify(name));
    } else setDone(true);
  });
  const canSave =
    slugify(name).length > 1 && (filesMode || summary.trim().length > 3);
  return (
    <MiniModal
      icon={<Icon name="bolt" />}
      title={initial ? "Edit skill" : "New skill"}
      busy={action.busy}
      done={done}
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
      footHint={<code className="mono">{"store://skills/" + (slugify(name) || "name") + "/"}</code>}
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        const fields: Record<string, string> = {};
        fields.intent = "skill-save";
        if (initial) fields.skillId = initial.id;
        fields.name = slugify(name);
        fields.summary = filesMode ? "" : summary.trim();
        fields.body = filesMode ? "" : body;
        fields.contentMode = filesMode ? "files" : "write";
        // P13-KM-18: an empty body means "keep what's on disk" (the editor
        // only round-trips a truncated read for very large files). Ruling 183
        // retired the `clearBody` escape hatch that let this form blank a
        // SKILL.md: an empty SKILL.md is not a skill and the writer refuses an
        // empty body, so emptying the editor keeps the file.
        action.submit(fields);
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
      {!initial && <SkillContentField mode={mode} setMode={setMode} filesMode={filesMode} />}
      {!filesMode && (
        <SkillWriteFields
          summary={summary}
          setSummary={setSummary}
          body={body}
          setBody={setBody}
          setErr={setErr}
        />
      )}
      {err && (
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}
