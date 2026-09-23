import { FolderIco } from "~/features/kb-browser/icons";
import type { GagentView } from "~/server/org/gagents.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { EditIco } from "./mini-modal";
import { rel, updatedLabel } from "./resource-helpers";
import { isMcpHealthStale } from "~/shared/freshness";
import { looksLikeWriteTool } from "~/shared/mcp-tools";
import { countLabel } from "~/shared/text/plural";

/**
 * The four resource list panels (knowledge bases, MCP servers, skills, global
 * agent profiles) for the Agent-resources tab. Presentational: every mutation
 * is a callback the owning `ResourcesPanel` supplies. Split out of
 * `resources-panel.tsx` (pass 16, pure structural refactor — no behaviour or
 * copy change).
 */

export function KbPanel({
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
          {/* A11Y-2 (pass 32): the tab shows four add buttons whose visible
              text is "New"/"Add"; a screen reader's button list read "New, New,
              New, Add". Each carries its panel in its accessible name. */}
          <button type="button" className="btn sm" onClick={onNew} aria-label="New knowledge base">
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
              {/* P14-KM-13: "N docs" counted EVERY file while injection reads
                  six text extensions, so a KB of PDFs advertised a healthy count
                  and injected nothing. Count what a run reads, and name the rest
                  rather than folding it in. */}
              {/* The two lines read as one sentence split across them —
                  "…docs agents read" / "read live" — which said "read" twice
                  and left the live-folder promise dangling. One clause each. */}
              <span className="sub mono">
                store://kb/{kb.dir}/ ·{" "}
                {kb.folderExists ? (
                  <>
                    {kb.injectableCount} doc
                    {kb.injectableCount === 1 ? "" : "s"} · agents read the live
                    folder
                    {kb.fileCount > kb.injectableCount
                      ? " · " +
                        (kb.fileCount - kb.injectableCount) +
                        " non-text file" +
                        (kb.fileCount - kb.injectableCount === 1 ? "" : "s") +
                        " skipped"
                      : ""}
                  </>
                ) : (
                  // F18-4: the store folder is gone (wiped/renamed under the
                  // row) — a granted agent gets NOTHING, so say so rather than
                  // read like a healthy empty KB. Plain honest text, mirroring
                  // the credUnreadable precedent below.
                  <>
                    folder missing: no docs reach a granted agent; re-create it
                    or delete this knowledge base
                  </>
                )}
              </span>
              <span className="sub">
                {kb.folderExists
                  ? "re-scanned " + rel(kb.lastIndexedAt)
                  : "last scanned " + rel(kb.lastIndexedAt)}
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
                title="Re-scan folder to refresh the doc count"
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
        {kbs.length === 0 && (
          // D8: absent → why it matters → next action (P16), not a bare label.
          <div className="empty">
            No knowledge bases yet. A knowledge base is a folder of docs agents
            read live while they work. Add one with <strong>New</strong> above,
            then grant it to an agent profile.
          </div>
        )}
      </div>
    </section>
  );
}


/**
 * Ruling 220 (F37-40): one sentence about where a server stands on write tools,
 * for every server rather than only the gated ones.
 *
 * The three cases are the controller's three (ruling 188), said to the human:
 * gated, reviewed-and-none, or never reviewed with tools that look like writes.
 * A server whose discovered tools contain nothing write-shaped says nothing —
 * there is no position to state and a row that alarms on everything is a row
 * nobody reads.
 */
function writeToolPosture(m: McpView): string {
  if (m.writeTools.length > 0) {
    const n = m.writeTools.length;
    return ` · ${countLabel(n, "write tool")} withheld from read-only runs`;
  }
  const writeSuspects = (m.discoveredTools ?? []).filter(looksLikeWriteTool);
  if (m.writeToolsReviewed) {
    return writeSuspects.length > 0
      ? ` · reviewed: none of its ${countLabel(writeSuspects.length, "write-looking tool")} is withheld`
      : " · reviewed: no write tools";
  }
  if (writeSuspects.length === 0) return "";
  return ` · ${writeSuspects.length} tool${writeSuspects.length === 1 ? "" : "s"} look${writeSuspects.length === 1 ? "s" : ""} like a write and nothing is withheld: not reviewed`;
}

