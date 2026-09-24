import { useState } from "react";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { slugify } from "~/shared/ids/slugify";
import { mcpSignInPhrase } from "~/shared/mcp-oauth";
import { looksLikeWriteTool, MCP_TOOL_NAME_RE } from "~/shared/mcp-tools";
import { Icon } from "~/ui/icon";
import { RadioSeg, RadioSegOption } from "~/ui/radio-seg";
import { MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";
import { useOrgAction } from "./use-org-action";

/**
 * The knowledge-base / MCP-server / skill editors for the Agent-resources tab.
 * Split out of `resources-panel.tsx` (pass 16, pure structural refactor —
 * no behaviour or copy change). The agent-template editor is the odd one out
 * and lives in `agent-template-modal.tsx`.
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
      footHint={"store://kb/" + (slugify(name) || "name") + "/"}
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

/** "needs sign-in" → "Needs sign-in". */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Ruling 469: the editor's OAuth sign-in, beside the pasted credential. "Sign
 * in" asks the server to discover the server's authorization server, register
 * Viberr there and hand back the authorization URL; the admin opens it in a
 * new tab (a link, so no popup blocker stands in the way) and approves Viberr
 * on the server's own page. The callback tab seals the tokens and says it can
 * be closed; this page revalidates on the resource event it publishes, so the
 * status line below turns to "signed in" by itself. "Sign out" revokes the
 * tokens at the server when it offers revocation and drops them here.
 */
function McpSignIn({ mcp }: { mcp: McpView }) {
  const oauth = mcp.oauth ?? null;
  const [err, setErr] = useState<string | null>(null);
  // The authorization URL, and the sign-in state it was fetched against: once
  // that state moves (the callback landed, or the admin signed out), the link
  // has done its job and goes away.
  const [pendingLink, setPendingLink] = useState<{
    url: string;
    issuer: string | null;
    from: string;
  } | null>(null);
  const stateKey = `${oauth?.status ?? "none"}|${oauth?.expiresAt ?? ""}`;
  const start = useOrgAction({
    onResult: (d) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.authorizeUrl) setPendingLink({ url: d.authorizeUrl, issuer: d.issuer ?? null, from: stateKey });
    },
  });
  const signOut = useOrgAction();
  const link = pendingLink && pendingLink.from === stateKey ? pendingLink : null;
  const signedIn = oauth?.status === "signed_in";
  const phrase = mcpSignInPhrase(oauth);
  const status = phrase
    ? sentenceCase(phrase) + (signedIn && oauth?.issuer ? ` · ${oauth.issuer}` : "")
    : "Not signed in. Use this when the server asks for an OAuth sign-in instead of a token.";
  const busy = start.busy || signOut.busy;
  return (
    <div className="field">
      <span className="flabel" id="mcp-oauth-label">
        OAuth sign-in <span className="fhint">for a server that asks for one</span>
      </span>
      <span className="fhint" role="status">
        {status}
      </span>
      {oauth?.status === "expired" && oauth.reason && <span className="fhint mono">{oauth.reason}</span>}
      <span className="cred-manage" role="group" aria-labelledby="mcp-oauth-label">
        <button
          type="button"
          className={"btn sm" + (signedIn ? " ghost" : "")}
          disabled={busy}
          aria-busy={start.busy || undefined}
          onClick={() => {
            setErr(null);
            start.submit({ intent: "mcp-oauth-start", mcpId: mcp.id });
          }}
        >
          <Icon name={start.busy ? "loader" : "user"} />
          {start.busy ? "Starting sign-in…" : oauth?.status === "needs_sign_in" || !oauth ? "Sign in" : "Sign in again"}
        </button>
        {(signedIn || oauth?.status === "expired") && (
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            aria-busy={signOut.busy || undefined}
            onClick={() => {
              setErr(null);
              signOut.submit({ intent: "mcp-oauth-sign-out", mcpId: mcp.id });
            }}
          >
            <Icon name={signOut.busy ? "loader" : "x"} />
            {signOut.busy ? "Signing out…" : "Sign out"}
          </button>
        )}
        {link && (
          <a className="btn sm" href={link.url} target="_blank" rel="noopener noreferrer">
            <Icon name="ext" />
            {link.issuer ? `Continue at ${link.issuer}` : "Continue to the sign-in page"}
          </a>
        )}
      </span>
      {link && (
        <span className="fhint">
          Approve Viberr there. That tab says when it is done, and this editor updates by itself.
        </span>
      )}
      {err && (
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
      <div className="def-note">
        <Icon name="lock" />
        <span>
          Viberr registers itself with the server, you approve it on the server&apos;s own
          sign-in page, and Viberr keeps the tokens sealed and renews them. Agent runs reach
          the server through Viberr&apos;s MCP gateway and never see a token.
        </span>
      </div>
    </div>
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
  // Ruling 469: read live from the row, which the panel keeps current.
  const signedIn = initial?.oauth?.status === "signed_in";
  // Ruling 176: the write-tool marks. The editor proposes and the admin
  // decides: a server nobody has reviewed opens with the discovery suggestion
  // selected; a reviewed one opens with exactly what was saved.
  const discovered = initial?.discoveredTools ?? [];
  const reviewed = initial?.writeToolsReviewed ?? false;
  const [marked, setMarked] = useState<string[]>(() =>
    reviewed ? (initial?.writeTools ?? []) : discovered.filter(looksLikeWriteTool),
  );
  const [typed, setTyped] = useState<string[]>([]);
  const [draftTool, setDraftTool] = useState("");
  const toolChoices = [
    ...new Set([...discovered, ...(initial?.writeTools ?? []), ...typed]),
  ];
  const suggested = !reviewed && marked.length > 0;
  const draftValid = MCP_TOOL_NAME_RE.test(draftTool.trim());
  const addDraftTool = () => {
    const tool = draftTool.trim();
    if (!MCP_TOOL_NAME_RE.test(tool)) return;
    if (!toolChoices.includes(tool)) setTyped((list) => [...list, tool]);
    if (!marked.includes(tool)) setMarked((list) => [...list, tool]);
    setDraftTool("");
  };
  // Ruling 459: a save plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);
  const { action, err, setErr } = useModalAction(() => setDone(true));
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
      saveLabel={
        action.busy
          ? "Testing connection…"
          : initial
            ? "Save & re-test"
            : "Add & test connection"
      }
      footHint={
        transport === "stdio"
          ? "spawned per run, with the server's own privileges"
          : "a real MCP handshake runs on save & test"
      }
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
        if (reviewed || toolChoices.length > 0) fields.writeTools = JSON.stringify(marked);
        action.submit(fields);
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
            autoComplete="off"
            spellCheck={false}
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
        {/* Owner report 2026-08-20: browsers read this text-input + the password
            input below as a LOGIN form and filled a saved email/password pair
            into an MCP endpoint. `autoComplete="off"` alone is ignored on
            login-shaped pairs; the password side opting into `new-password`
            (below) is what breaks the pair heuristic, and the manager opt-outs
            cover the extensions that scrape anyway. */}
        <input
          id="mcp-target"
          type="text"
          className="mono"
          value={target}
          placeholder={
            transport === "stdio" ? "npx -y @mcp/server-postgres" : "https://mcp.internal:7801/sse"
          }
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          onChange={(e) => {
            setTarget(e.target.value);
            setErr(null);
          }}
        />
      </div>
      {initial?.oauth && (transport !== initial.transport || target.trim() !== initial.target) && (
        <span className="fhint">
          Saving this drops the server&apos;s OAuth sign-in: its tokens were issued for the old
          endpoint. Sign in again afterwards.
        </span>
      )}
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
      {signedIn && transport === "HTTP" && target.trim() === initial?.target ? (
        // Ruling 469: a connection holds one credential, and a live sign-in is
        // it. The server refuses a pasted token over it; the field says why.
        <div className="field">
          <span className="flabel">Credential</span>
          <span className="fhint">
            Signed in with OAuth, so no pasted credential is used. Sign out below to paste one
            instead.
          </span>
        </div>
      ) : (
      <div className="field">
        <label className="flabel" htmlFor="mcp-cred">
          Credential{" "}
          <span className="fhint">
            optional · token / API key
            {initial?.hasCred ? " · a credential is set (leave blank to keep it)" : ""}
          </span>
        </label>
        <input
          id="mcp-cred"
          type="password"
          className="mono"
          value={cred}
          disabled={clearCred}
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
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
            Encrypted at rest and held by Viberr: runs on either backend reach the server
            through Viberr&apos;s MCP gateway, which sends it as the Authorization header (or
            starts a stdio command with it in MCP_CREDENTIAL). No agent sees it. Never shown
            again, and never in task timelines, comments, or audit records.
          </span>
        </div>
      </div>
      )}
      {initial && initial.transport === "HTTP" && transport === "HTTP" && <McpSignIn mcp={initial} />}
      <div className="field">
        <span className="flabel" id="mcp-write-tools-label">
          Write tools{" "}
          <span className="fhint">
            removed from agents that may not write to the repo, and from every operator
          </span>
        </span>
        {toolChoices.length > 0 ? (
          <div className="pick-chips" role="group" aria-labelledby="mcp-write-tools-label">
            {toolChoices.map((tool) => (
              <button
                type="button"
                key={tool}
                className={"pick-chip mono" + (marked.includes(tool) ? " on" : "")}
                aria-pressed={marked.includes(tool)}
                onClick={() =>
                  setMarked((list) =>
                    list.includes(tool) ? list.filter((t) => t !== tool) : [...list, tool],
                  )
                }
              >
                {tool}
              </button>
            ))}
          </div>
        ) : (
          <span className="ctx-none">
            {initial
              ? "No tool names discovered yet. Re-test the server, or add a name below."
              : "Its tools are listed here once the connection test answers. You can also add a name below."}
          </span>
        )}
        {suggested && (
          <span className="fhint">
            Selected because their names hold create, delete, merge, push, update, write or
            remove. Review them before you save.
          </span>
        )}
        <div className="tool-add">
          <input
            type="text"
            className="mono"
            aria-label="Add a write tool by name"
            placeholder="tool_name"
            value={draftTool}
            aria-invalid={draftTool.trim() !== "" && !draftValid}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setDraftTool(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraftTool();
              }
            }}
          />
          <button
            type="button"
            className="btn sm ghost"
            disabled={!draftValid}
            onClick={addDraftTool}
          >
            Add tool
          </button>
        </div>
        <div className="def-note">
          <Icon name="lock" />
          <span>
            A selected tool is removed from every run whose agent withholds{" "}
            <strong>Execute code or write to the repo</strong>, and from every operator
            run, on Claude and Codex. Viberr makes no claim about the tools you leave
            unselected.
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
      footHint={"store://skills/" + (slugify(name) || "name") + "/"}
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
      {!initial && (
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
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}
