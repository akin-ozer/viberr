import type { McpView } from "~/server/org/resources.server";
import { slugify } from "~/shared/ids/slugify";
import { Icon } from "~/ui/icon";
import type { McpWriteTools } from "./resource-modals-draft";

/**
 * The MCP-server editor's fields (ruling 695(e), the split of
 * `resource-modals.tsx`): name and transport, the command or endpoint, the
 * grants a rename rewrites, the credential, the requested scopes and the
 * write tools. Each takes the slot its markup held in McpModal and calls no
 * hook, so the editor's markup, and every id React derives from its place in
 * the tree, are what they were. McpModal owns the draft and hands it in.
 */

type SetText = (value: string) => void;
type SetErr = (err: string | null) => void;

/** The server's name, with the slug it is saved as, and its transport. */
export function McpNameTransport({
  name,
  setName,
  transport,
  setTransport,
  setErr,
}: {
  name: string;
  setName: SetText;
  transport: "HTTP" | "stdio";
  setTransport: (transport: "HTTP" | "stdio") => void;
  setErr: SetErr;
}) {
  return (
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
  );
}

/** The command a stdio server starts with, or an HTTP server's endpoint. */
export function McpTargetField({
  transport,
  target,
  setTarget,
  setErr,
}: {
  transport: "HTTP" | "stdio";
  target: string;
  setTarget: SetText;
  setErr: SetErr;
}) {
  return (
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
  );
}

/**
 * P14-KM-09/KM-01: renaming a server rewrites every grant that names it (KB
 * and skill renames always did; the MCP leg didn't, which orphaned them
 * silently). Say how many grants are at stake before the rename; a new
 * server, or one no template grants, says nothing.
 */
export function McpGrantsAtStake({
  initial,
  usedBy,
}: {
  initial: McpView | null;
  /** Global templates granting this server (P14-KM-09). */
  usedBy: number;
}) {
  return initial && usedBy > 0 ? (
    <div className="def-note">
      <Icon name="agents" />
      <span>
        {usedBy} agent template{usedBy === 1 ? "" : "s"} grant{usedBy === 1 ? "s" : ""}{" "}
        <strong>{initial.name}</strong>. Renaming it rewrites their grants;
        projects that already deployed those templates are rewritten too.
      </span>
    </div>
  ) : null;
}

/** The pasted credential, or, while a live sign-in holds the connection's one
 *  credential (ruling 469), the sentence that stands in for it. */
export function McpCredentialField({
  replaced,
  hasCred,
  cred,
  setCred,
  clearCred,
  setClearCred,
  credErr,
  setErr,
}: {
  replaced: boolean;
  /** A credential is stored for the server being edited. */
  hasCred: boolean | undefined;
  cred: string;
  setCred: SetText;
  clearCred: boolean;
  setClearCred: (update: (v: boolean) => boolean) => void;
  credErr: string | null;
  setErr: SetErr;
}) {
  if (replaced) {
    // Ruling 469: a connection holds one credential, and a live sign-in is
    // it. The server refuses a pasted token over it; the field says why.
    return (
      <div className="field">
        <span className="flabel">Credential</span>
        <span className="fhint">
          Signed in with OAuth, so no pasted credential is used. Sign out below to paste one
          instead.
        </span>
      </div>
    );
  }
  return (
    <div className="field">
      <label className="flabel" htmlFor="mcp-cred">
        Credential{" "}
        <span className="fhint">
          optional · token / API key
          {hasCred ? " · a credential is set (leave blank to keep it)" : ""}
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
            : hasCred
              ? "•••••••• (unchanged)"
              : "paste a token or API key"
        }
        aria-invalid={credErr !== null || undefined}
        aria-describedby={credErr !== null ? "mcp-cred-err" : undefined}
        onChange={(e) => {
          setCred(e.target.value);
          setErr(null);
        }}
      />
      {credErr !== null && (
        <div className="form-err" id="mcp-cred-err" role="alert">
          <Icon name="alert" />
          {credErr}
        </div>
      )}
      {hasCred && (
        <button
          type="button"
          className="btn sm ghost self-start"
          onClick={() => {
            setClearCred((v) => !v);
            setCred("");
            setErr(null);
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
  );
}

/** Ruling 486(c): what the next OAuth sign-in asks for. Only an HTTP server
 *  signs in, so McpModal shows this for one alone. */
export function McpScopesField({
  scopes,
  setScopes,
  setErr,
}: {
  scopes: string;
  setScopes: SetText;
  setErr: SetErr;
}) {
  return (
    <div className="field">
      <label className="flabel" htmlFor="mcp-scopes">
        Requested scopes <span className="fhint">optional · for an OAuth sign-in</span>
      </label>
      <textarea
        id="mcp-scopes"
        className="mono"
        rows={2}
        value={scopes}
        placeholder="e.g. workers-scripts.write workers-ci.write zone.read"
        autoComplete="off"
        spellCheck={false}
        aria-describedby="mcp-scopes-hint"
        onChange={(e) => {
          setScopes(e.target.value);
          setErr(null);
        }}
      />
      <span className="fhint" id="mcp-scopes-hint">
        Sent as the sign-in&apos;s scope, separated by spaces; blank asks for what the server
        advertises. The server&apos;s own sign-in page decides what it grants, so this editor
        shows what it granted. A change applies at the next sign-in.
      </span>
    </div>
  );
}

/** Ruling 176: the write tools, offered from discovery, the saved list and the
 *  names typed in, with the field that adds a name. */
export function McpWriteToolsField({
  editing,
  tools,
}: {
  editing: boolean;
  tools: McpWriteTools;
}) {
  const { marked, setMarked, toolChoices, suggested, draftTool, setDraftTool, draftValid, addDraftTool } =
    tools;
  return (
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
          {editing
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
          <strong>Write to the repository</strong>, and from every operator
          run, on Claude and Codex. Viberr makes no claim about the tools you leave
          unselected.
        </span>
      </div>
    </div>
  );
}