export function McpPanel({
  mcps,
  usedBy,
  testing,
  onNew,
  onTest,
  onEdit,
  onDelete,
}: {
  mcps: McpView[];
  usedBy: (slug: string) => number;
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
          <button type="button" className="btn sm" onClick={onNew} aria-label="Add MCP server">
            <Icon name="plus" />
            Add
          </button>
        </span>
      </div>
      <div className="rsrc-list">
        {mcps.map((m) => (
          <div className="rsrc-row" key={m.id}>
            {(() => {
              const stale = m.up === true && isMcpHealthStale(m.lastCheckedAt);
              // R19-18: a first-run install is neither up nor broken, and it
              // outranks the stored `up` — that value is the verdict of the
              // probe this install was started BY.
              const warming = m.warmingSince !== null;
              return (
                <span
                  className={
                    "stat-dot" +
                    (warming
                      ? " warming"
                      : stale
                        ? " stale"
                        : m.up === true
                          ? " up"
                          : m.up === false
                            ? " down"
                            : "")
                  }
                  title={
                    warming
                      ? "first run of this command, finishing in the background"
                      : stale
                        ? "last check passed but is stale. Retest to confirm"
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
                {/* R20-4 (N20-2): softer than "installing on first use" because
                    the row also reaches here on the HEURISTIC arm — an inference
                    that an npx/uvx-style command is still fetching, not a
                    reported install. One copy for both bases: the reader can act
                    on neither distinction. */}
                {m.warmingSince !== null
                  ? "first run, installing in the background"
                  : m.up === true
                  ? (m.tools !== null
                      ? // D32-6 (pass 32): "1 tools" — count its noun.
                        `${m.tools} ${m.tools === 1 ? "tool" : "tools"} · `
                      : "reachable · ") +
                    "checked " + rel(m.lastCheckedAt) +
                    (isMcpHealthStale(m.lastCheckedAt) ? " · stale, retest" : "")
                  : m.up === false
                    ? "unreachable · checked " + rel(m.lastCheckedAt)
                    : /* P13-UI-16: defensive — every save/test writes `up`, so a
                         null only appears for a row written outside Viberr. */
                      "not health-checked yet"}
                {/* A9 (F17 hygiene): a stored credential that no longer decrypts
                    (e.g. the encryption key was rotated without the PREVIOUS key)
                    used to still read "auth: configured" while the server mounted
                    anonymously. `credUnreadable` was computed for exactly this and
                    never surfaced — say it plainly so an admin knows to rotate or
                    re-enter it. */}
                {m.hasCred
                  ? m.credUnreadable
                    ? " · auth: unreadable (rotate the encryption key or re-enter the credential)"
                    : // F-P3: the credential is injected only on Claude runs — a
                      // Codex run drops it (it would otherwise leak into the
                      // Codex CLI's --config argv), so every Codex run mounts
                      // this server unauthenticated regardless of which
                      // profile grants it. Say so wherever the row says
                      // "configured" rather than only in the capability-matrix
                      // prose.
                      " · auth: configured (Claude runs only · Codex mounts it unauthenticated)"
                  : ""}
                {/* P14-KM-09: KB and skill rows have counted their templates
                    since P13-KM-08; MCP rows showed nothing, so an admin about
                    to rename or remove a server had no idea what depended on
                    it. Same count, same honest "templates" label. */}
                {usedBy(m.name) > 0
                  ? " · " +
                    usedBy(m.name) +
                    " template" +
                    (usedBy(m.name) === 1 ? "" : "s")
                  : ""}
                {/* Ruling 176: how many of its tools are withheld from agents
                    that may not write, so the row says the server is gated.
                    Ruling 220 (F37-40): and the row says so for the other two
                    cases too. It used to render NOTHING unless a server was
                    gated, so the one state worth seeing — tools that look like
                    writes, nobody has reviewed them, so nothing is withheld —
                    was the one the list was silent about. Live, `kb-architecture`
                    and `kb-conventions` are `server-filesystem` rooted at a
                    knowledge base, 14 tools each, granted to 3 agent templates
                    each, unmarked: those agents can rewrite the knowledge bases
                    injected into every other agent's prompt as configuration.
                    The controller reasoned about exactly that hazard for a THIRD
                    such server and granted nothing; this list gave it and the
                    admin no standing signal at all. The controller's own read
                    has carried all three cases since ruling 188 — this is the
                    human's half of the same sentence. */}
                {writeToolPosture(m)}
              </span>
              {/* R19-17: WHY it is unreachable, in the command's own words.
                  The reason used to exist only in the toast the probe returned,
                  so the moment it faded a red dot was the entire story and the
                  only way to see the cause again was to re-run the test. It is
                  scrubbed of the credential the child was spawned with before
                  it is ever stored (`discoverStdioMcpTools`). */}
              {m.up === false && m.lastError && m.warmingSince === null && (
                <span className="rsrc-err mono">{m.lastError}</span>
              )}
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
        {mcps.length === 0 && (
          // D8: absent → why it matters → next action (P16).
          <div className="empty">
            No MCP servers yet. An MCP server exposes external tools an agent can
            call during a run. Add one with <strong>Add</strong> above, then
            grant it to an agent profile.
          </div>
        )}
      </div>
    </section>
  );
}

export function SkillPanel({
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
          <button type="button" className="btn sm" onClick={onNew} aria-label="New skill">
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
              {/* Long summaries clamp to three lines to keep the list scannable;
                  the full text stays in the DOM (screen readers read it all) and
                  on hover via title. The editor shows it in full. */}
              <span className="sub clamp" title={s.summary}>
                {s.summary}
              </span>
              <span className="sub mono">
                store://skills/{s.name}/ · {s.fileCount} file
                {s.fileCount === 1 ? "" : "s"} · {updatedLabel(s.updatedAt)}
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
        {skills.length === 0 && (
          // D8: absent → why it matters → next action (P16).
          <div className="empty">
            No skills yet. A skill packages instructions an agent loads on demand
            while it works. Add one with <strong>New</strong> above, then grant
            it to an agent profile.
          </div>
        )}
      </div>
    </section>
  );
}

export function AgentPanel({
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
          <button type="button" className="btn sm" onClick={onNew} aria-label="New global agent profile">
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
              <AgentGlyph backend={a.backend} decorative />
              <span className="rsrc-main">
                <b>{a.name}</b>
                {/* P13-AP-09: the row subtitle is the SHORT blurb. It used to
                    render the markdown body — i.e. the agent's entire persona —
                    so a seeded profile printed a 600-word system prompt here.
                    Even the blurb runs long on seeded profiles, so it clamps to
                    three lines (full text in the DOM + title; editor has it
                    whole). */}
                <span className="sub clamp" title={a.summary}>
                  {a.summary}
                </span>
                <span className="sub mono">
                  {a.backend === "claude" ? "Claude" : "Codex"} ·{" "}
                  {/* P14-WL-06: the row right below already pluralizes
                      ("project"/"projects"); this one always said "resources". */}
                  {stageNames || "no stages"} · {res} context resource
                  {res === 1 ? "" : "s"} ·{" "}
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
        {gagents.length === 0 && (
          // D8: absent → why it matters → next action (P16).
          <div className="empty">
            {/* D4 (pass 23): this listed "model" among the fields, but the org
                editor has no model picker — the model (and effort) are chosen
                per project when the profile is deployed. */}
            No global agent profiles yet. A profile is a reusable agent
            definition (its backend, skills and grants) that you can deploy into
            any project, picking its model when you do. Create one with{" "}
            <strong>New</strong> above.
          </div>
        )}
      </div>
    </section>
  );
}
